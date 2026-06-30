import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import {
  DEFAULT_SESSION_MAX_TURNS,
  type SessionHandle,
  type SessionStreamHandleEvent,
} from '@relavium/core';
import { exportSession } from '../chat/export.js';
import { formatDoctorReport, runDoctorChecks, type DoctorProbes } from '../chat/doctor.js';
import { assembleDoctorProbes } from '../chat/doctor-host.js';
import { catalogNotice, costNotice } from '../chat/repl-info.js';
import { discoverCatalog, type CatalogEntry, type CatalogKind } from '../workflows/catalog.js';
import {
  formatReplHelp,
  replCommandList,
  REPL_COMMANDS_BY_NAME,
  type ReplCommandContext,
} from './repl-commands.js';
import { createSessionPersister, type SessionPersister } from '../chat/persister.js';
import {
  buildChatSession,
  buildResumedChatSession,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
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
  readonly processLine: (line: string) => Promise<void>;
  /** `true` once `/exit` or `/cancel` has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
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
}
export type ChatDriver = (ctx: ChatDriveContext) => Promise<void>;

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

  return runReplLoop(
    { built, opened, store, persister, doctorProbes, startSession: () => built.session.start() },
    deps,
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

  const { config, homeDir } = loadResolvedConfig({
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

  // A resumed session already landed at idle inside `AgentSession.resume`; calling start() would throw and
  // re-emitting `session:started` would double a terminal-less lifecycle event — so startSession is a no-op.
  return runReplLoop(
    { built, opened, store, persister, doctorProbes, startSession: () => {}, intro },
    deps,
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
}

/**
 * The shared REPL loop driving both `chat` (fresh) and `chat-resume` (2.N): wire the slash-command/message
 * `processLine`, start the persister, hand control to the injected {@link ChatDriver} (ink TTY or plain line
 * loop), and on teardown emit the session's sole terminal (`session:cancelled`, idempotent) + close the
 * persister and the db. `/exit`, `/cancel`, and an input-stream EOF all end the session with **exit code 4**.
 */
/** The slash-aware line handler + the session's cancel/stop state. */
export interface ChatLineHandler {
  /** Handle one line (a slash command or a message); awaits the turn for a message. */
  readonly processLine: (raw: string) => Promise<void>;
  /** Emit the session's sole terminal (`session:cancelled`, idempotent) — the teardown caller fires it. */
  readonly cancelOnce: () => void;
  /** `true` once `/exit` or `/cancel` has run — the driver stops reading input. */
  readonly shouldStop: () => boolean;
}

/**
 * Build the slash-aware line handler shared by the chat REPL loop (`runReplLoop`) and the 2.5.B Home's in-tree
 * chat driver: `/exit` stops; `/cancel` ends the (resumable) session AND stops; `/export` scaffolds a workflow
 * between turns; an unknown slash warns; anything else is appended + persisted + sent as a turn. The cancel/stop
 * state is internal — the caller reads it via `shouldStop` and fires the terminal via `cancelOnce` on teardown.
 */
export function createChatLineHandler(
  wiring: Pick<ReplWiring, 'built' | 'opened' | 'store' | 'persister' | 'doctorProbes'>,
  deps: ChatReplDeps,
): ChatLineHandler {
  const { built, opened, store, persister, doctorProbes } = wiring;
  let stop = false;
  let cancelled = false;
  const cancelOnce = (): void => {
    if (!cancelled) {
      cancelled = true;
      built.session.cancel(); // the session's sole terminal (session:cancelled) — persister marks it 'ended'
    }
  };

  // Surface command output (the /help list, /workflows catalog, /cost line) the right way for the active surface:
  // the live ink view (TTY, non-`--json`) renders a NOTICE cleanly in-conversation; on the plain (non-TTY) and
  // `--json` paths ink is NOT mounted (those drivers render the event stream, not the chat store), so write to
  // stderr — a diagnostic that keeps stdout the pure event stream. (ink is mounted iff stdoutIsTty && !json — keep
  // this condition in sync with `selectChatDriver` in render/tui/chat-ink.tsx, which picks driveInk on the same test.)
  const interactive = deps.io.stdoutIsTty && !deps.global.json;
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
  };

  const processLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line.length === 0) return;
    if (line.startsWith('/')) {
      // Parse `/name [args]` (S5): split the post-slash string into a command name + arg tokens, so `/doctor
      // --deep` dispatches `doctor` with `['--deep']`. A zero-arg command takes no tokens (so `/exit now` is
      // rejected below), preserving the prior exact-match strictness while admitting declared flags.
      const [name, ...tokens] = line.slice(1).split(/\s+/);
      const command =
        name !== undefined && name.length > 0 ? REPL_COMMANDS_BY_NAME.get(name) : undefined;
      if (command !== undefined) {
        // Reject a token the command does not declare (a zero-arg command rejects ANY token). Echo it SANITIZED
        // through the notice channel — interactive errors belong in-view (ink), not on stderr behind the live view.
        const allowed = new Set((command.args ?? []).map((arg) => arg.flag));
        const bad = tokens.find((token) => !allowed.has(token));
        if (bad !== undefined) {
          emitOutput(
            `/${command.name}: unknown argument '${bad.replace(/[^\x20-\x7e]/g, '?').slice(0, 32)}'.`,
          );
          return;
        }
        await command.run(replCtx, tokens); // may be async (/cost, /doctor); never fire-and-forget
        return;
      }
      // Echo a SANITIZED form — strip non-printable bytes + truncate — so a crafted slash can't smuggle a terminal
      // control sequence (or a flood). Routed through the notice channel (in-view on a TTY, stderr otherwise).
      const safe = line.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
      emitOutput(`unknown command '${safe}'. Available: ${replCommandList()}.`);
      return;
    }
    store.appendUser(line);
    persister.beginUserTurn(line);
    await built.session.sendMessage(line);
  };

  return { processLine, cancelOnce, shouldStop: () => stop };
}

