import { randomUUID } from 'node:crypto';

import { createProviderStore, createRunHistoryReader } from '@relavium/db';
import type { AgentSessionRecord, ReasoningEffort } from '@relavium/shared';
import { render } from 'ink';
import { createElement } from 'react';

import {
  budgetWarningText,
  createChatLineHandler,
  transcriptBoundFor,
  type ReseatTarget,
} from '../commands/chat.js';
import {
  buildChatSession,
  buildResumedChatSession,
  swapAgentModel,
  type BuiltChatSession,
  type ChatBudgetWarning,
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
import { resolveCopyOnSelect, resolveMouseMode, resolveRenderMode } from '../render/render-mode.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { createOsKeychainStore } from '../secrets/os-keychain.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { assertRenderStoreAgree } from '../render/tui/session-view-model.js';
import { createMentionReader } from '../render/tui/mention.js';
import {
  createHomeController,
  type HomeChatSession,
  type HomeController,
  type HomeModelsPort,
} from '../render/tui/home-controller.js';
import { DISABLE_MOUSE, ENABLE_MOUSE } from '../render/alt-screen.js';
import { nodeCreateTempDocument, nodeSpawnEditor } from '../render/editor.js';
import { inkOwnedTerminal, type HatchDeps } from '../render/hatches.js';
import { nodeWaitForContinue, nodeWriteOut } from '../render/scrollback.js';
import { copyToClipboard, type ClipboardOutcome } from '../render/clipboard.js';
import { createSuspendPort } from '../render/suspend.js';
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
 * - **Signals** — one handler for SIGINT(2)/SIGTERM(15)/SIGHUP(1)/SIGQUIT(3), covering the Home, the in-Home chat,
 *   and MCP teardown: a clean Home exit (Ctrl-C / EOF in Home mode) resolves exit 0; an EXTERNAL signal unmounts ink,
 *   tears the live chat down (bounded so a stuck MCP teardown can't hang), closes the db, and exits with the
 *   conventional `128+signo` (`130` SIGINT / `143` SIGTERM / `129` SIGHUP / `131` SIGQUIT) so a shell pipeline still
 *   sees the interruption. A chat's own exit-code-4 is consumed by the controller loop, never leaked. Behind all of
 *   them sits a synchronous `process.on('exit')` net, the last chance to restore the terminal (2.6.F Step 6f).
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
  /** Subscribe to SIGINT(2)/SIGTERM(15)/SIGHUP(1)/SIGQUIT(3); returns an unsubscribe. Default registers on `process`. */
  readonly subscribeSignals?: (onSignal: (signo: number) => void) => () => void;
  /** Register a synchronous `process.on('exit')` net; returns a remover. Default registers on `process`. The LAST
   *  chance to restore the terminal when something calls `process.exit()` past the `finally` (2.6.F Step 6f). */
  readonly subscribeProcessExit?: (onExit: () => void) => () => void;
  /** Exit the process (tests inject a capture; production `process.exit`). */
  readonly exit?: (code: number) => void;
  /** Write a terminal control sequence (the bracketed-paste DECSET toggles). Default `process.stdout`. */
  readonly writeControl?: (sequence: string) => void;
}

/**
 * The default external-signal source, registered with `on` (not `once`) so ink's signal-exit listener never re-raises
 * while we still hold the cooperative teardown.
 *
 * SIGINT(2) + SIGTERM(15) drive the cooperative teardown. SIGHUP(1) + SIGQUIT(3) were MISSING until Step 6f: they are
 * catchable kills that terminate WITHOUT firing Node's `'exit'` event, and SIGHUP is what a user gets by closing the
 * terminal window. Without them the Home left DECSET 1002+1006 enabled on the primary buffer, and the shell then
 * echoed a mouse report on every click. `relavium chat`'s `defaultReplLifecycle` has covered all four since Step 4b-3;
 * the two surfaces now agree.
 */
export function defaultSubscribeSignals(onSignal: (signo: number) => void): () => void {
  const onSigint = (): void => onSignal(2);
  const onSigterm = (): void => onSignal(15);
  const onSighup = (): void => onSignal(1);
  const onSigquit = (): void => onSignal(3);
  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);
  process.on('SIGHUP', onSighup);
  process.on('SIGQUIT', onSigquit);
  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    process.removeListener('SIGHUP', onSighup);
    process.removeListener('SIGQUIT', onSigquit);
  };
}

