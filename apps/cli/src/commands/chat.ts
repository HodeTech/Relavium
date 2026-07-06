import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import {
  DEFAULT_SESSION_MAX_TURNS,
  type AgentDefinition,
  type SessionHandle,
  type SessionStreamHandleEvent,
  type UserCommandOutcome,
} from '@relavium/core';
import type { ProviderId } from '@relavium/llm';
import type { AgentSessionRecord } from '@relavium/shared';
import { exportSession } from '../chat/export.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../chat/doctor.js';
import { assembleDoctorProbes } from '../chat/doctor-host.js';
import {
  catalogNotice,
  clearedNotice,
  compactionNotice,
  costNotice,
  modelSwitchNotice,
  trimNotice,
} from '../chat/repl-info.js';
import { discoverCatalog, type CatalogEntry, type CatalogKind } from '../workflows/catalog.js';
import {
  formatReplHelp,
  replCommandList,
  REPL_COMMANDS_BY_NAME,
  type ReplCommand,
  type ReplCommandContext,
} from './repl-commands.js';
import {
  CHAT_MODES,
  MODE_DESCRIPTION,
  MODE_LABEL,
  parseMode,
  type ApprovalPrompt,
  type ChatMode,
} from '../chat/chat-mode.js';
import { applyChatMode, makeChatModeEnv } from '../chat/chat-mode-host.js';
import {
  createSessionPersister,
  makeCatalogIdResolver,
  type SessionPersister,
} from '../chat/persister.js';
import {
  buildChatSession,
  buildResumedChatSession,
  swapAgentModel,
  type BuildChatSessionOptions,
  type BuiltChatSession,
  type BuiltResumedChatSession,
} from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { createModelCatalogPort, type ModelCatalogPort } from '../engine/model-catalog-port.js';
import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import { loadUserPricingOverlay, readUserPricingOverlay } from '../engine/pricing-overlay.js';
import { surfaceMcpSkipped } from '../engine/mcp-servers.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import {
  formatToolCall,
  sanitizeInline,
  stripTerminalControls,
} from '../render/tui/chat-projection.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';
import { createMentionReader, type MentionReader } from '../render/tui/mention.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';

/**
 * `relavium chat` (2.M) — the agent-first interactive REPL over `@relavium/core`'s `AgentSession`. It binds
 * one agent for the session lifetime, streams each turn, and durably persists the session (resumable via the
 * 2.N `chat-resume`). Framework-free — NO commander/ink import: the loop drives an injected {@link ChatDriver}
 * (the TTY ink renderer or the plain non-TTY line loop) over one core, so the same logic powers both surfaces
 * and is e2e-testable headlessly. `/exit` (and `/cancel`, and an input-stream EOF) end the session with the
 * canonical **exit code 4**. Pre-session faults (config / unknown agent) throw a typed `CliError` (exit 2).
 */

export interface ChatCommandArgs {
  /** `--agent <ref>` (path or bare id); `undefined` ⇒ the built-in default agent over `[chat].default_model`. */
  readonly agent: string | undefined;
}

/** Surface a teardown failure as a stderr warning (never silently swallowed, never thrown — the primary
 *  command outcome must survive a cleanup fault). Shared by the chat command + resume teardown paths. */
function warnTeardown(io: CliIo, label: string, err: unknown): void {
  io.writeErr(
    `warning: ${label} teardown failed: ${err instanceof Error ? err.message : String(err)}\n`,
  );
}

/** Best-effort SYNC close: run it, but a reject/throw only warns — so one resource's failure never skips the
 *  next teardown step nor masks the primary outcome (attempt-all, preserve-primary). */
function closeQuietly(io: CliIo, label: string, close: () => void): void {
  try {
    close();
  } catch (err) {
    warnTeardown(io, label, err);
  }
}

/**
 * A mid-session model-switch target ([ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md)):
 * the picked model + its provider. The reseat rebuilds the session bound to this model (dropping the original
 * `fallback_chain`), carrying the text-only transcript + cumulative cost/turns. Both fields come from the picker's
 * chosen `ModelCatalogEntry`, so the provider is authoritative (never re-inferred from the id).
 */
export interface ReseatTarget {
  readonly modelId: string;
  readonly provider: ProviderId;
}

/**
 * The catalog port the ink `/models` reseat picker (ADR-0059) reads — the SHARED load/refresh trio
 * ({@link ModelCatalogPort}) plus the session's currently-bound model (the picker's `✓` "you are here" marker).
 * Built per session so `boundModel` reflects a reseat's switched model. Interactive (TTY) sessions only.
 */
export interface ChatModelsPort extends ModelCatalogPort {
  readonly boundModel: string;
}

/** Assemble a {@link ChatModelsPort} over the session's shared db + provider resolver (the catalog the Home picker
 *  also reads) plus the bound model — the one place the chat reseat picker's port is wired. */
function buildChatModelsPort(
  opened: OpenedSessionStore,
  providers: ProviderResolver,
  boundModel: string,
  now: () => number,
  uuid: () => string,
): ChatModelsPort {
  return { ...createModelCatalogPort({ db: opened.db, providers, now, uuid }), boundModel };
}