async function runReplLoop(wiring: ReplWiring, deps: ChatReplDeps): Promise<ExitCode> {
  const { built, opened, store, persister, startSession, intro } = wiring;
  const { processLine, cancelOnce, shouldStop } = createChatLineHandler(wiring, deps);

  // persister.start() subscribes for the turn events + adopts/inserts the session row; it does NOT consume
  // session:started, so it is safe before the driver. The session-open action (fresh start() / resume no-op)
  // is deferred to startSession() INSIDE the driver, after the driver has subscribed the view store.
  try {
    persister.start();
    await (deps.drive ?? drivePlain)({
      startSession,
      processLine,
      shouldStop,
      handle: built.handle,
      store,
      io: deps.io,
      global: deps.global,
      // A headless driver flushes the terminal (session:cancelled) before unsubscribing; the command's own
      // cancelOnce below is then a no-op (idempotent). Other drivers ignore it — the command fires it.
      finalize: cancelOnce,
      // The ink driver's second-SIGINT hard `process.exit` bypasses the finally below — give it a best-effort
      // MCP teardown to run first so a forced quit never orphans a spawned stdio child (no-op when no servers).
      ...(built.closeMcp === undefined ? {} : { onForceExit: built.closeMcp }),
      ...(intro === undefined ? {} : { intro }),
    });
  } finally {
    cancelOnce(); // emit the terminal even on /exit or EOF (idempotent); flips the row to 'ended'
    // Attempt EVERY teardown step (a reject in one must not skip the next) and never let a cleanup fault mask the
    // loop's exit outcome — each is best-effort, surfacing a warning rather than throwing. MCP tears down LAST,
    // AFTER the session terminal, so no tool call can race the close (idempotent; present only with `mcp_servers`).
    closeQuietly(deps.io, 'persister', () => persister.close());
    closeQuietly(deps.io, 'session store', () => opened.close());
    await built.closeMcp?.().catch((e: unknown) => warnTeardown(deps.io, 'MCP', e));
  }
  // `/exit`, `/cancel`, and an input EOF all END the chat session — the canonical chat-session-ended code.
  return EXIT_CODES.chatEnded;
}

/**
 * The default, **plain** (non-TTY) driver: a line loop over stdin with a streamed-token printer. Used when no
 * TTY is attached (a pipe / CI without `--json`, which is 2.Q); the TTY ink driver overrides `deps.drive`.
 */
export async function drivePlain(ctx: ChatDriveContext): Promise<void> {
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
}

/**
 * The **`--json`** (2.Q) headless driver: the machine analogue of `relavium run --json`. Messages are read
 * from stdin one user turn per line; every session-stream event (`session:*` + the per-turn `agent:*` /
 * `cost:updated`) is serialized verbatim as one NDJSON line on **stdout**, each carrying the `sessionId`
 * ([ADR-0049](../../../docs/decisions/0049-cli-machine-output-contract.md)). Diagnostics (unknown-slash,
 * /export) stay on stderr, so stdout is a pure `SessionEvent` stream. An input-stream EOF ends the session
 * (exit code 4, like the REPL). No banner — the first line is the `session:started` event.
 */
export async function driveJson(ctx: ChatDriveContext): Promise<void> {
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
