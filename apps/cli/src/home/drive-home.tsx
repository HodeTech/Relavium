import { randomUUID } from 'node:crypto';

import { createProviderStore, createRunHistoryReader } from '@relavium/db';
import type { AgentSessionRecord, ReasoningEffort } from '@relavium/shared';
import { render } from 'ink';
import { createElement } from 'react';

import { createChatLineHandler, type ReseatTarget } from '../commands/chat.js';
import {
  buildChatSession,
  buildResumedChatSession,
  swapAgentModel,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { assembleDoctorProbes } from '../chat/doctor-host.js';
import type { DoctorProbes } from '../chat/doctor.js';
import {
  createSessionPersister,
  makeCatalogIdResolver,
  type SessionPersister,
} from '../chat/persister.js';
import { loadResolvedConfig } from '../config/load.js';
import { writeGlobalDefaultModel, writeGlobalPreferences } from '../config/write.js';
import { createModelCatalogPort } from '../engine/model-catalog-port.js';
import { readUserPricingOverlay } from '../engine/pricing-overlay.js';
import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import { CliError } from '../process/errors.js';
import {
  isProviderKeyless,
  runOnboardingWizard,
  type ClackOnboardingDeps,
} from '../onboarding/wizard.js';
import type { CliIo } from '../process/io.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { detectOutputMode, isCiEnv } from '../process/output-mode.js';
import { resolveRenderMode } from '../render/render-mode.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { createMentionReader } from '../render/tui/mention.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from '../render/tui/home-controller.js';
import { DISABLE_BRACKETED_PASTE } from '../render/tui/home-input.js';
import { RootApp, type RootAppProps } from '../render/tui/home-app.js';
import { FORCE_TEARDOWN_MS, FRAME_MS } from '../render/tui/tui-constants.js';
import { createHomeStore } from './home-store.js';

/**
 * `driveHome` — the imperative entry behind a bare `relavium` in a TTY (2.5.B / [ADR-0054](../../../../docs/decisions/0054-cli-bare-invocation-interactive-home.md)).
 * It opens the durable `history.db` ONCE, wires the {@link createHomeStore} read seam + the {@link createHomeController}
 * session state machine, and mounts the single-ink tree {@link RootApp}. The per-chat build is deferred to a submit
 * (`startChat`) so the strip shows immediately and a slow/failed build degrades to a loading state / a Home banner.
 *
 * Process lifetime lives here (the controller owns the session lifetime):
 * - **Signals** — one SIGINT/SIGTERM handler covering the Home, the in-Home chat, and MCP teardown: a clean Home
 *   exit (Ctrl-C / EOF in Home mode) resolves exit 0; an EXTERNAL signal unmounts ink, tears the live chat down
 *   (bounded so a stuck MCP teardown can't hang), closes the db, and exits with the conventional `128+signo`
 *   (`130` SIGINT / `143` SIGTERM) so a shell pipeline still sees the interruption. A chat's own exit-code-4 is
 *   consumed by the controller loop (a chat ending returns to Home), never leaked.
 * - **Bracketed paste** — DECSET 2004 is enabled on mount and disabled on every exit path, so a pasted multi-line
 *   block is bracketed literal text (no embedded newline submits early); the controller strips the markers.
 */
export interface HomeDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests inject a scripted provider via `providers`). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /** Injectable RESUMED-session builder — used by the in-Home `/models` reseat (ADR-0059). Default {@link buildResumedChatSession}. */
  readonly buildResumedSession?: typeof buildResumedChatSession;
  /** Injectable session-store opener (tests pass an in-memory store). Default {@link openSessionStore}. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
  readonly mcpSecretResolver?: McpSecretResolver;
  /** The `/doctor` probes (2.5.C S5) — production assembles the real probes; a test injects a fake. */
  readonly doctorProbes?: DoctorProbes;
  /** The onboarding clack slice (2.5.G S8) — omit for the real prompts; a test injects a scripted one. Only ever
   *  used on a truly key-less first run (the wizard is otherwise skipped). */
  readonly onboardingPrompter?: ClackOnboardingDeps;
  readonly now?: () => number;
  readonly uuid?: () => string;
  /** Injectable ink mount + the terminal-size seam (tests drive `RootApp` props without a real TTY). `opts` carries
   *  the resolved alt-screen decision (2.6.F, ADR-0068 §e) so a test can observe the mode driveHome resolved; the
   *  production default passes it through as ink's `alternateScreen` render option. */
  readonly render?: (
    props: RootAppProps,
    opts: { readonly alternateScreen: boolean },
  ) => { unmount: () => void };
  readonly getSize?: () => { cols: number; rows: number };
  readonly subscribeResize?: (onResize: () => void) => () => void;
  /** Subscribe to SIGINT(2)/SIGTERM(15); returns an unsubscribe. Default registers on `process`. */
  readonly subscribeSignals?: (onSignal: (signo: number) => void) => () => void;
  /** Exit the process (tests inject a capture; production `process.exit`). */
  readonly exit?: (code: number) => void;
  /** Write a terminal control sequence (the bracketed-paste DECSET toggles). Default `process.stdout`. */
  readonly writeControl?: (sequence: string) => void;
}