/** The default `process.on('exit')` net — synchronous by definition, which is why the restore it runs must be too. */
export function defaultSubscribeProcessExit(onExit: () => void): () => void {
  process.on('exit', onExit);
  return () => process.removeListener('exit', onExit);
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
  let unsubscribeProcessExit: (() => void) | undefined;
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

  /**
   * Undo every terminal mode this command turned on, in reverse order: unmount ink FIRST (leaving raw mode and the
   * alternate buffer), then disable bracketed paste (DECSET 2004, enabled by ink 7's `usePaste`) and mouse reporting
   * (DECSET 1002+1006, ours). Both writes are unconditional — a disable is a no-op when the mode was never enabled.
   * BEST-EFFORT by contract: it swallows its own throw so a faulty terminal can never skip the caller's session
   * teardown + db close (the `finally`) nor the bounded teardown + exit (the signal handler). Shared by EVERY path
   * (the `finally`, the signal handler, and the `process.on('exit')` net), so they can never drift.
   *
   * IDEMPOTENT: the nets deliberately overlap, and `unmount()` on an already-unmounted tree plus a second `DISABLE`
   * write would be harmless but noisy. The latch makes "call it from wherever, as often as you like" the contract.
   */
  // Each step latches INDEPENDENTLY, and only after it SUCCEEDS. A single latch set before the writes would let one
  // transient fault (an EIO on a half-dead TTY unmounting ink, an EPIPE on a `writeControl`) mark the terminal
  // "restored" and every later net (the signal handler, the `process.on('exit')` net, the `finally`) decline to retry
  // — stranding mouse reporting / bracketed paste on the user's shell. This is the same discipline `alt-screen.ts`'s
  // `restore()` applies (2.6.F Step 6h). Each swallows its own throw so teardown + exit/close still run.
  let unmounted = false;
  let pasteDisabled = false;
  let mouseDisabled = false;
  const restoreTerminalControls = (): void => {
    if (!unmounted) {
      try {
        instance?.unmount(); // restore the terminal from raw mode BEFORE anything else
        unmounted = true;
      } catch {
        // a later net retries
      }
    }
    if (!pasteDisabled) {
      try {
        writeControl(DISABLE_BRACKETED_PASTE);
        pasteDisabled = true;
      } catch {
        // a later net retries
      }
    }
    if (!mouseDisabled) {
      try {
        writeControl(DISABLE_MOUSE); // restore native mouse text-selection (no-op if never enabled)
        mouseDisabled = true;
      } catch {
        // a later net retries
      }
    }
  };

  // The ADR-0068 §e hatch ports (2.6.F Step 5d). `RootApp` attaches ink's `suspendTerminal` to the port on mount;
  // `wireHomeChatSession` hands these ports to `createChatLineHandler` — the SAME builder `relavium chat` uses — so
  // `/scrollback` and `/edit` are literally the same code on both surfaces. Unlike the chat, the bare Home mounts ink
  // with `alternateScreen: true`, so ink itself toggles DECSET-1049 across a suspension; only the mouse is ours.
  const suspendPort = createSuspendPort();
  let altScreenActive = false; // assigned once the render mode resolves; read LAZILY by `terminal()` below
  let mouseActive = false; // ditto — `--no-mouse` / `[preferences].mouse = false` leaves the alt buffer mouse-less
  // Whether the mouse is captured RIGHT NOW. Distinct from `mouseActive` (the resolved mode) since Step 6g: the Home
  // landing gives the mouse back to the emulator, and a suspension must not "restore" a mode that is not on.
  let mouseCaptured = false;
  // ONE clipboard closure over the SAME control-write sink as the alt-buffer + mouse toggles (Step 6). `/copy` (via
  // `hatchPorts`) and copy-on-select (via `RootApp`'s `clipboard` prop, when enabled) both use it.
  const clipboard = (text: string): ClipboardOutcome =>
    copyToClipboard({ writeControl, env: deps.io.env }, text);
  const hatchPorts: Omit<HatchDeps, 'transcript' | 'note'> = {
    suspendPort,
    writeControl,
    // `inkOwnedTerminal` (not `hoistedTerminal`): this surface mounts ink with `alternateScreen: true`, so ink toggles
    // DECSET-1049 across the suspension and only the mouse is ours. Both read lazily — set at mount. `mouseActive` is
    // separate from `altActive` because `--no-mouse` decouples them (Step 5e).
    terminal: inkOwnedTerminal(
      () => altScreenActive,
      () => mouseCaptured,
      () => process.stdout.columns,
    ),
    clipboard,
    dump: {
      writeOut: nodeWriteOut(process.stdout),
      waitForContinue: nodeWaitForContinue(process.stdin),
    },
    editor: {
      env: deps.io.env,
      spawnEditor: nodeSpawnEditor,
      createTempDocument: nodeCreateTempDocument,
      onDisposeFailed: (path, error) => {
        deps.io.writeErr(
          `warning: transcript temp file teardown failed (${path}): ${
            error instanceof Error ? error.message : String(error)
          }\n`,
        );
      },
    },
  };

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
          { ...deps, hatchPorts },
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
      // `altScreenActive` is assigned when the render mode resolves, BEFORE the first submit that calls this. The
      // full-screen viewport can hold a whole answer; the inline `<Static>` path keeps its trailing tail (ADR-0068
      // Decision (c)). Read lazily, like the hatch ports, so the mode is the LIVE one.
      const store = createChatStore(
        deps.global.color,
        undefined,
        transcriptBoundFor(altScreenActive),
      );
      // TRIPWIRE (2.6.C): the store's transcript bound and the renderer both derive from `altScreenActive`, so they
      // agree BY CONSTRUCTION here — this pins that, loudly, if a future edit ever gives them separate sources.
      assertRenderStoreAgree(altScreenActive, store.getSnapshot().state.transcriptBound);
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
        // Into the chat's TRANSCRIPT, never raw stderr. `relavium chat` routes this through `emitLiveNotice` for
        // exactly this reason (Step-4b-3 Sonnet fix): a raw write lands on the alt buffer, where ink's next frame
        // overwrites it — the user is warned about their spend on a line that survives a single frame.
        onBudgetWarning: (warning) => store.notice(budgetWarningText(warning)),
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
      // The store's SEED comes from the build, so it cannot be created first — yet `onBudgetWarning` closes over it and
      // a pre-egress cap check can fire DURING the build. Hold it in a `let` and fall back to stderr until it exists,
      // exactly as `emitLiveNotice` does on the standalone chat. Either way the warning is never written raw onto the
      // alt buffer, where ink's next frame would erase it (Step-4b-3 Sonnet fix, carried here by the phase review).
      const storeRef: { current?: ChatStoreController } = {};
      const noteBudget = (warning: ChatBudgetWarning): void => {
        const text = budgetWarningText(warning);
        if (storeRef.current !== undefined) storeRef.current.notice(text);
        else deps.io.writeErr(`${text}\n`);
      };
      const built = await (deps.buildResumedSession ?? buildResumedChatSession)({
        chat: config.chat,
        record,
        messages: loaded.messages,
        now,
        providers,
        mcpSecretResolver,
        mcpRegistrations: config.mcpServers,
        ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
        onBudgetWarning: noteBudget,
      });
      // Seed the view store with the carried model + cost/turns — a resumed session never re-emits session:started,
      // so without this the footer shows nothing until the first new turn (mirrors chatResumeCommand).
      const store = createChatStore(
        deps.global.color,
        {
          agentRef: built.agent.id,
          model: built.agent.model,
          cumulativeCostMicrocents: built.resumeState.cumulativeCostMicrocents,
          turnCount: built.resumeState.turnCount,
          // 2.6.C: Step 3 threads the OUTGOING store's rendered transcript through here so a reseat keeps the
          // conversation on screen. Empty for now — the seed field lands first (and the gate ignores it on inline).
          transcript: [],
        },
        transcriptBoundFor(altScreenActive),
      );
      // TRIPWIRE (2.6.C): the store's transcript bound and the renderer both derive from `altScreenActive`, so they
      // agree BY CONSTRUCTION here — this pins that, loudly, if a future edit ever gives them separate sources.
      assertRenderStoreAgree(altScreenActive, store.getSnapshot().state.transcriptBound);
      storeRef.current = store; // from here a budget warning renders in the transcript, not on the alt buffer
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
    // `DISABLE_BRACKETED_PASTE` writes in `restoreTerminalControls` are belt-and-suspenders (usePaste also
    // disables on unmount) so an external signal can never leave the terminal in bracketed-paste mode.

    // One external-signal lifecycle covering the Home, the in-Home chat, and MCP teardown.
    let signaled = false;
    const onSignal = (signo: number): void => {
      // A KEYBOARD Ctrl-C during a `/scrollback` or `/edit` hatch arrives here as a REAL SIGINT: the suspension turns
      // raw mode OFF, so the kernel resumes translating Ctrl-C. The hatch owns the terminal — `nodeWaitForContinue`
      // resolves on that same SIGINT, and `$EDITOR` receives it directly. Tearing the Home down here would exit
      // BEHIND the suspension's back: its `reclaim` re-emits ENABLE_MOUSE on the way out, and the latched
      // `restoreTerminalControls` would never run again, stranding DECSET 1002+1006 on the user's shell.
      // `relavium chat` has gated this since Step 5d (`onSigintGated`, chat-ink.tsx); the Home never did.
      // Only SIGINT: an EXTERNAL kill (TERM/HUP/QUIT) must still tear down, suspended or not.
      if (signo === 2 && suspendPort.isSuspended()) return;
      if (signaled) {
        exitProcess(128 + signo); // a second signal forces an immediate exit (a teardown ignoring the abort)
        return;
      }
      signaled = true;
      // Best-effort terminal restore — it swallows its own throw, so it can NOT skip scheduling the bounded
      // teardown + exit below (else an external signal could neither close the db nor exit).
      restoreTerminalControls();
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
    // The LAST net. `onSignal` covers the catchable kills; this covers everything that reaches Node's `'exit'` without
    // unwinding our `finally` — a `process.exit()` from a nested command, an uncaught throw, an unhandled rejection.
    // It must be synchronous, which `restoreTerminalControls` is; the latch makes the overlap with the other nets free.
    unsubscribeProcessExit = (deps.subscribeProcessExit ?? defaultSubscribeProcessExit)(
      restoreTerminalControls,
    );

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
      const alternateScreen = renderMode === 'alt';
      altScreenActive = alternateScreen; // the hatch ports read this lazily (see `terminal()` above)
      // Mouse reporting (Step 5e, ADR-0068 §e) — resolved from the SAME render mode, so the two cannot disagree.
      mouseActive = resolveMouseMode({
        renderMode,
        noMouseFlag: deps.global.noMouse === true,
        configMouse: config.mouse,
      });
      // Copy-on-select (Step 6e): a durable preference, resolved from the ALREADY-RESOLVED mouse decision, so
      // `--no-mouse` turns it off structurally. `/copy` is unaffected — it has its own clipboard binding.
      const copyOnSelect = resolveCopyOnSelect({
        mouseEnabled: mouseActive,
        configCopyOnSelect: config.copyOnSelect,
      });
      const props: RootAppProps = {
        controller,
        nowMs: now,
        color: deps.global.color,
        getSize,
        subscribeResize,
        // The in-Home chat renders its transcript through the scroll viewport when mounted on the alt screen (Step 4b).
        alternateScreen,
        // `RootApp` attaches ink's `suspendTerminal` here while mounted (2.6.F Step 5d, ADR-0068 §e).
        suspendPort,
        // The branded banner's durable switch (Step 5g); `HomeView` owns the empty-Home rule when it is absent.
        showBanner: config.showBanner,
        // Armed only while the in-Home chat owns the screen (Step 6g). `mouseActive` is the RESOLVED mode
        // (`--no-mouse` / `[preferences].mouse`); when it is off, no port is passed and nothing is ever captured.
        ...(mouseActive
          ? {
              setMouseCapture: (enabled: boolean) => {
                mouseCaptured = enabled; // the hatch ports read this LIVE, like `altScreenActive`
                writeControl(enabled ? ENABLE_MOUSE : DISABLE_MOUSE);
              },
            }
          : {}),
        // Copy-on-select rides the SAME control-write sink as the alt-buffer + mouse toggles (Step 6). OSC 52 prints
        // nothing and moves no cursor, so writing it mid-frame cannot corrupt ink's line accounting. ABSENT when
        // `[preferences].copy_on_select = false`: the selection still highlights, and `/copy` still copies.
        ...(copyOnSelect ? { clipboard } : {}),
      };
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
      // Mouse reporting is armed by `RootApp` as the in-Home CHAT takes the screen (`setMouseCapture`), not here:
      // capturing it for the whole Home stripped the landing of the emulator's native selection and gave nothing back
      // (2.6.F Step 6g). Disabled on EVERY teardown path below — the `DISABLE_MOUSE` writes are unconditional there
      // (a no-op when it was never enabled, like DISABLE_BRACKETED_PASTE).
    });
  } finally {
    // The clean-exit / error / INIT-FAULT path (NOT the signal path, which exits the process directly): undo the
    // terminal state, reclaim a live session, and close the shared db ONCE. The terminal restore swallows its own
    // throw, so it neither turns a clean exit into a failure nor skips the teardown + close below — a faulty
    // terminal can never leak the session or the db handle.
    unsubscribeSignals?.();
    unsubscribeProcessExit?.();
    restoreTerminalControls();
    await controller?.teardownActive().catch(() => undefined); // always reclaim a live session
    closeDb(); // always close the shared db
  }
}