/** What an interactive driver receives — the command core's seam, so a driver never touches the session directly. */
export interface ChatDriveContext {
  /**
   * Open the session — call this AS THE FIRST ACT inside the driver, AFTER it has wired its stream
   * subscription, so the synchronous `session:started` (which carries the model) is observed, not raced.
   */
  readonly startSession: () => void;
  /** Handle one line of user input (a slash command or a chat message). Awaits the turn for a message. */
  readonly processLine: (line: string, display?: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` (or `/clear`, or a `/models` reseat) has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
  /**
   * WHY the driver's input loop ended (ADR-0062 §7 · [ADR-0059](../../../../docs/decisions/0059-cli-mid-session-model-reseat.md))
   * — `'exit'` (`/exit`, `/cancel`, or an input EOF), `'clear'` (`/clear`, TTY-interactive only), or `'reseat'`
   * (a `/models` mid-session model switch, TTY-interactive only). The driver returns `{ kind: ctx.stopReason() }`;
   * the standalone re-drive loop ({@link runReplLoop}) reads a `'clear'` to swap in a FRESH session and a `'reseat'`
   * to swap in a NEW-model session carrying the transcript. Both interactive gates keep `stopReason()` at `'exit'`
   * under `--json` / plain non-TTY, so those drivers only ever return `'exit'`.
   */
  readonly stopReason: () => 'exit' | 'clear' | 'reseat';
  /**
   * Switch the bound model mid-session (ADR-0059) — the ink model-picker overlay calls this on accept. It signals a
   * host-side reseat (a new instance bound to `target`), so like `/clear` it sets the stop state; the driver then
   * ends and {@link runReplLoop} rebuilds. Absent on a non-interactive driver (plain/`--json`), where a live reseat
   * is unavailable — one machine stream is one session lifecycle (ADR-0049), exactly as `/clear` is gated off there.
   */
  readonly onReseat?: (target: ReseatTarget) => void;
  /**
   * The `/models` reseat picker catalog port (ADR-0059) — the ink `ChatApp` opens the model-picker overlay off a
   * typed `/models`, reads the merged catalog through this, and calls {@link onReseat} on accept. Present on an
   * interactive (TTY, non-`--json`) session only; a plain/`--json` driver has no overlay, so a typed `/models`
   * there falls through to the core surface guard's actionable "interactive terminal" hint. Absent ⇒ no picker.
   */
  readonly modelPicker?: ChatModelsPort;
  /** The live session stream (the driver renders it: ink reduces it into the store; plain prints it). */
  readonly handle: SessionHandle;
  /** The view store the ink renderer projects (`apply` already wired by the ink driver). */
  readonly store: ChatStoreController;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /**
   * The session banner line (no trailing newline). A fresh session leaves it unset (the plain driver shows a
   * default greeting; the ink driver shows nothing); a 2.N resume sets the "Resuming session …" context line,
   * which BOTH drivers print — the plain loop as its banner, the ink driver once above the live region — so a
   * resumed session is visibly a resume. The seeded footer additionally carries the bound model + prior totals.
   */
  readonly intro?: string;
  /**
   * Flush the session's terminal (`session:cancelled`) — a headless driver MUST call this once its input loop
   * ends, while its render subscription is still attached, so the `--json` stream includes its sole terminal
   * event (the command's own teardown fires the terminal only AFTER the driver has unsubscribed). Idempotent.
   */
  readonly finalize?: () => void;
  /**
   * Best-effort teardown to run on a driver's HARD-exit path (the ink driver's second-SIGINT `process.exit`,
   * which bypasses the command's `runReplLoop` finally). It tears the live MCP connections down so a forced quit
   * never orphans a spawned stdio child. The command wires it to `built.closeMcp`; a driver awaits it (bounded)
   * before `process.exit`. Absent ⇒ nothing to force-close.
   */
  readonly onForceExit?: () => Promise<void>;
  /**
   * Mid-turn abort (EA7, ADR-0057) — abort the in-flight turn but KEEP the session alive (distinct from
   * `/cancel`, which is terminal). The ink driver wires `Esc` to this; a plain/JSON driver ignores it.
   */
  readonly onAbort?: () => void;
  /**
   * Switch the chat mode (ADR-0057) — updates the footer + re-applies the turn policy (advertise-filter +
   * fail-closed approval regime) on the SAME session instance (no reseat). The ink driver wires `Shift+Tab`
   * (cycle) + the `/mode` command to this. Absent on a driver that has no mode UI (the mode stays the default).
   */
  readonly onModeChange?: (mode: ChatMode) => void;
  /**
   * The `@`-mention completion reader (2.5.D, [ADR-0061](../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md))
   * — a thin wrapper over a READ-ONLY `FsCapability` jailed to the SAME fs-scope tier + workspace as the session's
   * tools, so `@`-completion browses + injects files through the identical jail + confidentiality floor + listing-gate
   * (a `.ssh`/`.env` entry is never listed nor read). Present on an interactive (TTY, non-`--json`) session; the ink
   * driver wires `@` at a word boundary to the dir-navigable completion. Absent ⇒ a plain/`--json` driver treats a
   * leading `@` as a literal (no completion). Read-only by construction — the mention path never writes.
   */
  readonly mentionReader?: MentionReader;
  /**
   * Run a USER-invoked `!`-shell command (2.5.D step 5, ADR-0061) through the session's `runUserCommand` — the one
   * `run_command` boundary (allowlist BEFORE approval → mode-aware `confirmAction` → hardened process arm). The
   * caller pre-tokenizes the line into `command` + `args`. Present on an interactive (TTY, non-`--json`) session;
   * the driver injects the classified output as UNTRUSTED context / renders the actionable deny hint. Absent ⇒ a
   * plain/`--json` driver treats a leading `!` as a literal message (no shell escape).
   */
  readonly runShellCommand?: (
    command: string,
    args: readonly string[],
  ) => Promise<UserCommandOutcome>;
}
/**
 * How a {@link ChatDriver}'s input loop ended (ADR-0062 §7 · ADR-0059): `'exit'` ends the REPL (exit 4); `'clear'`
 * tells the standalone {@link runReplLoop} to tear the current session down and re-drive over a FRESH one; `'reseat'`
 * tells it to re-drive over a NEW-model session carrying the transcript (`target` is the picked model). Both `/clear`
 * and a `/models` reseat are TTY-interactive only, so `--json` / plain drivers only ever return `'exit'`. `target` is
 * present iff `kind === 'reseat'` — {@link driveOneSession} attaches it from the line handler's captured target.
 */
export interface ChatDriveOutcome {
  readonly kind: 'exit' | 'clear' | 'reseat';
  readonly target?: ReseatTarget;
}
export type ChatDriver = (ctx: ChatDriveContext) => Promise<ChatDriveOutcome>;

export interface ChatCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests inject a scripted provider via providers). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /** Injectable RESUMED-session builder — used by the `/models` reseat rebuild (ADR-0059), which continues the
   *  just-ended session under a new-model agent. Default {@link buildResumedChatSession}. */
  readonly buildResumedSession?: typeof buildResumedChatSession;
  /** Injectable session-store opener (tests pass an in-memory store). Default {@link openSessionStore}. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
  /** The MCP named-secret resolver (2.R Step 4) — production injects the keychain-backed one (specs.ts); default env-only. */
  readonly mcpSecretResolver?: McpSecretResolver;
  /** The `/doctor` probes (2.5.C S5) — production assembles the real keychain/config/tool/provider/MCP probes;
   *  a test injects a fake so it exercises `/doctor` without a real keychain or a live provider/MCP server. */
  readonly doctorProbes?: DoctorProbes;
  /** The interactive driver — defaults to the plain non-TTY line loop; the TTY ink driver + tests override it. */
  readonly drive?: ChatDriver;
  /** Wall-clock (ms) + id sources (injectable for tests). */
  readonly now?: () => number;
  readonly uuid?: () => string;
}

export interface ChatResumeCommandArgs {
  /** The persisted session to reload + continue (`relavium chat-resume <sessionId>`). */
  readonly sessionId: string;
}

export interface ChatResumeCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly providers?: ProviderResolver;
  /** Injectable resumed-session builder (tests inject a scripted provider via providers). Default {@link buildResumedChatSession}. */
  readonly buildResumedSession?: typeof buildResumedChatSession;
  /** Injectable FRESH session builder — used only by the `/clear` re-drive rebuild (ADR-0062 §7), which starts a
   *  brand-new session (not a re-resume) bound to the resumed agent. Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /** Injectable session-store opener (tests pass an in-memory store). Default {@link openSessionStore}. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
  /** The MCP named-secret resolver (2.R Step 4) — production injects the keychain-backed one; default env-only. */
  readonly mcpSecretResolver?: McpSecretResolver;
  /** The `/doctor` probes (2.5.C S5) — production assembles the real probes; a test injects a fake. */
  readonly doctorProbes?: DoctorProbes;
  /** The interactive driver — defaults to the plain non-TTY line loop; the TTY ink driver + tests override it. */
  readonly drive?: ChatDriver;
  /** Wall-clock (ms) + id sources (injectable for tests). */
  readonly now?: () => number;
  readonly uuid?: () => string;
}

/** The subset the shared {@link runReplLoop} needs — satisfied by both {@link ChatCommandDeps} and {@link ChatResumeCommandDeps}. */
interface ChatReplDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly drive?: ChatDriver;
}

export async function chatCommand(args: ChatCommandArgs, deps: ChatCommandDeps): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;

  // Config (2.B): a malformed layer is exit 2; the project dir powers bare-id --agent discovery, homeDir
  // locates ~/.relavium/history.db (2.H/ADR-0050).
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const providers = deps.providers ?? createProviderResolver(deps.io.env);
  const mcpSecretResolver = deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env);
  const store = createChatStore(deps.global.color);
  // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — a transient read of the `model_catalog` `source='user'`
  // rows, so a user-priced model is enforced by `[chat].max_cost_microcents` + tracked in realized cost. NON-FATAL:
  // an unopenable db yields `undefined` here and surfaces cleanly through the session store open below.
  const resolvePrice = loadUserPricingOverlay(homeDir);

  // An unknown --agent / un-inferrable default model throws a typed CliError here (exit 2), before any session.
  // The build is async (2.R): it connects the agent's inline stdio `mcp_servers` (a connect failure is a
  // fail-loud exit-2 CliError, cause stripped) before the session is live.
  const built = await (deps.buildSession ?? buildChatSession)({
    chat: config.chat,
    agentRef: args.agent,
    cwd: deps.global.cwd,
    projectConfigDir,
    now,
    uuid,
    providers,
    mcpSecretResolver,
    mcpRegistrations: config.mcpServers,
    ...(resolvePrice === undefined ? {} : { resolvePrice }),
    onBudgetWarning: (warning) =>
      deps.io.writeErr(
        `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
      ),
  });
  // The session now OWNS the live MCP connections (built.closeMcp). `runReplLoop`'s finally is the steady-state
  // teardown, but the build→loop window (opening history.db can throw) runs first — guard it so a pre-loop fault
  // tears the connections down rather than orphaning the spawned children (ADR-0052 §2 teardown-on-terminal).
  surfaceMcpSkipped(deps.io, built.mcpSkipped);
  // Acquire the store first; on failure tear the MCP children down (best-effort — never mask the open error).
  let opened: OpenedSessionStore;
  try {
    opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  } catch (err) {
    await built.closeMcp?.().catch(() => undefined);
    throw err;
  }
  // Then the persister; on failure tear down EVERY acquired resource (the store too) before rethrowing.
  let persister: SessionPersister;
  try {
    persister = createSessionPersister({
      store: opened.store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid,
      // ADR-0059 per-message/session model attribution — resolve a model string → its `model_catalog.id` (the FK
      // target) over the SAME db, degrading to NULL when uncataloged. Shared across every persister site.
      resolveModelCatalogId: makeCatalogIdResolver(opened.db, { uuid, now }),
    });
  } catch (err) {
    closeQuietly(deps.io, 'session store', () => opened.close());
    await built.closeMcp?.().catch(() => undefined);
    throw err;
  }

  const doctorProbes =
    deps.doctorProbes ??
    assembleDoctorProbes({
      cwd: deps.global.cwd,
      ...(deps.global.configPath === undefined ? {} : { configPath: deps.global.configPath }),
      resolver: providers,
      // The MCP tier REPORTS the live session's status (read-only) — the bound agent's declared servers (all
      // connected, since this session is live) + the tools the manager dropped. It never re-connects/spawns.
      agentMcpServers: built.agent.mcp_servers ?? [],
      mcpSkipped: built.mcpSkipped,
    });

  // The `/clear` (ADR-0062 §7) re-drive rebuild — a FRESH session bound to the SAME agent (`built.agent`, reused
  // verbatim, invariant across swaps), MCP reconnected, store/totals empty, over the SHARED db. The contract is
  // shared with `chat-resume` via createClearRebuild so it cannot drift.
  const rebuild = createClearRebuild({
    chat: config.chat,
    agent: built.agent,
    projectConfigDir,
    now,
    uuid,
    providers,
    mcpSecretResolver,
    mcpRegistrations: config.mcpServers,
    opened,
    buildSession: deps.buildSession ?? buildChatSession,
    io: deps.io,
    global: deps.global,
    // A `/clear` rebuild re-reads the user-pricing overlay FRESH from the shared db (buildFreshChatWiring), so a
    // mid-session `models pricing` write applies to the next cleared session — no captured value to thread here.
  });

  // The `/models` reseat rebuild (ADR-0059) — a NEW-model session carrying the transcript. It reloads the
  // just-ended session from the SHARED db, so it does not close over `built.agent` (the reseat swaps the model).
  const reseatRebuild = createReseatRebuild({
    chat: config.chat,
    now,
    uuid,
    providers,
    mcpSecretResolver,
    mcpRegistrations: config.mcpServers,
    opened,
    buildResumedSession: deps.buildResumedSession ?? buildResumedChatSession,
    io: deps.io,
    global: deps.global,
  });

  return runReplLoop(
    {
      built,
      opened,
      store,
      persister,
      doctorProbes,
      startSession: () => built.session.start(),
      modelPicker: buildChatModelsPort(opened, providers, built.agent.model, now, uuid),
      ...(config.chat.maxMessages === undefined
        ? {}
        : { chatMaxMessages: config.chat.maxMessages }),
    },
    deps,
    rebuild,
    reseatRebuild,
  );
}

