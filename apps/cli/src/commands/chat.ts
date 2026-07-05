import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import {
  DEFAULT_SESSION_MAX_TURNS,
  type AgentDefinition,
  type SessionHandle,
  type SessionStreamHandleEvent,
  type UserCommandOutcome,
} from '@relavium/core';
import { exportSession } from '../chat/export.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../chat/doctor.js';
import { assembleDoctorProbes } from '../chat/doctor-host.js';
import {
  catalogNotice,
  clearedNotice,
  compactionNotice,
  costNotice,
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
import { createSessionPersister, type SessionPersister } from '../chat/persister.js';
import {
  buildChatSession,
  buildResumedChatSession,
  type BuildChatSessionOptions,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { assembleToolEnv } from '../engine/tool-host/assemble.js';
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

/** What an interactive driver receives — the command core's seam, so a driver never touches the session directly. */
export interface ChatDriveContext {
  /**
   * Open the session — call this AS THE FIRST ACT inside the driver, AFTER it has wired its stream
   * subscription, so the synchronous `session:started` (which carries the model) is observed, not raced.
   */
  readonly startSession: () => void;
  /** Handle one line of user input (a slash command or a chat message). Awaits the turn for a message. */
  readonly processLine: (line: string, display?: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` (or `/clear`) has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
  /**
   * WHY the driver's input loop ended (ADR-0062 §7) — `'exit'` (`/exit`, `/cancel`, or an input EOF) or `'clear'`
   * (`/clear`, TTY-interactive only). The driver returns `{ kind: ctx.stopReason() }`; the standalone re-drive loop
   * ({@link runReplLoop}) reads a `'clear'` to swap in a FRESH session. The `/clear` interactive gate keeps
   * `stopReason()` at `'exit'` under `--json` / plain non-TTY, so those drivers only ever return `'exit'`.
   */
  readonly stopReason: () => 'exit' | 'clear';
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
 * How a {@link ChatDriver}'s input loop ended (ADR-0062 §7): `'exit'` ends the REPL (exit 4); `'clear'` tells the
 * standalone {@link runReplLoop} to tear the current session down and re-drive over a FRESH one. A `/clear` is
 * TTY-interactive only, so `--json` / plain drivers only ever return `'exit'`.
 */
export interface ChatDriveOutcome {
  readonly kind: 'exit' | 'clear';
}
export type ChatDriver = (ctx: ChatDriveContext) => Promise<ChatDriveOutcome>;

export interface ChatCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests inject a scripted provider via providers). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
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
  });

  return runReplLoop(
    {
      built,
      opened,
      store,
      persister,
      doctorProbes,
      startSession: () => built.session.start(),
      ...(config.chat.maxMessages === undefined
        ? {}
        : { chatMaxMessages: config.chat.maxMessages }),
    },
    deps,
    rebuild,
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
    const resumed = await (deps.buildResumedSession ?? buildResumedChatSession)({
      chat: config.chat,
      record: loaded.session,
      messages: loaded.messages,
      now,
      providers,
      mcpSecretResolver,
      mcpRegistrations: config.mcpServers,
      onBudgetWarning: (warning) =>
        deps.io.writeErr(
          `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
        ),
    });
    closeMcp = resumed.closeMcp;
    surfaceMcpSkipped(deps.io, resumed.mcpSkipped);
    built = resumed;
    // Seed the view header: a resumed session never re-emits `session:started`, so without this the footer
    // would show no model and zero cost/turns until the first new turn (the durable record is unaffected).
    store = createChatStore(deps.global.color, {
      agentRef: resumed.agent.id,
      model: resumed.agent.model,
      cumulativeCostMicrocents: resumed.resumeState.cumulativeCostMicrocents,
      turnCount: resumed.resumeState.turnCount,
    });
    persister = createSessionPersister({
      store: opened.store,
      handle: resumed.handle,
      sessionId: resumed.sessionId,
      agent: resumed.agent,
      context: resumed.context,
      now,
      uuid,
      // Continue the durable transcript past its last sequence number (start() adopts the row + its totals).
      initialSequenceNumber: resumed.nextSequenceNumber,
    });
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
      ...(config.chat.maxMessages === undefined
        ? {}
        : { chatMaxMessages: config.chat.maxMessages }),
    },
    deps,
    rebuild,
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
  /** `true` once `/exit`, `/cancel`, or `/clear` has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
  /** WHY the loop stopped (ADR-0062 §7) — `'clear'` after a `/clear`, else `'exit'`. The standalone re-drive loop
   *  swaps in a fresh session on `'clear'`; the Home reads it to swap-in-place vs. return to the bare Home. */
  readonly stopReason: () => 'exit' | 'clear';
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
    stopReason: () => (clearRequested ? 'clear' : 'exit'),
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
 * Drive ONE session to its stop (`/exit`, `/cancel`, `/clear`, or EOF) and tear it down — the per-session unit the
 * re-drive {@link runReplLoop} runs once per conversation. Its finally fires the session's sole terminal
 * (`cancelOnce`, idempotent → the row flips to 'ended', still resumable), closes the persister, and tears the MCP
 * connections down — but NOT the shared db (the loop owns it across swaps). Returns the driver's outcome so the loop
 * can decide between ending and re-driving over a fresh session (`/clear`).
 */