/** The default external-signal source: SIGINT(2) + SIGTERM(15) on `process`, registered with `on` (not `once`)
 *  so ink's signal-exit listener never re-raises while we still hold the cooperative teardown. */
function defaultSubscribeSignals(onSignal: (signo: number) => void): () => void {
  const onSigint = (): void => onSignal(2);
  const onSigterm = (): void => onSignal(15);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
  };
}

export async function driveHome(deps: HomeDeps): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  // One OS-keychain accessor shared by the provider key resolver (2.C) + the MCP named-secret resolver (2.R) — the
  // Home's composition-root wiring, mirroring `dispatch.ts`'s `keyResolvers` for the named commands. WITHOUT the
  // keychain the Home defaulted to an ENV-ONLY resolver, so a key stored in the OS keychain (the normal
  // `relavium provider add` path) was invisible → a `provider_auth` error on the first Home-chat turn, even though
  // `relavium chat` (which IS keychain-wired via dispatch) worked. `createOsKeychainStore()` reads nothing until a
  // key is actually resolved (the default agent has no MCP servers, so the MCP resolver stays inert), so building
  // it here is side-effect-free; a test injects `providers` and never reaches the keychain.
  const keychain = createOsKeychainStore();
  const mcpSecretResolver =
    deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env, keychain);
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  // The provider resolver + `/doctor` probes are built INSIDE the try below — once `opened.db` + the `providerStore`
  // exist — so the resolver is STORE-AWARE (a custom `base_url` rebinds to its validated endpoint, 2.5.G S9); a test
  // still injects `deps.providers` / `deps.doctorProbes` to bypass the keychain/network.

  // The cleanup scope opens as soon as the db handle is held, so an init fault AFTER this point (a failed
  // homeStore wire, a control write, a signal registration) still closes the shared db ONCE and restores the
  // terminal state (DISABLE bracketed paste + unmount) rather than leaking the handle / leaving the mode on.
  let instance: { unmount: () => void } | undefined;
  let controller: HomeController | undefined;
  let unsubscribeSignals: (() => void) | undefined;
  let dbClosed = false;
  const closeDb = (): void => {
    if (dbClosed) return;
    dbClosed = true;
    opened.close();
  };
  const writeControl =
    deps.writeControl ??
    ((sequence: string) => {
      process.stdout.write(sequence);
    });

  try {
    const homeStore = createHomeStore({
      sessions: opened.store,
      runs: createRunHistoryReader(opened.db),
    });

    // The `/models` catalog port (2.5.G S7, ADR-0064) — built over the ONE already-open db handle (`opened.db`, the
    // same `history.db` the catalog cache shares, ADR-0050) + the Home's provider resolver, so the picker reads the
    // merged catalog + runs the (long-lived-process-safe) TTL background refresh + writes the next session's default.
    const storeDeps = { uuid, now };
    const providerStore = createProviderStore(opened.db, storeDeps);
    // The STORE-AWARE provider resolver (2.5.G S9, ADR-0065 §4) — built from `providerStore` so a stored custom
    // `base_url` rebinds its adapter to the SSRF-validated endpoint, for the Home's chat turns + the catalog refresh.
    const providers =
      deps.providers ?? createProviderResolver(deps.io.env, keychain, { providerStore });
    // The Home's `/doctor` probes (built here, over the store-aware resolver). The zero-config default agent has no
    // `mcp_servers`, so the `--deep` MCP tier reports "none configured" (and the Home palette runs only the fast tier).
    const doctorProbes =
      deps.doctorProbes ??
      assembleDoctorProbes({
        cwd: deps.global.cwd,
        ...(deps.global.configPath === undefined ? {} : { configPath: deps.global.configPath }),
        resolver: providers,
      });
    // The `✓`-marked current default is the EFFECTIVE default — `[chat].default_model` resolves project → workspace
    // → global `[preferences].default_model` (ADR-0063 §1). It is re-read FRESH from disk each call (not the loaded
    // `config` snapshot) so it reflects a same-session `/models` write AND a project/workspace override AND an edit
    // from another terminal; a config edited to malformed mid-session degrades to `undefined` rather than crashing
    // the picker. Cheap (a few small file reads) and only called on a picker open / accept, never per keystroke.
    // The EFFECTIVE `[chat]` block (project → workspace → global) — the shared read LOGIC (not a cached instance)
    // behind the model + effort readers, so a bare-Home picker open does up to two cheap reads (currentDefault +
    // currentEffort), never per-keystroke. A mid-session malformed config degrades to `undefined`, never a crash.
    const readEffectiveChat = ():
      | ReturnType<typeof loadResolvedConfig>['config']['chat']
      | undefined => {
      try {
        return loadResolvedConfig({
          cwd: deps.global.cwd,
          home: homeDir,
          ...(deps.global.configPath === undefined ? {} : { configPath: deps.global.configPath }),
        }).config.chat;
      } catch {
        return undefined; // a mid-session malformed config must not crash the picker
      }
    };
    const readEffectiveDefault = (): string | undefined => readEffectiveChat()?.defaultModel;
    const readEffectiveEffort = (): ReasoningEffort | undefined =>
      readEffectiveChat()?.reasoningEffort;
    // The `/models` catalog port (ADR-0064 §10) — the SHARED load/refresh + key-aware merge trio (the SAME one the
    // chat reseat picker uses, ADR-0059), over the ONE open db + the store-aware resolver. The Home layers its own
    // accept action on top: `currentDefault`/`currentEffort` (the ✓ markers) + `writeDefault` (the next-session
    // default model + its effort tier, ADR-0063 §1 · ADR-0066 §6).
    const models: HomeModelsPort = {
      ...createModelCatalogPort({ db: opened.db, providers, now, uuid }),
      currentDefault: readEffectiveDefault,
      currentEffort: readEffectiveEffort,
      // Write to the SAME file the picker re-reads + the started session resolves (honors `--config`), so a `/models`
      // write is never a silent no-op to a different file (2.5.G S7). The effort rides the SAME atomic write; an
      // absent `reasoningEffort` (a non-reasoning model) leaves any prior effort default unchanged.
      writeDefault: (modelId, reasoningEffort) =>
        writeGlobalPreferences(
          { defaultModel: modelId, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
          homeDir,
          deps.global.configPath,
        ),
    };

    // The SHARED HomeChatSession wiring over a built (FRESH or RESUMED) session + its view store — the persister,
    // the shared line handler (owns the ADR-0057 mode floor), the stream subscription + frame, the mention/shell
    // ports, and the bounded teardown. Used by startChat (fresh) and reseatChat (the ADR-0059 model switch), so the
    // in-Home chat wiring has ONE home. `open` opens a FRESH session (`session.start()`); a RESUMED session already
    // landed at idle, so it stays `false` and seeds the persister past its last durable sequence.
    const wireHomeChatSession = async (
      built: BuiltChatSession,
      store: ChatStoreController,
      opts: { readonly open: boolean; readonly initialSequenceNumber?: number },
    ): Promise<HomeChatSession> => {
      // Surface any config-level MCP tools the build skipped through the chat's ⚠ warnings channel (NOT stderr,
      // which would corrupt the live TUI) — parity with `relavium chat`'s surfaceMcpSkipped.
      for (const tool of built.mcpSkipped) {
        store.note(`MCP tool '${tool.name}' (server '${tool.server}') skipped — ${tool.reason}`);
      }
      // The chat's `/doctor` probes reflect THIS session's MCP status (derived from `built`, not the Home defaults).
      const chatDoctorProbes =
        deps.doctorProbes ??
        assembleDoctorProbes({
          cwd: deps.global.cwd,
          ...(deps.global.configPath === undefined ? {} : { configPath: deps.global.configPath }),
          resolver: providers,
          agentMcpServers: built.agent.mcp_servers ?? [],
          mcpSkipped: built.mcpSkipped,
        });
      // Acquire-then-guard: once the subscription + frame interval exist, a throw in the remaining wiring must
      // reclaim them — and any spawned MCP child — rather than leak the timer/subscription (chatCommand's guard).
      let frame: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: (() => void) | undefined;
      let persister: SessionPersister | undefined;
      try {
        persister = createSessionPersister({
          store: opened.store,
          handle: built.handle,
          sessionId: built.sessionId,
          agent: built.agent,
          context: built.context,
          now,
          uuid,
          // ADR-0059 per-message/session model attribution — resolve a model string → its `model_catalog.id` over
          // the SAME db (the Home's catalog is the one the picker refreshes), degrading to NULL when uncataloged.
          resolveModelCatalogId: makeCatalogIdResolver(opened.db, { uuid, now }),
          // A RESUMED session continues the durable transcript past its last sequence number; a fresh one starts at 0.
          ...(opts.initialSequenceNumber === undefined
            ? {}
            : { initialSequenceNumber: opts.initialSequenceNumber }),
        });
        // createChatLineHandler owns the mode control (ADR-0057): it applies the initial `ask` mode → the
        // fail-closed approval regime — BEFORE the session opens, so the full-capability host is never live without it.
        const {
          processLine,
          cancelOnce,
          shouldStop,
          stopReason,
          onAbort,
          onModeChange,
          onSetEffort,
        } = createChatLineHandler(
          { built, opened, store, persister, doctorProbes: chatDoctorProbes },
          deps,
        );
        // Subscribe the view store BEFORE opening the session so the synchronous session:started is observed.
        unsubscribe = built.handle.subscribe((event) => store.apply(event));
        frame = setInterval(() => store.tick(), FRAME_MS);
        frame.unref();
        persister.start();
        // Open a FRESH session; a RESUMED session already landed at idle inside AgentSession.resume — start() would
        // throw and re-emitting session:started would double a terminal-less lifecycle event.
        if (opts.open) built.session.start();
        // The `@`-mention completion reader (2.5.D, ADR-0061): a READ-ONLY fs jail at the session's fs-scope tier.
        const mentionFs = assembleToolEnv({
          profile: 'chat-read-only',
          fsScopeTier: built.context.fsScopeTier,
          workspaceDir: built.context.workingDir,
        }).host.fs;
        const mentionReader = mentionFs === undefined ? undefined : createMentionReader(mentionFs);
        // The `!`-shell runner (2.5.D step 5, ADR-0061) — a thin wrapper over the session's `runUserCommand`.
        const runShellCommand = (
          command: string,
          args: readonly string[],
        ): ReturnType<typeof built.session.runUserCommand> =>
          built.session.runUserCommand(command, args);
        let torn = false;
        const teardown = async (): Promise<void> => {
          if (torn) return; // idempotent — an error-path teardown racing an endChat must not double-close the MCP child
          torn = true;
          cancelOnce(); // the session's sole terminal — persister marks the row 'ended'
          clearInterval(frame);
          unsubscribe?.();
          try {
            persister?.close();
          } finally {
            await built.closeMcp?.().catch(() => undefined); // best-effort; never orphan a spawned stdio child
          }
        };
        return {
          store,
          processLine,
          shouldStop,
          stopReason,
          sessionId: built.sessionId,
          teardown,
          onAbort,
          onModeChange,
          // ADR-0066 §5: the in-Home `/models` effort sub-step + `/effort` push the SESSION override (no reseat).
          onSetEffort,
          ...(mentionReader === undefined ? {} : { mentionReader }),
          runShellCommand,
        };
      } catch (err) {
        clearInterval(frame); // reclaim whatever the wiring managed to acquire before the throw
        unsubscribe?.();
        try {
          persister?.close();
        } finally {
          await built.closeMcp?.().catch(() => undefined);
        }
        throw err;
      }
    };

    // Build + wire + START a fresh chat session (the controller sends the first message on transition).
    const startChat = async (): Promise<HomeChatSession> => {
      const store = createChatStore(deps.global.color);
      // The ADR-0065 §2 user-pricing overlay (2.5.G S10), read FRESH per chat from the SAME `history.db` (empty map
      // on a read fault). Static `MODEL_PRICING` still wins.
      const resolvePrice = readUserPricingOverlay(opened.db);
      const built: BuiltChatSession = await (deps.buildSession ?? buildChatSession)({
        // Re-read the EFFECTIVE default model AND reasoning-effort FRESH per chat (not the load-once `config`
        // snapshot) so a same-session `/models` write — the model (2.5.G S7) AND its effort sub-step (ADR-0066 §6) —
        // takes effect on the very next chat started in this long-lived Home. A read fault degrades to the startup
        // value. The other `[chat]` settings keep the startup snapshot.
        chat: {
          ...config.chat,
          defaultModel: readEffectiveDefault() ?? config.chat.defaultModel,
          reasoningEffort: readEffectiveEffort() ?? config.chat.reasoningEffort,
        },
        agentRef: undefined, // the built-in default agent (zero-config first run)
        cwd: deps.global.cwd,
        projectConfigDir,
        now,
        uuid,
        providers,
        mcpSecretResolver,
        mcpRegistrations: config.mcpServers,
        ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
        onBudgetWarning: (warning) =>
          deps.io.writeErr(
            `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
          ),
      });
      return wireHomeChatSession(built, store, { open: true });
    };

    // Reseat the in-Home chat onto a NEW model (ADR-0059) — the counterpart of the standalone `chat` reseat. Reload
    // the just-torn-down session's transcript from the SHARED db and RESUME it under a model-swapped agent (dropping
    // the original fallback_chain), carrying the text-only transcript + cumulative cost/turns; a NEW instance,
    // honoring ADR-0024's one-model-per-lifetime rule. The controller drives the tear-down / swap (mirroring clearChat).
    const reseatChat = async (
      sessionId: string,
      target: ReseatTarget,
    ): Promise<HomeChatSession> => {
      const loaded = opened.store.loadFull(sessionId);
      if (loaded === undefined || loaded.session.agentSnapshot === undefined) {
        throw new CliError(
          'invalid_invocation',
          `cannot switch model: session ${sessionId} could not be reloaded for reseat`,
        );
      }
      const newAgent = swapAgentModel(
        loaded.session.agentSnapshot,
        target.modelId,
        target.provider,
        target.reasoningEffort,
      );
      const record: AgentSessionRecord = { ...loaded.session, agentSnapshot: newAgent };
      const resolvePrice = readUserPricingOverlay(opened.db);
      const built = await (deps.buildResumedSession ?? buildResumedChatSession)({
        chat: config.chat,
        record,
        messages: loaded.messages,
        now,
        providers,
        mcpSecretResolver,
        mcpRegistrations: config.mcpServers,
        ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
        onBudgetWarning: (warning) =>
          deps.io.writeErr(
            `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
          ),
      });
      // Seed the view store with the carried model + cost/turns — a resumed session never re-emits session:started,
      // so without this the footer shows nothing until the first new turn (mirrors chatResumeCommand).
      const store = createChatStore(deps.global.color, {
        agentRef: built.agent.id,
        model: built.agent.model,
        cumulativeCostMicrocents: built.resumeState.cumulativeCostMicrocents,
        turnCount: built.resumeState.turnCount,
      });
      return wireHomeChatSession(built, store, {
        open: false,
        initialSequenceNumber: built.nextSequenceNumber,
      });
    };

    const getSize =
      deps.getSize ??
      (() => ({ cols: process.stdout.columns ?? 80, rows: process.stdout.rows ?? 24 }));
    const subscribeResize =
      deps.subscribeResize ??
      ((onResize: () => void) => {
        process.stdout.on('resize', onResize);
        return () => process.stdout.off('resize', onResize);
      });
    const exitProcess = deps.exit ?? ((code: number) => process.exit(code));

    // First-run onboarding (2.5.G S8): a truly KEY-LESS bare Home offers a `@clack` wizard to connect a provider
    // BEFORE mounting ink — clack + ink both take the terminal's raw mode, so the wizard must fully settle (and
    // clack restore the terminal) before `render()`. Already behind `shouldOpenHome`'s TTY/CI gate; a cancel or a
    // keychain-write failure ends the wizard cleanly and the Home mounts key-less (retry, or add a key manually).
    if (isProviderKeyless(providers)) {
      await runOnboardingWizard({
        store: providerStore,
        keychain,
        resolver: providers,
        io: deps.io,
        // Reuse the SAME config-write target as the `/models` port (honors `--config`) so the wizard's starter
        // model + a later `/models` pick + the started session all agree on one file (2.5.G S7/S8).
        writeDefaultModel: (modelId) =>
          writeGlobalDefaultModel(modelId, homeDir, deps.global.configPath),
        ...(deps.onboardingPrompter === undefined ? {} : { prompter: deps.onboardingPrompter }),
      });
    }

    // Bracketed paste (DECSET 2004) is enabled by ink 7's `usePaste` on mount (home-app.tsx). The defensive
    // `DISABLE_BRACKETED_PASTE` writes on the teardown paths below are belt-and-suspenders (usePaste also disables
    // on unmount) so an external signal can never leave the terminal in bracketed-paste mode.

    // One external-signal lifecycle covering the Home, the in-Home chat, and MCP teardown.
    let signaled = false;
    const onSignal = (signo: number): void => {
      if (signaled) {
        exitProcess(128 + signo); // a second signal forces an immediate exit (a teardown ignoring the abort)
        return;
      }
      signaled = true;
      // Best-effort terminal restore — a throw here must NOT skip scheduling the bounded teardown + exit below
      // (else an external signal could neither close the db nor exit).
      try {
        instance?.unmount(); // restore the terminal from raw mode BEFORE anything else
        writeControl(DISABLE_BRACKETED_PASTE);
      } catch {
        // ignore — restoring the terminal is best-effort; the close + exit must still run
      }
      // The bound is REFERENCED until the race settles so the exit is guaranteed even if teardown hangs; it is
      // cleared the instant the race resolves so a fast teardown (the common case) neither waits nor dangles.
      let bound: ReturnType<typeof setTimeout> | undefined;
      const bounded = new Promise<void>((resolve) => {
        bound = setTimeout(resolve, FORCE_TEARDOWN_MS);
      });
      void Promise.race([controller?.teardownActive() ?? Promise.resolve(), bounded])
        .catch(() => undefined) // a teardown rejection must never skip the close + exit (no unhandled rejection)
        .finally(() => {
          if (bound !== undefined) clearTimeout(bound);
          // exitProcess MUST always run — guard the db close so a (effectively non-throwing) close fault can never
          // strand the process without exiting.
          try {
            closeDb();
          } finally {
            exitProcess(128 + signo); // conventional 128+signo: 130 (SIGINT) / 143 (SIGTERM)
          }
        });
    };
    unsubscribeSignals = (deps.subscribeSignals ?? defaultSubscribeSignals)(onSignal);

    // Resolve the effective render mode (2.6.F, ADR-0068 §e). driveHome only runs on a TTY interactive path
    // (shouldOpenHome-gated), so the output mode is 'tui'; the resolver still short-circuits a 'plain' path to
    // inline defensively, then applies `--no-alt-screen` → `[preferences].alt_screen` → phase default (opt-in until
    // the viewport lands at Step 4b). `alt` mounts ink 7's native alternate screen (DECSET 1049 enter on mount /
    // exit on unmount — the finally's `instance.unmount()` restores the primary buffer before the terminal-state
    // cleanup below). An injected `deps.render` (tests) ignores the option — no real TTY to switch buffers on.
    const renderMode = resolveRenderMode({
      outputMode: detectOutputMode({
        stdoutIsTty: deps.io.stdoutIsTty,
        json: deps.global.json,
        ci: isCiEnv(deps.io.env),
      }),
      noAltScreenFlag: deps.global.noAltScreen === true,
      configAltScreen: config.altScreen,
    });

    return await new Promise<ExitCode>((resolve, reject) => {
      controller = createHomeController({
        startChat,
        reseatChat,
        homeStore,
        doctorProbes,
        models,
        onExit: () => resolve(EXIT_CODES.success), // a clean Home exit is exit 0
        onError: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      });
      const props: RootAppProps = {
        controller,
        nowMs: now,
        color: deps.global.color,
        getSize,
        subscribeResize,
      };
      const alternateScreen = renderMode === 'alt';
      instance =
        deps.render === undefined
          ? render(createElement(RootApp, props), {
              exitOnCtrlC: false, // the controller drives Ctrl-C, not ink's process.exit
              patchConsole: false,
              maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
              // ADR-0068 §e: mount the alternate screen only when resolved to 'alt' (TTY + opt-in). ink 7 handles the
              // DECSET-1049 enter/exit; `false` is a no-op (the inline default), so machine/opt-out paths are untouched.
              alternateScreen,
            })
          : deps.render(props, { alternateScreen });
    });
  } finally {
    // The clean-exit / error / INIT-FAULT path (NOT the signal path, which exits the process directly): undo the
    // terminal state, reclaim a live session, and close the shared db ONCE. The terminal restore is best-effort —
    // a throw there is swallowed so it neither turns a clean exit into a failure nor skips the teardown + close
    // below (a faulty terminal can never leak the session or the db handle). Unmount BEFORE disabling paste.
    unsubscribeSignals?.();
    try {
      instance?.unmount();
      writeControl(DISABLE_BRACKETED_PASTE);
    } catch {
      // ignore — restoring the terminal is best-effort; the session teardown + db close must still run
    }
    await controller?.teardownActive().catch(() => undefined); // always reclaim a live session
    closeDb(); // always close the shared db
  }
}