/**
 * `relavium chat-resume <sessionId>` (2.N) — reload a persisted session from `history.db` and continue it in
 * the SAME REPL. It rebinds the session's frozen agent + context, reconstructs the in-flight transcript
 * ({@link buildResumedChatSession} over `AgentSession.resume`), seeds the view header from the carried-over
 * state, continues the durable transcript past its last `sequenceNumber`, and drives the shared
 * {@link runReplLoop}. An unknown `sessionId` (or a session with no stored agent snapshot) is a clean exit-2
 * invocation fault. Like `chat`, it ends with **exit code 4**.
 */
export async function chatResumeCommand(
  args: ChatResumeCommandArgs,
  deps: ChatResumeCommandDeps,
): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;

  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const providers = deps.providers ?? createProviderResolver(deps.io.env);
  const mcpSecretResolver = deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env);
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);

  let built: BuiltChatSession;
  let store: ChatStoreController;
  let persister: SessionPersister;
  let intro: string;
  // The ADR-0065 §2 user-pricing overlay (2.5.G S10) — hoisted so the post-try `/clear` rebuild reuses it.
  let resolvePrice: BuildChatSessionOptions['resolvePrice'];
  // The just-built resumed session OWNS its MCP connections; if a pre-loop step after a SUCCESSFUL build throws,
  // the catch must tear them down (the steady-state teardown is runReplLoop's finally, not yet entered). Undefined
  // when no server was declared OR the build self-cleaned its own post-connect fault (see buildResumedChatSession).
  let closeMcp: (() => Promise<void>) | undefined;
  try {
    // The current `[chat]` config governs the resumed turn/cost caps; the agent, model, and context are the
    // frozen originals from the record. An absent session is a clean exit-2 invocation fault.
    const loaded = opened.store.loadFull(args.sessionId);
    if (loaded === undefined) {
      throw new CliError('invalid_invocation', `no session found with id ${args.sessionId}`);
    }
    // The ADR-0065 §2 user-pricing overlay (2.5.G S10), read from the ALREADY-OPEN session db — so a resumed
    // session enforces + tracks a user-priced model exactly like a fresh `chat`. Non-fatal (an empty map on a
    // read fault): a corrupt pricing row must not fail an otherwise-valid resume.
    resolvePrice = readUserPricingOverlay(opened.db);
    const resumed = await (deps.buildResumedSession ?? buildResumedChatSession)({
      chat: config.chat,
      record: loaded.session,
      messages: loaded.messages,
      now,
      providers,
      mcpSecretResolver,
      mcpRegistrations: config.mcpServers,
      resolvePrice,
      onBudgetWarning: (warning) =>
        deps.io.writeErr(
          `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
        ),
    });
    closeMcp = resumed.closeMcp;
    surfaceMcpSkipped(deps.io, resumed.mcpSkipped);
    built = resumed;
    // Seed the view header + persister via the SHARED resumed-wiring assembly (the same the `/models` reseat uses):
    // a resumed session never re-emits `session:started`, so the seeded store shows the model + carried cost/turns
    // from the first frame, and the persister continues past the last durable sequence number.
    ({ store, persister } = seedResumedWiring(resumed, opened, deps.global.color, now, uuid));
    const turns = resumed.resumeState.turnCount;
    // `sessionId` is only schema-constrained to a non-empty string (the CLI mints a UUID, but `history.db` is
    // shared with other surfaces) — sanitize it before it reaches the TTY, exactly as `chat-list` does (the
    // agent id is kebab-constrained, so safe raw). Without this the resume banner is the one chat output path
    // that could carry a terminal escape from a crafted stored id.
    intro = `Resuming session ${sanitizeInline(resumed.sessionId)} — ${resumed.agent.id}, ${turns} prior ${turns === 1 ? 'turn' : 'turns'}. Type a message, or /exit to quit.`;
    // Pre-flight the hard turn cap: a session resumed under a config whose `[chat].max_turns` is now at/below
    // its prior turn count would have EVERY new turn blocked loudly as `turn_limit` (the engine cap counts the
    // carried turns) with no way forward but /exit. Warn up front (stderr, non-blocking) so the user isn't
    // silently trapped — distinct from the per-turn engine error. The effective cap mirrors the engine's
    // `undefined/≤0 ⇒ default` rule (config validation already rejects a non-positive max_turns).
    const cap = config.chat.maxTurns ?? DEFAULT_SESSION_MAX_TURNS;
    if (turns >= cap) {
      deps.io.writeErr(
        `note: this session has ${turns} turns, at or over the ${cap}-turn cap — new turns will be refused (turn_limit). Raise [chat].max_turns to continue it.\n`,
      );
    }
  } catch (err) {
    // A pre-loop fault (not-found, no snapshot, build failure, or a post-build setup throw) must not strand the
    // open db handle NOR the spawned MCP children — tear BOTH down (a reject in one must not skip the other), and
    // never let a cleanup fault mask the primary error (best-effort; closeMcp is idempotent + a no-op when unset).
    await closeMcp?.().catch((e: unknown) => warnTeardown(deps.io, 'MCP', e));
    closeQuietly(deps.io, 'session store', () => opened.close());
    throw err;
  }

  const doctorProbes =
    deps.doctorProbes ??
    assembleDoctorProbes({
      cwd: deps.global.cwd,
      ...(deps.global.configPath === undefined ? {} : { configPath: deps.global.configPath }),
      resolver: providers,
      // The MCP tier REPORTS the live session's status (read-only) — the bound agent's declared servers (all
      // connected, since this session is live) + the tools the manager dropped. It never re-connects/spawns.
      agentMcpServers: built.agent.mcp_servers ?? [],
      mcpSkipped: built.mcpSkipped,
    });

  // The `/clear` (ADR-0062 §7) re-drive rebuild: a FRESH session (NOT a re-resume) bound to the resumed agent —
  // `built.agent` is the frozen snapshot agent (no on-disk ref), passed verbatim. Same shared contract as `chat`.
  const rebuild = createClearRebuild({
    chat: config.chat,
    agent: built.agent,
    projectConfigDir,
    now,
    uuid,
    providers,
    mcpSecretResolver,
    mcpRegistrations: config.mcpServers,
    opened,
    buildSession: deps.buildSession ?? buildChatSession,
    io: deps.io,
    global: deps.global,
    // A `/clear` rebuild re-reads the user-pricing overlay FRESH from the shared db (buildFreshChatWiring).
  });

  // The `/models` reseat rebuild (ADR-0059) — a NEW-model session carrying the transcript, over the SHARED db.
  // Reloads the just-ended session (which may itself already be a resume), so it needs no captured agent.
  const reseatRebuild = createReseatRebuild({
    chat: config.chat,
    now,
    uuid,
    providers,
    mcpSecretResolver,
    mcpRegistrations: config.mcpServers,
    opened,
    buildResumedSession: deps.buildResumedSession ?? buildResumedChatSession,
    io: deps.io,
    global: deps.global,
  });

  // A resumed session already landed at idle inside `AgentSession.resume`; calling start() would throw and
  // re-emitting `session:started` would double a terminal-less lifecycle event — so startSession is a no-op.
  return runReplLoop(
    {
      built,
      opened,
      store,
      persister,
      doctorProbes,
      startSession: () => {},
      intro,
      modelPicker: buildChatModelsPort(opened, providers, built.agent.model, now, uuid),
      ...(config.chat.maxMessages === undefined
        ? {}
        : { chatMaxMessages: config.chat.maxMessages }),
    },
    deps,
    rebuild,
    reseatRebuild,
  );
}

/** What the shared REPL loop needs: a built (fresh or resumed) session, its store/persister, and how to open it. */
interface ReplWiring {
  readonly built: BuiltChatSession;
  readonly opened: OpenedSessionStore;
  readonly store: ChatStoreController;
  readonly persister: SessionPersister;
  /** The assembled `/doctor` probes (2.5.C S5) — the replCtx's `runDoctor` runs them over the notice channel. */
  readonly doctorProbes: DoctorProbes;
  /** Open the session: `built.session.start()` for a fresh session, a no-op for a resumed one (already idle). */
  readonly startSession: () => void;
  /** The plain-driver banner override (the 2.N resume context line); fresh sessions omit it. */
  readonly intro?: string;
  /** `[chat].max_messages` — the default bound a bare `/trim` uses (ADR-0062); absent ⇒ `/trim` needs an inline `n`. */
  readonly chatMaxMessages?: number;
  /** The `/models` reseat picker port (ADR-0059) — built per session (its `boundModel` is the current model).
   *  Forwarded to the ctx only on an interactive driver (`driveOneSession` gates it). */
  readonly modelPicker?: ChatModelsPort;
}

/**
 * The shared REPL loop driving both `chat` (fresh) and `chat-resume` (2.N): wire the slash-command/message
 * `processLine`, start the persister, hand control to the injected {@link ChatDriver} (ink TTY or plain line
 * loop), and on teardown emit the session's sole terminal (`session:cancelled`, idempotent) + close the
 * persister and the db. `/exit`, `/cancel`, and an input-stream EOF all end the session with **exit code 4**.
 */
/** The mode/abort control surface a driver wires to its keys + the `/mode` command (ADR-0057). */
export interface ChatModeControl {
  /** Mid-turn abort (EA7) — abort the in-flight turn, keeping the session alive. */
  readonly onAbort: () => void;
  /** Switch the chat mode: update the footer + re-apply the turn policy on the same session (no reseat). */
  readonly onModeChange: (mode: ChatMode) => void;
}

/**
 * Wire the reseat-less chat mode system (ADR-0057) for a built session — used by BOTH the `chat`/`chat-resume`
 * REPL and the 2.5.B Home's in-process chat, so the full-capability host is NEVER live without the fail-closed
 * approval regime. It builds the session-scoped mode env (the once/always cache, the governed hide-set from the
 * effective tool defs, the workspace-anchored protected-path check; the interactive prompt IS the store's
 * `requestApproval`) and **applies the initial mode immediately** — so the regime is active from the first turn
 * (default `ask` denies every governed action). The returned `onModeChange` re-applies on a Shift+Tab / `/mode`.
 */
/**
 * Whether the chat surface can answer an interactive approval prompt — the ink UI is mounted (stdout is a TTY
 * AND not `--json`), the SAME condition `selectChatDriver` (render/tui/chat-ink.tsx) picks `driveInk` on. A
 * non-interactive driver (plain non-TTY / `--json`) has nothing to answer `requestApproval`, so the mode control
 * uses a reject-immediately prompt (no deadlock, High 9). Named + exported so the derivation is unit-locked.
 */
export function chatIsInteractive(
  io: Pick<CliIo, 'stdoutIsTty'>,
  global: Pick<GlobalOptions, 'json'>,
): boolean {
  return io.stdoutIsTty && !global.json;
}

export function createChatModeControl(
  built: Pick<BuiltChatSession, 'session' | 'tools' | 'context'>,
  store: ChatStoreController,
  opts?: { readonly interactive?: boolean },
): ChatModeControl {
  // The interactive prompt is the store's `requestApproval`, answered by the ink UI / Home controller. On a
  // NON-interactive driver (plain non-TTY, or `--json`) NOTHING answers it — `store.requestApproval` would
  // return an unanswerable promise and DEADLOCK the turn (High 9). So a non-interactive session uses a
  // reject-immediately prompt: a governed dispatch in `accept-edits`/`auto` is denied (never a hang), mirroring
  // the one-shot `agent run`. `interactive` defaults true (the ink REPL + the Home are always a TTY).
  const interactive = opts?.interactive ?? true;
  const prompt: ApprovalPrompt = interactive
    ? store.requestApproval
    : () =>
        Promise.resolve({
          outcome: 'reject',
          reason: 'interactive approval is unavailable on this non-interactive driver',
        });
  const modeEnv = makeChatModeEnv({
    session: built.session,
    tools: built.tools,
    workspaceDir: built.context.workingDir,
    prompt,
  });
  applyChatMode(modeEnv, store.getSnapshot().mode);
  return {
    onAbort: () => {
      built.session.abort(); // void-returning: block body so it never forwards abort()'s return value
    },
    onModeChange: (mode) => {
      store.setMode(mode);
      applyChatMode(modeEnv, mode);
    },
  };
}

/** The slash-aware line handler + the session's cancel/stop state + the mode/abort control (ADR-0057). */
export interface ChatLineHandler extends ChatModeControl {
  /** Handle one line (a slash command or a message); awaits the turn for a message. */
  readonly processLine: (raw: string, display?: string) => Promise<void>;
  /** Emit the session's sole terminal (`session:cancelled`, idempotent) — the teardown caller fires it. */
  readonly cancelOnce: () => void;
  /** `true` once `/exit`, `/cancel`, `/clear`, or a `/models` reseat has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
  /** WHY the loop stopped (ADR-0062 §7 · ADR-0059) — `'reseat'` after a `/models` switch, `'clear'` after a `/clear`,
   *  else `'exit'`. The standalone re-drive loop swaps in a new-model / fresh session accordingly; the Home reads it
   *  to swap-in-place vs. return to the bare Home. */
  readonly stopReason: () => 'exit' | 'clear' | 'reseat';
  /** Request a mid-session model switch (ADR-0059) — sets the stop state + captures the target for the reseat. */
  readonly onReseat: (target: ReseatTarget) => void;
  /** The captured reseat target once {@link onReseat} fired (else `undefined`) — {@link driveOneSession} reads it. */
  readonly reseatTarget: () => ReseatTarget | undefined;
}

/**
 * Validate the arg tokens of a resolved REPL command against what it declares, returning a ready-to-emit
 * rejection message or `undefined` when the tokens are acceptable. Two rules: (1) every token must be a
 * declared flag or a declared positional VALUE (a zero-arg command rejects ANY token — so `/exit now` fails);
 * (2) a `{ name, values }` positional is a SINGLE value, so more than one positional-value token
 * (`/mode plan accept-edits`) is rejected rather than silently dropping the extras downstream. When the command
 * declares a positional, the rejection lists its valid values (so `/mode aggressive` teaches the names). Bad
 * tokens are sanitized (non-printable → `?`, truncated) so a crafted arg can't smuggle a control sequence.
 */
function validateSlashTokens(command: ReplCommand, tokens: readonly string[]): string | undefined {
  const flags = new Set((command.args ?? []).map((arg) => arg.flag));
  const positional = command.positional;
  const positionalValues = positional?.values ?? [];
  // A positional with an EMPTY `values` list is a FREE positional (any single token — e.g. `/trim 50`); a
  // non-empty list is a fixed allowlist (`/mode plan`). Only a fixed positional teaches its valid values.
  const freePositional = positional !== undefined && positionalValues.length === 0;
  const validHint =
    positional === undefined || freePositional ? '' : ` Valid: ${positionalValues.join(', ')}.`;
  const nonFlag = tokens.filter((token) => !flags.has(token)); // candidate positional value(s)
  // Reject a non-flag token unless it is the FREE positional's value or a declared FIXED positional value (a
  // zero-positional command rejects ANY non-flag token — so `/exit now` still fails).
  if (!freePositional) {
    const bad = nonFlag.find((token) => !positionalValues.includes(token));
    if (bad !== undefined) {
      return `/${command.name}: unknown argument '${bad.replace(/[^\x20-\x7e]/g, '?').slice(0, 32)}'.${validHint}`;
    }
  }
  // A single positional value (fixed OR free) — more than one is rejected, not silently dropped downstream.
  if (positional !== undefined && nonFlag.length > 1) {
    return `/${command.name}: takes a single ${positional.name} value (got ${nonFlag.length}).${validHint}`;
  }
  return undefined;
}

/**
 * Build the slash-aware line handler shared by the chat REPL loop (`runReplLoop`) and the 2.5.B Home's in-tree
 * chat driver: `/exit` stops; `/cancel` ends the (resumable) session AND stops; `/export` scaffolds a workflow
 * between turns; an unknown slash warns; anything else is appended + persisted + sent as a turn. The cancel/stop
 * state is internal — the caller reads it via `shouldStop` and fires the terminal via `cancelOnce` on teardown.
 */
export function createChatLineHandler(
  wiring: Pick<
    ReplWiring,
    'built' | 'opened' | 'store' | 'persister' | 'doctorProbes' | 'chatMaxMessages'
  >,
  deps: ChatReplDeps,
): ChatLineHandler {
  const { built, opened, store, persister, doctorProbes } = wiring;
  let stop = false;
  let cancelled = false;
  // Set by `/clear` (ADR-0062 §7): the loop stopped to SWAP the session, not to end the REPL — `stopReason` reports
  // it so the surface (the standalone re-drive loop, or the Home) rebuilds a fresh session instead of exiting.
  let clearRequested = false;
  // Set by a `/models` mid-session model switch (ADR-0059): like `/clear`, the loop stopped to SWAP the session —
  // but to a NEW-model session carrying the transcript, not a fresh one. `stopReason` reports `'reseat'` and the
  // surface rebuilds via the reseat path; the captured target is the picked model/provider.
  let reseatRequested: ReseatTarget | undefined;
  const cancelOnce = (): void => {
    if (!cancelled) {
      cancelled = true;
      built.session.cancel(); // the session's sole terminal (session:cancelled) — persister marks it 'ended'
    }
  };
  // Whether an interactive prompt (the ink UI / Home controller) can answer an approval — the ink view is
  // mounted (the same condition `selectChatDriver` picks driveInk on). On a non-interactive driver nothing
  // answers `requestApproval`, so the mode control uses a reject-immediately prompt (no deadlock). Also drives
  // `emitOutput` (a NOTICE in-view vs. a stderr diagnostic).
  const interactive = chatIsInteractive(deps.io, deps.global);

  // The reseat-less mode system (ADR-0057) — created HERE so both the `/mode` command (below) and the driver's
  // keys (Shift+Tab / Esc) drive the SAME control. It applies the initial `ask` mode immediately, so the
  // full-capability host is never live without the fail-closed approval regime (default `ask` denies governed).
  const modeControl = createChatModeControl(built, store, { interactive });
  const emitOutput = (text: string): void => {
    if (interactive) {
      store.notice(text);
    } else {
      deps.io.writeErr(`${text}\n`);
    }
  };

  // The lifecycle capabilities the curated REPL commands (repl-commands.ts) run over — the slash names and the
  // /help + unknown-slash hint all derive from REPL_COMMANDS, so the three surfaces can never disagree.
  const replCtx: ReplCommandContext = {
    exit: () => {
      stop = true;
    },
    cancel: () => {
      // `/cancel` ends the session TERMINALLY (session:cancelled) — its in-flight turn is aborted and
      // `chat-resume` (2.N) can reload the persisted session later. For a mid-turn abort that KEEPS the
      // session alive (Esc), use `session.abort()` (EA7, ADR-0057) — wired into the REPL in 2.5.E Step 4.
      cancelOnce();
      stop = true;
    },
    exportSession: () => {
      // Export the session-so-far to a `.relavium.yaml` scaffold (2.P, same ADR-0026 contract). It runs
      // BETWEEN turns (every completed turn is already persisted), reads the durable transcript, and writes
      // the file; it does NOT mark the row `exported` (a later turn's persist would clobber that — the
      // standalone `chat-export` command marks it). A failure is reported, never crashing the REPL.
      try {
        const result = exportSession({
          store: opened.store,
          sessionId: built.sessionId,
          cwd: deps.global.cwd,
          // Re-export overwrites the session's OWN scaffold: the default path is keyed on the unique session
          // id, so `force` here can only ever clobber this session's prior export, never another session's.
          force: true,
        });
        if (deps.global.json) {
          // Machine mode (--json, 2.Q): emit `session:exported` THROUGH the session bus, so it rides the
          // live stream's monotonic per-session sequenceNumber (a DB-derived seq would jump backward and
          // trip a consumer's gap-detection). The bus stamps sessionId/sequenceNumber/timestamp; the
          // driveJson serializer (subscribed) writes it to stdout, keeping the stream pure + complete.
          built.emitSessionEvent({ type: 'session:exported', workflowPath: result.path });
        } else {
          deps.io.writeErr(`exported session to ${result.path}\n`);
        }
      } catch (err) {
        deps.io.writeErr(`export failed: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    },
    // The curated command list — a clean in-view notice in the ink TTY, a stderr list on the plain / `--json` paths.
    help: () => {
      emitOutput(formatReplHelp().trimEnd());
    },
    // `/workflows` (2.5.C S4): the project's disk catalog. A project-less cwd is reported, not an error; the same
    // loader + scanner as `relavium list`.
    showWorkflows: () => {
      // Never crash the REPL (the discipline every slash command obeys): a config/catalog read fault (e.g. an
      // unreadable .relavium/ subdir → a CliError from discoverCatalog) becomes output, not a session-ending throw.
      try {
        const { projectConfigDir } = loadResolvedConfig({
          cwd: deps.global.cwd,
          configPath: deps.global.configPath,
        });
        if (projectConfigDir === undefined) {
          // Path-free (parity with the catch arm): the absolute cwd need not ride the REPL transcript / a screenshare.
          emitOutput('No .relavium/ project found from the current directory.');
          return;
        }
        const scan = (kind: CatalogKind): CatalogEntry[] =>
          discoverCatalog({ projectConfigDir, cwd: deps.global.cwd, kind });
        emitOutput(catalogNotice(scan('workflows'), scan('agents')));
      } catch (err) {
        // Surface the failure by its CODE — a raw catalog CliError message embeds the absolute `.relavium/` path,
        // which the REPL transcript / a screenshare need not carry.
        const reason = err instanceof CliError ? err.code : 'unexpected error';
        emitOutput(`could not list workflows: ${reason}`);
      }
    },
    // `/cost` (2.5.C S4): the session's cumulative spend (the per-model breakdown is 2.6.C).
    showCost: () => {
      emitOutput(costNotice(store.getSnapshot().state.cumulativeCostMicrocents));
    },
    // `/doctor` (2.5.C S5): a staged setup health check; `--deep` adds the network/process tier (key + MCP
    // validation). Each probe is secret-free + bounded; a thrown probe never crashes the REPL (reported as output).
    runDoctor: async (deep) => {
      // Synchronous acknowledgment that a SLOW probe started — only `--deep` validates providers + MCP (seconds);
      // the fast tier is instant, so it needs no progress line. Parity with the Home's transient 'checking…'.
      if (deep) emitOutput('doctor: validating providers + MCP…');
      try {
        emitOutput(formatDoctorReport(await runDoctorChecks(deep, doctorProbes)));
      } catch {
        // runDoctorChecks should not throw (every probe catches its own faults), so this is a defensive net.
        // Keep it generic + consistent with the Home (home-controller.ts) — never surface an internal code.
        emitOutput('doctor: check failed');
      }
    },
    // `/mode [name]` (ADR-0057): switch the chat mode, or (bare `/mode`) show the current mode + the options.
    // The dispatch already validated `modeArg` against the mode names, so a non-empty arg parses; still
    // fail-soft. Applying re-pushes the turn policy on the SAME session (no reseat), effective next turn.
    setMode: (modeArg) => {
      const requested = modeArg.trim();
      if (requested.length === 0) {
        // Bare `/mode`: show the current mode + EXPLAIN each one (a discovery affordance — the palette submits
        // this bare form), listing every mode with its one-line description and marking the active one.
        const current = store.getSnapshot().mode;
        const rows = CHAT_MODES.map(
          (m) =>
            `  ${MODE_LABEL[m].padEnd(12)} ${MODE_DESCRIPTION[m]}${m === current ? '  (current)' : ''}`,
        );
        emitOutput(`mode: ${MODE_LABEL[current]}\n${rows.join('\n')}`);
        return;
      }
      const mode = parseMode(requested);
      if (mode === undefined) {
        emitOutput(`/mode: unknown mode '${requested.replace(/[^\x20-\x7e]/g, '?').slice(0, 16)}'`);
        return;
      }
      modeControl.onModeChange(mode);
      emitOutput(`mode: ${MODE_LABEL[mode]}`);
    },
    // `/compact` (ADR-0062): model-summarise the working context. An LLM call — announce the moment, then
    // await, then report the deltas. The engine emits session:compacted (→ the persister writes the boundary
    // marker); this notice is the user-facing report. Never crashes the REPL — a failure is reported as output.
    compactHistory: async () => {
      // The engine emits `session:compacting` at the start (ADR-0062 §7): on an INTERACTIVE surface the store
      // renders a labeled "Summarizing…" moment off it, so no pre-notice is needed; on a plain/`--json` surface
      // (no live spinner) keep a one-line stderr progress note so the multi-second summary isn't a silent pause.
      // Either way `session:compacted` (→ the persister writes the boundary marker) fires and we report the RESULT.
      if (!interactive) emitOutput('compacting: summarizing the conversation…');
      try {
        emitOutput(compactionNotice(await built.session.compact('manual')));
      } catch {
        // compact() RE-THROWS an unclassified error (a bug) rather than returning {kind:'failed'} — never crash
        // the REPL (the discipline every slash command obeys); surface a static, secret-free notice instead.
        emitOutput('compaction failed unexpectedly — the conversation is unchanged.');
      } finally {
        // ALWAYS reset the moment: a failed/cancelled/no-op /compact (and an unclassified throw) emits NO
        // session:compacted|trimmed terminal, so without this the store's `compacting` flag (set by
        // session:compacting) would latch and a later slash command would render a stale "Summarizing…" spinner.
        // A SUCCESSFUL compact already cleared it via session:compacted, making this an idempotent no-op there.
        store.clearCompacting();
      }
    },
    // `/trim [n]` (ADR-0062): deterministic drop, no LLM call. Bare `/trim` uses `[chat].max_messages`; an
    // inline `n` overrides it. A missing bound (no arg + no config) is an actionable notice, never a silent no-op.
    trimHistory: (nArg) => {
      const trimmed = nArg.trim();
      const n = trimmed.length > 0 ? Number(trimmed) : wiring.chatMaxMessages;
      if (n === undefined) {
        emitOutput('/trim: set a bound — `/trim <n>` or `[chat].max_messages` in your config.');
        return;
      }
      if (!Number.isInteger(n) || n <= 0) {
        emitOutput(`/trim: <n> must be a positive whole number (got '${trimmed.slice(0, 16)}').`);
        return;
      }
      emitOutput(trimNotice(built.session.trimHistory(n)));
    },
    // `/clear` (ADR-0062 §7): end THIS conversation (persisted + resumable) and swap in a fresh session. A
    // HOST-LEVEL lifecycle swap — the handler only SIGNALS it (clearRequested + stop); the surface orchestrates the
    // teardown + fresh-session rebuild (the standalone re-drive `runReplLoop`, or the Home's `clearChat`). It does
    // NOT call cancelOnce here — the surface teardown fires the old session's sole terminal exactly once.
    // INTERACTIVE-ONLY: under `--json` / plain non-TTY there is no swap surface (one machine stream is one session
    // lifecycle, ADR-0049), so reject with an actionable hint and change nothing (stopReason stays 'exit').
    clearSession: () => {
      if (!interactive) {
        emitOutput('/clear needs an interactive terminal — start a new `relavium chat` instead.');
        return;
      }
      clearRequested = true;
      stop = true;
    },
    // `/models` on the chat surface (ADR-0059) opens the ink reseat-picker overlay — but that is intercepted at the
    // RENDER layer (ChatApp), BEFORE this core handler, so `openModels` runs ONLY on a non-interactive driver
    // (plain/`--json`), where there is no overlay. There, surface an actionable hint instead of a silent no-op: a
    // live reseat needs an interactive terminal (one machine stream stays one session lifecycle, ADR-0049); the
    // Home's `/models` is the alternative for setting the next-session default.
    openModels: () =>
      emitOutput(
        '/models needs an interactive terminal to switch the model live. From a pipe, set `[chat].default_model` ' +
          'in your config, or run `relavium` (the Home) to change the default.',
      ),
  };

  // Parse + dispatch a `/name [args]` REPL line (extracted from processLine so each stays under the Sonar
  // cognitive-complexity ceiling). Returns after emitting any error/echo through the notice channel — an
  // interactive error belongs in-view (ink), not on stderr behind the live view.
  const handleSlashCommand = async (line: string): Promise<void> => {
    // Split the post-slash string into a command name + arg tokens, so `/doctor --deep` dispatches `doctor`
    // with `['--deep']`. A zero-arg command takes no tokens (so `/exit now` is rejected), preserving the prior
    // exact-match strictness while admitting declared flags.
    const [name, ...tokens] = line.slice(1).split(/\s+/);
    const command =
      name !== undefined && name.length > 0 ? REPL_COMMANDS_BY_NAME.get(name) : undefined;
    if (command === undefined) {
      // Echo a SANITIZED form — strip non-printable bytes + truncate — so a crafted slash can't smuggle a
      // terminal control sequence (or a flood).
      const safe = line.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
      emitOutput(`unknown command '${safe}'. Available: ${replCommandList()}.`);
      return;
    }
    // Surface-scope guard (2.5.G S7): a command not `availableIn` this (chat) surface — e.g. the HOME-ONLY `/models`
    // — is rejected with an actionable pointer, never dispatched. The palette already filters by surface
    // (CHAT_PALETTE_COMMANDS); this covers a command TYPED directly, keeping the home-only next-session `/models`
    // config action distinct from the Phase-2.6 mid-chat `/models` live reseat (ADR-0059).
    if (!command.availableIn.includes('chat')) {
      emitOutput(
        `/${command.name} is available from the Home (run \`relavium\` with no arguments), not inside a chat.`,
      );
      return;
    }
    const rejection = validateSlashTokens(command, tokens);
    if (rejection !== undefined) {
      emitOutput(rejection);
      return;
    }
    await command.run(replCtx, tokens); // may be async (/cost, /doctor); never fire-and-forget
  };

  const processLine = async (raw: string, display?: string): Promise<void> => {
    const line = raw.trim();
    if (line.length === 0) return;
    if (line.startsWith('/')) {
      await handleSlashCommand(line);
      return;
    }
    // `display` is the COMPACT transcript form (prose + chip note) when a message carried `@`/`!` attachments; the
    // model + the durable transcript get the full framed `line` (resume fidelity), the live transcript the compact one.
    store.appendUser(display ?? line);
    persister.beginUserTurn(line);
    await built.session.sendMessage(line);
  };

  return {
    processLine,
    cancelOnce,
    shouldStop: () => stop,
    // Priority: a reseat is a swap-to-new-model, a clear is a swap-to-fresh, else the REPL ends. A `/models` reseat
    // and a `/clear` are mutually exclusive in one settle (each sets `stop`), but order the check so an explicit
    // reseat is never mis-read as a clear.
    stopReason: () => (reseatRequested !== undefined ? 'reseat' : clearRequested ? 'clear' : 'exit'),
    onReseat: (target) => {
      reseatRequested = target;
      stop = true;
    },
    reseatTarget: () => reseatRequested,
    onAbort: modeControl.onAbort,
    onModeChange: modeControl.onModeChange,
  };
}

/**
 * Build a FRESH chat wiring — a new {@link AgentSession} + view store + persister + doctor probes over the SHARED
 * `history.db` handle — for the `/clear` (ADR-0062 §7) re-drive rebuild. The bound `agent` is reused verbatim (no
 * disk re-read), MCP reconnects fresh, and the store/totals start empty; the `intro` carries the {@link clearedNotice}
 * that surfaces the prior (still-resumable) session. Mirrors the initial-build acquire-then-teardown-on-failure guard
 * so a persister-construction throw never leaks the just-spawned MCP children. The SHARED `opened` is NOT this
 * function's to close — the caller's outer {@link runReplLoop} finally owns it across every swap.
 */
interface FreshChatWiringDeps {
  readonly chat: BuildChatSessionOptions['chat'];
  readonly agent: AgentDefinition;
  readonly cwd: string;
  readonly projectConfigDir: string | undefined;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly providers: ProviderResolver;
  readonly mcpSecretResolver: McpSecretResolver;
  readonly mcpRegistrations: BuildChatSessionOptions['mcpRegistrations'];
  readonly configPath: string | undefined;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly opened: OpenedSessionStore;
  readonly buildSession: typeof buildChatSession;
  readonly onBudgetWarning: NonNullable<BuildChatSessionOptions['onBudgetWarning']>;
}

async function buildFreshChatWiring(deps: FreshChatWiringDeps, intro: string): Promise<ReplWiring> {
  // Re-read the ADR-0065 §2 user-pricing overlay FRESH from the shared db on each `/clear` rebuild (2.5.G S10) — so
  // a `models pricing` write made in another terminal mid-session takes effect on the very next `/clear` session,
  // the SAME freshness guarantee `readEffectiveDefault()` gives the default model (and the Home already gives
  // pricing). Non-fatal (empty map on a read fault). Empty ⇒ omitted (unknown models degrade to allow, unchanged).
  const resolvePrice = readUserPricingOverlay(deps.opened.db);
  const built = await deps.buildSession({
    chat: deps.chat,
    agent: deps.agent,
    agentRef: deps.agent.id, // ignored when `agent` is set, but the option key is required
    cwd: deps.cwd,
    projectConfigDir: deps.projectConfigDir,
    now: deps.now,
    uuid: deps.uuid,
    providers: deps.providers,
    mcpSecretResolver: deps.mcpSecretResolver,
    ...(deps.mcpRegistrations === undefined ? {} : { mcpRegistrations: deps.mcpRegistrations }),
    ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
    onBudgetWarning: deps.onBudgetWarning,
  });
  surfaceMcpSkipped(deps.io, built.mcpSkipped);
  const store = createChatStore(deps.global.color);
  let persister: SessionPersister;
  try {
    persister = createSessionPersister({
      store: deps.opened.store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now: deps.now,
      uuid: deps.uuid,
      // ADR-0059 attribution — resolved over the SAME shared db (a `/clear` rebuild re-reads it fresh).
      resolveModelCatalogId: makeCatalogIdResolver(deps.opened.db, { uuid: deps.uuid, now: deps.now }),
    });
  } catch (err) {
    // Acquire-then-guard: the fresh MCP children are already spawned — reclaim them before the failure propagates
    // so a persister-construction throw never orphans a stdio child (best-effort; never mask the primary error).
    await built.closeMcp?.().catch(() => undefined);
    throw err;
  }
  const doctorProbes = assembleDoctorProbes({
    cwd: deps.cwd,
    ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
    resolver: deps.providers,
    agentMcpServers: built.agent.mcp_servers ?? [],
    mcpSkipped: built.mcpSkipped,
  });
  return {
    built,
    opened: deps.opened,
    store,
    persister,
    doctorProbes,
    startSession: () => built.session.start(),
    intro,
    modelPicker: buildChatModelsPort(deps.opened, deps.providers, built.agent.model, deps.now, deps.uuid),
    ...(deps.chat.maxMessages === undefined ? {} : { chatMaxMessages: deps.chat.maxMessages }),
  };
}

/**
 * Build the `/clear` re-drive rebuild closure (ADR-0062 §7) — SHARED by `chat` and `chat-resume` so the rebuild
 * CONTRACT (the {@link FreshChatWiringDeps} assembly + the {@link buildFreshChatWiring} call) lives in ONE place and
 * cannot drift between them. Given the current session's bound agent + the command's capability inputs, it returns a
 * `(oldSessionId) => Promise<ReplWiring>` that assembles a FRESH session over the SAME agent + SHARED db, its intro
 * the {@link clearedNotice} naming the prior (still-resumable) session.
 */
function createClearRebuild(params: {
  readonly chat: BuildChatSessionOptions['chat'];
  readonly agent: AgentDefinition;
  readonly projectConfigDir: string | undefined;
  readonly now: () => number;
  readonly uuid: () => string;
  readonly providers: ProviderResolver;
  readonly mcpSecretResolver: McpSecretResolver;
  readonly mcpRegistrations: BuildChatSessionOptions['mcpRegistrations'];
  readonly opened: OpenedSessionStore;
  readonly buildSession: typeof buildChatSession;
  readonly io: CliIo;
  readonly global: GlobalOptions;
}): (oldSessionId: string) => Promise<ReplWiring> {
  const wiringDeps: FreshChatWiringDeps = {
    chat: params.chat,
    agent: params.agent,
    cwd: params.global.cwd,
    projectConfigDir: params.projectConfigDir,
    now: params.now,
    uuid: params.uuid,
    providers: params.providers,
    mcpSecretResolver: params.mcpSecretResolver,
    mcpRegistrations: params.mcpRegistrations,
    configPath: params.global.configPath,
    io: params.io,
    global: params.global,
    opened: params.opened,
    buildSession: params.buildSession,
    onBudgetWarning: (warning) =>
      params.io.writeErr(
        `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
      ),
  };
  return (oldSessionId) => buildFreshChatWiring(wiringDeps, clearedNotice(oldSessionId));
}

/**
 * Seed the view store + persister for a RESUMED session — the SAME assembly both `chat-resume` (2.N) and the
 * `/models` reseat (ADR-0059) need: a store pre-seeded with the carried model + cumulative cost/turns (a resumed
 * session never re-emits `session:started`, so without this the footer shows nothing until the first new turn), and
 * a persister continuing the durable transcript past its last `sequenceNumber`. One home so the two resume paths can
 * never wire different seeds.
 */
function seedResumedWiring(
  resumed: BuiltResumedChatSession,
  opened: OpenedSessionStore,
  color: boolean,
  now: () => number,
  uuid: () => string,
): { store: ChatStoreController; persister: SessionPersister } {
  const store = createChatStore(color, {
    agentRef: resumed.agent.id,
    model: resumed.agent.model,
    cumulativeCostMicrocents: resumed.resumeState.cumulativeCostMicrocents,
    turnCount: resumed.resumeState.turnCount,
  });
  const persister = createSessionPersister({
    store: opened.store,
    handle: resumed.handle,
    sessionId: resumed.sessionId,
    agent: resumed.agent,
    context: resumed.context,
    now,
    uuid,
    // Continue the durable transcript past its last sequence number (start() adopts the row + its totals).
    initialSequenceNumber: resumed.nextSequenceNumber,
    // ADR-0059 attribution — resolved over the SAME db; a reseat's new persister records the switched model.
    resolveModelCatalogId: makeCatalogIdResolver(opened.db, { uuid, now }),
  });
  return { store, persister };
}

/** The deps `createReseatRebuild` closes over — the capability inputs to rebuild a resumed, model-swapped session
 *  over the SHARED db. Mirrors {@link FreshChatWiringDeps} but RESUMES (carries the transcript) instead of starting
 *  fresh, and swaps the bound model (so it has no fixed `agent` — the agent is loaded from the just-ended record). */
interface ReseatWiringDeps {
  readonly chat: BuildChatSessionOptions['chat'];
  readonly now: () => number;
  readonly uuid: () => string;
  readonly providers: ProviderResolver;
  readonly mcpSecretResolver: McpSecretResolver;
  readonly mcpRegistrations: BuildChatSessionOptions['mcpRegistrations'];
  readonly configPath: string | undefined;
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly opened: OpenedSessionStore;
  readonly buildResumedSession: typeof buildResumedChatSession;
  readonly onBudgetWarning: NonNullable<BuildChatSessionOptions['onBudgetWarning']>;
}

/**
 * Rebuild a RESUMED session bound to a NEW model (ADR-0059 reseat). The just-ended session's transcript is reloaded
 * from the SHARED db and continued under a fresh `AgentSession.resume` bound to `target` — a NEW instance, honoring
 * ADR-0024's one-model-per-lifetime rule. The bound agent's `model`/`provider` are swapped to the picked pair and
 * its `fallback_chain` is DROPPED (it belonged to the original model; the new instance memoizes the default plan for
 * `target`, exactly as a fresh session on `target` would build). The user-pricing overlay is re-read FRESH from the
 * shared db so a mid-session `models pricing` write applies. Mirrors {@link buildFreshChatWiring}'s acquire-then-guard
 * so a persister-construction throw never orphans the just-spawned MCP children. The SHARED `opened` is NOT this
 * function's to close — the caller's outer {@link runReplLoop} finally owns it across every swap.
 */
async function buildReseatWiring(
  deps: ReseatWiringDeps,
  oldSessionId: string,
  target: ReseatTarget,
): Promise<ReplWiring> {
  const loaded = deps.opened.store.loadFull(oldSessionId);
  if (loaded === undefined || loaded.session.agentSnapshot === undefined) {
    // The session we just drove is gone / has no snapshot — cannot resume it under a new model. Loud: runReplLoop
    // surfaces it and the prior conversation stays resumable (it was persisted before this fault).
    throw new CliError(
      'invalid_invocation',
      `cannot switch model: session ${oldSessionId} could not be reloaded for reseat`,
    );
  }
  // Swap the bound model/provider (dropping the original fallback_chain) via the shared ADR-0059 rule.
  const newAgent = swapAgentModel(loaded.session.agentSnapshot, target.modelId, target.provider);
  // The record the resumed session rebinds from: the just-ended row with the model-swapped agent snapshot.
  // (The row's own `modelId` FK column stays as-is — per-message/session `modelId` attribution is deferred with
  // the 2.6.C cost breakdown; see persister.ts. `reconstructSessionState` reads only the transcript + cost here.)
  const record: AgentSessionRecord = { ...loaded.session, agentSnapshot: newAgent };
  // Re-read the user-pricing overlay FRESH from the shared db (mirrors buildFreshChatWiring) so a mid-session
  // `models pricing` write applies to the reseated session. Empty ⇒ omitted (unknown models degrade to allow).
  const resolvePrice = readUserPricingOverlay(deps.opened.db);
  const resumed = await deps.buildResumedSession({
    chat: deps.chat,
    record,
    messages: loaded.messages,
    now: deps.now,
    providers: deps.providers,
    mcpSecretResolver: deps.mcpSecretResolver,
    ...(deps.mcpRegistrations === undefined ? {} : { mcpRegistrations: deps.mcpRegistrations }),
    ...(resolvePrice.size === 0 ? {} : { resolvePrice }),
    onBudgetWarning: deps.onBudgetWarning,
  });
  surfaceMcpSkipped(deps.io, resumed.mcpSkipped);
  let seeded: { store: ChatStoreController; persister: SessionPersister };
  try {
    seeded = seedResumedWiring(resumed, deps.opened, deps.global.color, deps.now, deps.uuid);
  } catch (err) {
    // Acquire-then-guard: the resumed session's MCP children are already spawned — reclaim them before the failure
    // propagates so a persister-construction throw never orphans a stdio child (best-effort; never mask the primary).
    await resumed.closeMcp?.().catch(() => undefined);
    throw err;
  }
  const doctorProbes = assembleDoctorProbes({
    cwd: deps.global.cwd,
    ...(deps.configPath === undefined ? {} : { configPath: deps.configPath }),
    resolver: deps.providers,
    agentMcpServers: resumed.agent.mcp_servers ?? [],
    mcpSkipped: resumed.mcpSkipped,
  });
  return {
    built: resumed,
    opened: deps.opened,
    store: seeded.store,
    persister: seeded.persister,
    doctorProbes,
    // A resumed session already landed at idle inside AgentSession.resume; start() would throw + re-emitting
    // session:started would double a terminal-less lifecycle event — so startSession is a no-op (like chat-resume).
    startSession: () => {},
    intro: modelSwitchNotice(target.modelId, resumed.resumeState.turnCount),
    // The picker's `boundModel` is now the SWITCHED model — a further reseat marks it as the ✓ "you are here".
    modelPicker: buildChatModelsPort(deps.opened, deps.providers, resumed.agent.model, deps.now, deps.uuid),
    ...(deps.chat.maxMessages === undefined ? {} : { chatMaxMessages: deps.chat.maxMessages }),
  };
}

/**
 * Build the `/models` reseat rebuild closure (ADR-0059) — SHARED by `chat` and `chat-resume` so the reseat CONTRACT
 * lives in ONE place and cannot drift. Given the command's capability inputs, it returns a
 * `(oldSessionId, target) => Promise<ReplWiring>` that reloads the just-ended session's transcript and resumes it
 * under a new-model agent over the SHARED db.
 */
function createReseatRebuild(params: {
  readonly chat: BuildChatSessionOptions['chat'];
  readonly now: () => number;
  readonly uuid: () => string;
  readonly providers: ProviderResolver;
  readonly mcpSecretResolver: McpSecretResolver;
  readonly mcpRegistrations: BuildChatSessionOptions['mcpRegistrations'];
  readonly opened: OpenedSessionStore;
  readonly buildResumedSession: typeof buildResumedChatSession;
  readonly io: CliIo;
  readonly global: GlobalOptions;
}): (oldSessionId: string, target: ReseatTarget) => Promise<ReplWiring> {
  const wiringDeps: ReseatWiringDeps = {
    chat: params.chat,
    now: params.now,
    uuid: params.uuid,
    providers: params.providers,
    mcpSecretResolver: params.mcpSecretResolver,
    mcpRegistrations: params.mcpRegistrations,
    configPath: params.global.configPath,
    io: params.io,
    global: params.global,
    opened: params.opened,
    buildResumedSession: params.buildResumedSession,
    onBudgetWarning: (warning) =>
      params.io.writeErr(
        `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
      ),
  };
  return (oldSessionId, target) => buildReseatWiring(wiringDeps, oldSessionId, target);
}

/**
 * Drive ONE session to its stop (`/exit`, `/cancel`, `/clear`, or EOF) and tear it down — the per-session unit the
 * re-drive {@link runReplLoop} runs once per conversation. Its finally fires the session's sole terminal
 * (`cancelOnce`, idempotent → the row flips to 'ended', still resumable), closes the persister, and tears the MCP
 * connections down — but NOT the shared db (the loop owns it across swaps). Returns the driver's outcome so the loop
 * can decide between ending and re-driving over a fresh session (`/clear`).
 */
async function driveOneSession(wiring: ReplWiring, deps: ChatReplDeps): Promise<ChatDriveOutcome> {
  const { built, store, persister, startSession, intro } = wiring;
  const { processLine, cancelOnce, shouldStop, stopReason, onReseat, reseatTarget, onAbort, onModeChange } =
    createChatLineHandler(wiring, deps);
  // A live reseat is TTY-interactive only (like `/clear`): the ink model-picker overlay is the sole trigger, and a
  // plain/`--json` driver has no picker. Wiring `onReseat` only on an interactive driver means `stopReason()` can
  // never yield `'reseat'` under `--json`/plain — one machine stream stays one session lifecycle (ADR-0049).
  const reseatEnabled = chatIsInteractive(deps.io, deps.global);

  // The `@`-mention completion reader (2.5.D, ADR-0061): a READ-ONLY fs jail at the SAME fs-scope tier + workspace
  // as the session's tools, so `@`-completion browses + injects through the identical confidentiality floor +
  // listing-gate (a `.ssh`/`.env` entry is never listed nor read). READ-ONLY by construction — the mention path
  // never writes. TTY-only: an interactive driver wires the completion; a plain/`--json` driver treats a leading
  // `@` as a literal, so it needs no reader. Building it is pure (no I/O).
  const mentionReader = ((): MentionReader | undefined => {
    if (!chatIsInteractive(deps.io, deps.global)) return undefined;
    const fsArm = assembleToolEnv({
      profile: 'chat-read-only',
      fsScopeTier: built.context.fsScopeTier,
      workspaceDir: built.context.workingDir,
    }).host.fs;
    return fsArm === undefined ? undefined : createMentionReader(fsArm);
  })();

  // The `!`-shell runner (2.5.D step 5, ADR-0061) — a thin wrapper over the session's `runUserCommand`. TTY-only.
  const runShellCommand = chatIsInteractive(deps.io, deps.global)
    ? (command: string, args: readonly string[]): Promise<UserCommandOutcome> =>
        built.session.runUserCommand(command, args)
    : undefined;

  // persister.start() subscribes for the turn events + adopts/inserts the session row; it does NOT consume
  // session:started, so it is safe before the driver. The session-open action (fresh start() / resume no-op)
  // is deferred to startSession() INSIDE the driver, after the driver has subscribed the view store.
  try {
    persister.start();
    const outcome = await (deps.drive ?? drivePlain)({
      startSession,
      processLine,
      shouldStop,
      stopReason,
      handle: built.handle,
      store,
      io: deps.io,
      global: deps.global,
      // A headless driver flushes the terminal (session:cancelled) before unsubscribing; the finally's cancelOnce
      // below is then a no-op (idempotent). Other drivers ignore it — the finally fires it.
      finalize: cancelOnce,
      // The ink driver's second-SIGINT hard `process.exit` bypasses the finally below — give it a best-effort MCP
      // teardown to run first so a forced quit never orphans a spawned stdio child (no-op when no servers).
      ...(built.closeMcp === undefined ? {} : { onForceExit: built.closeMcp }),
      ...(intro === undefined ? {} : { intro }),
      onAbort,
      onModeChange,
      // The reseat trigger (onReseat) + its picker are wired together, interactive-only: the ink overlay reads the
      // catalog through `modelPicker` and calls `onReseat` on accept. A plain/`--json` driver gets neither.
      ...(reseatEnabled ? { onReseat } : {}),
      ...(reseatEnabled && wiring.modelPicker !== undefined ? { modelPicker: wiring.modelPicker } : {}),
      ...(mentionReader === undefined ? {} : { mentionReader }),
      ...(runShellCommand === undefined ? {} : { runShellCommand }),
    });
    // A `/models` reseat: the driver returns `{ kind: 'reseat' }` (from `stopReason()`); attach the captured target
    // HERE — the one place holding the line handler — so every driver stays target-agnostic. A missing target
    // (never expected: `onReseat` always captures one) degrades to a plain end rather than a broken rebuild loop.
    if (outcome.kind === 'reseat') {
      const target = reseatTarget();
      return target === undefined ? { kind: 'exit' } : { kind: 'reseat', target };
    }
    return outcome;
  } finally {
    cancelOnce(); // emit the terminal even on /exit, /clear, or EOF (idempotent); flips the row to 'ended'
    // Attempt EVERY teardown step (a reject in one must not skip the next) and never let a cleanup fault mask the
    // outcome — each is best-effort, surfacing a warning rather than throwing. MCP tears down LAST, AFTER the
    // session terminal, so no tool call can race the close (idempotent; present only with `mcp_servers`).
    closeQuietly(deps.io, 'persister', () => persister.close());
    await built.closeMcp?.().catch((e: unknown) => warnTeardown(deps.io, 'MCP', e));
  }
}

/**
 * The shared REPL loop driving both `chat` (fresh) and `chat-resume` (2.N). It drives the CURRENT session to its
 * stop ({@link driveOneSession}) and, on a swap outcome (TTY-interactive only), rebuilds over the SAME db and
 * re-drives — a `/clear` (ADR-0062 §7) rebuilds a FRESH session, a `/models` reseat (ADR-0059) rebuilds a NEW-model
 * session carrying the transcript — otherwise it ends. The shared `history.db` handle survives every swap and is
 * closed exactly ONCE in the outer finally; each session's own teardown (terminal + persister + MCP) is owned by
 * `driveOneSession`. `/exit`, `/cancel`, and an input EOF all end the session with **exit code 4**.
 */
async function runReplLoop(
  wiring: ReplWiring,
  deps: ChatReplDeps,
  rebuild?: (oldSessionId: string) => Promise<ReplWiring>,
  reseatRebuild?: (oldSessionId: string, target: ReseatTarget) => Promise<ReplWiring>,
): Promise<ExitCode> {
  // The SHARED db handle — the same across every swap (a fresh / reseated session reuses it), closed ONCE below.
  const opened = wiring.opened;
  let current = wiring;
  try {
    for (;;) {
      const outcome = await driveOneSession(current, deps);
      // The old session is ALREADY torn down (driveOneSession's finally fired its terminal → the row is 'ended' +
      // resumable). Resolve the rebuild for this swap kind (both /clear + reseat are TTY-only; a non-TTY outcome is
      // always 'exit'), or leave `next` unset to END the REPL. The target is captured into a const so the closure
      // keeps its narrowed (non-undefined) type — no unsafe non-null assertion.
      const oldSessionId = current.built.sessionId;
      let next: (() => Promise<ReplWiring>) | undefined;
      if (outcome.kind === 'clear' && rebuild !== undefined) {
        next = () => rebuild(oldSessionId);
      } else if (outcome.kind === 'reseat' && reseatRebuild !== undefined && outcome.target !== undefined) {
        const target = outcome.target;
        next = () => reseatRebuild(oldSessionId, target);
      }
      if (next === undefined) break;
      // Build the swap session over the same db and re-drive; a build failure is surfaced actionably (the prior
      // conversation is still resumable) and ends the REPL rather than looping on a broken build.
      try {
        current = await next();
      } catch (err) {
        deps.io.writeErr(
          // Sanitize the error text too (not just the id beside it) — a rebuild fault can rethrow an unclassified
          // message verbatim (session-host.ts), which could carry an ANSI/OSC escape from a spawned MCP server's
          // error text; strip it exactly as the id + every other display string on this surface is stripped.
          `could not start a new session after ${outcome.kind === 'reseat' ? 'a model switch' : '/clear'}: ` +
            `${sanitizeInline(err instanceof Error ? err.message : String(err))}. ` +
            `Your previous conversation is saved — resume it with \`relavium chat-resume ${sanitizeInline(oldSessionId)}\`.\n`,
        );
        break;
      }
    }
  } finally {
    // The shared db closes exactly once, after the last session's own teardown — never per-swap (that would strand
    // the next session), never skipped (best-effort; a close fault warns rather than masking the loop outcome).
    closeQuietly(deps.io, 'session store', () => opened.close());
  }
  // `/exit`, `/cancel`, an input EOF, and a `/clear` whose rebuild failed all END the chat — the canonical code.
  return EXIT_CODES.chatEnded;
}

/**
 * The default, **plain** (non-TTY) driver: a line loop over stdin with a streamed-token printer. Used when no
 * TTY is attached (a pipe / CI without `--json`, which is 2.Q); the TTY ink driver overrides `deps.drive`.
 */
export async function drivePlain(ctx: ChatDriveContext): Promise<ChatDriveOutcome> {
  const unsubscribe = ctx.handle.subscribe(makePlainPrinter(ctx.io));
  const rl = createInterface({ input: ctx.io.stdin, terminal: false });
  // Ctrl-C (cooked mode here, unlike the raw-mode ink path) closes the input so the loop ends and the
  // command's finally runs cancelOnce() + close() — the session is marked 'ended', never left orphaned 'active'.
  const onSigint = (): void => rl.close();
  process.once('SIGINT', onSigint);
  try {
    ctx.io.writeOut(`${ctx.intro ?? 'relavium chat — type a message, or /exit to quit.'}\n`);
    ctx.startSession(); // subscription wired above ⇒ session:started is observed (fresh), or a no-op (resume)
    for await (const line of rl) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
    unsubscribe();
  }
  // A plain (non-TTY) session is not interactive, so `/clear` is gated off — `stopReason()` is always `'exit'`.
  return { kind: ctx.stopReason() };
}

/**
 * The **`--json`** (2.Q) headless driver: the machine analogue of `relavium run --json`. Messages are read
 * from stdin one user turn per line; every session-stream event (`session:*` + the per-turn `agent:*` /
 * `cost:updated`) is serialized verbatim as one NDJSON line on **stdout**, each carrying the `sessionId`
 * ([ADR-0049](../../../docs/decisions/0049-cli-machine-output-contract.md)). Diagnostics (unknown-slash,
 * /export) stay on stderr, so stdout is a pure `SessionEvent` stream. An input-stream EOF ends the session
 * (exit code 4, like the REPL). No banner — the first line is the `session:started` event.
 */
export async function driveJson(ctx: ChatDriveContext): Promise<ChatDriveOutcome> {
  const unsubscribe = ctx.handle.subscribe((event) =>
    ctx.io.writeOut(`${JSON.stringify(event)}\n`),
  );
  const rl = createInterface({ input: ctx.io.stdin, terminal: false });
  const onSigint = (): void => rl.close();
  process.once('SIGINT', onSigint);
  try {
    ctx.startSession(); // subscription wired above ⇒ the synchronous session:started is the first NDJSON line
    for await (const line of rl) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
  } finally {
    process.removeListener('SIGINT', onSigint);
    rl.close();
    // Flush session:cancelled BEFORE unsubscribing, so the NDJSON stream includes its sole terminal event.
    ctx.finalize?.();
    unsubscribe();
  }
  // `--json` is a machine stream, not interactive, so `/clear` is gated off — `stopReason()` is always `'exit'`
  // (one stdout stream stays one session lifecycle, ADR-0049).
  return { kind: ctx.stopReason() };
}

/**
 * A plain event printer for the non-TTY surface — streams the assistant tokens and annotates tool calls, both
 * SECRET-FREE (only the token text the model produced + the namespaced tool id, never tool arguments).
 */
export function makePlainPrinter(io: CliIo): (event: SessionStreamHandleEvent) => void {
  return (event) => {
    switch (event.type) {
      case 'agent:token':
        // Sanitize the model's tokens before they reach the terminal (no ANSI/OSC/control injection).
        io.writeOut(stripTerminalControls(event.token));
        return;
      case 'agent:tool_call': {
        const annotation = formatToolCall({
          id: `tc-${event.sequenceNumber}`,
          toolId: event.toolId,
          resolved: false,
        });
        io.writeOut(`\n${annotation}\n`);
        return;
      }
      case 'session:turn_completed':
        io.writeOut(event.error === undefined ? '\n' : `\n[turn failed: ${event.error.code}]\n`);
        return;
      default:
        return;
    }
  };
}