async function driveOneSession(wiring: ReplWiring, deps: ChatReplDeps): Promise<ChatDriveOutcome> {
  const { built, store, persister, startSession, intro } = wiring;
  const { processLine, cancelOnce, shouldStop, stopReason, onAbort, onModeChange } =
    createChatLineHandler(wiring, deps);

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
    return await (deps.drive ?? drivePlain)({
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
      ...(mentionReader === undefined ? {} : { mentionReader }),
      ...(runShellCommand === undefined ? {} : { runShellCommand }),
    });
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
 * stop ({@link driveOneSession}) and, on a `/clear` outcome (ADR-0062 §7, TTY-interactive only), rebuilds a FRESH
 * session over the SAME db and re-drives — otherwise it ends. The shared `history.db` handle survives every swap
 * and is closed exactly ONCE in the outer finally; each session's own teardown (terminal + persister + MCP) is
 * owned by `driveOneSession`. `/exit`, `/cancel`, and an input EOF all end the session with **exit code 4**.
 */
async function runReplLoop(
  wiring: ReplWiring,
  deps: ChatReplDeps,
  rebuild?: (oldSessionId: string) => Promise<ReplWiring>,
): Promise<ExitCode> {
  // The SHARED db handle — the same across every /clear swap (a fresh session reuses it), closed ONCE below.
  const opened = wiring.opened;
  let current = wiring;
  try {
    for (;;) {
      const outcome = await driveOneSession(current, deps);
      // Only a TTY `/clear` yields 'clear' (the gate rejects it under `--json`/plain); with no rebuild wired, end.
      if (outcome.kind !== 'clear' || rebuild === undefined) break;
      // The old session is ALREADY torn down (driveOneSession's finally fired its terminal → the row is 'ended' +
      // resumable). Build the fresh session over the same db and re-drive; a build failure is surfaced actionably
      // (the prior conversation is still resumable) and ends the REPL rather than looping on a broken build.
      const oldSessionId = current.built.sessionId;
      try {
        current = await rebuild(oldSessionId);
      } catch (err) {
        deps.io.writeErr(
          // Sanitize the error text too (not just the id beside it) — a rebuild fault can rethrow an unclassified
          // message verbatim (session-host.ts), which could carry an ANSI/OSC escape from a spawned MCP server's
          // error text; strip it exactly as the id + every other display string on this surface is stripped.
          `could not start a fresh session after /clear: ${sanitizeInline(err instanceof Error ? err.message : String(err))}. ` +
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
