import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import {
  DEFAULT_SESSION_MAX_TURNS,
  type SessionHandle,
  type SessionStreamHandleEvent,
} from '@relavium/core';

import { createSessionPersister, type SessionPersister } from '../chat/persister.js';
import {
  buildChatSession,
  buildResumedChatSession,
  type BuiltChatSession,
} from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import { CliError } from '../process/errors.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import { formatToolCall, stripTerminalControls } from '../render/tui/chat-projection.js';
import { createChatStore, type ChatStoreController } from '../render/tui/chat-store.js';

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
  const store = createChatStore(deps.global.color);

  // An unknown --agent / un-inferrable default model throws a typed CliError here (exit 2), before any session.
  const built = (deps.buildSession ?? buildChatSession)({
    chat: config.chat,
    agentRef: args.agent,
    cwd: deps.global.cwd,
    projectConfigDir,
    now,
    uuid,
    providers,
    onBudgetWarning: (warning) =>
      deps.io.writeErr(
        `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
      ),
  });

  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  const persister = createSessionPersister({
    store: opened.store,
    handle: built.handle,
    sessionId: built.sessionId,
    agent: built.agent,
    context: built.context,
    now,
    uuid,
  });

  return runReplLoop(
    { built, opened, store, persister, startSession: () => built.session.start() },
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
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);

  let built: BuiltChatSession;
  let store: ChatStoreController;
  let persister: SessionPersister;
  let intro: string;
  try {
    // The current `[chat]` config governs the resumed turn/cost caps; the agent, model, and context are the
    // frozen originals from the record. An absent session is a clean exit-2 invocation fault.
    const loaded = opened.store.loadFull(args.sessionId);
    if (loaded === undefined) {
      throw new CliError('invalid_invocation', `no session found with id ${args.sessionId}`);
    }
    const resumed = (deps.buildResumedSession ?? buildResumedChatSession)({
      chat: config.chat,
      record: loaded.session,
      messages: loaded.messages,
      now,
      providers,
      onBudgetWarning: (warning) =>
        deps.io.writeErr(
          `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
        ),
    });
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
    intro = `Resuming session ${resumed.sessionId} — ${resumed.agent.id}, ${turns} prior ${turns === 1 ? 'turn' : 'turns'}. Type a message, or /exit to quit.`;
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
    // A pre-loop fault (not-found, no snapshot, build failure) must not strand the open db handle.
    opened.close();
    throw err;
  }

  // A resumed session already landed at idle inside `AgentSession.resume`; calling start() would throw and
  // re-emitting `session:started` would double a terminal-less lifecycle event — so startSession is a no-op.
  return runReplLoop({ built, opened, store, persister, startSession: () => {}, intro }, deps);
}

/** What the shared REPL loop needs: a built (fresh or resumed) session, its store/persister, and how to open it. */
interface ReplWiring {
  readonly built: BuiltChatSession;
  readonly opened: OpenedSessionStore;
  readonly store: ChatStoreController;
  readonly persister: SessionPersister;
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
async function runReplLoop(wiring: ReplWiring, deps: ChatReplDeps): Promise<ExitCode> {
  const { built, opened, store, persister, startSession, intro } = wiring;
  let stop = false;
  let cancelled = false;
  const cancelOnce = (): void => {
    if (!cancelled) {
      cancelled = true;
      built.session.cancel(); // the session's sole terminal (session:cancelled) — persister marks it 'ended'
    }
  };

  const processLine = async (raw: string): Promise<void> => {
    const line = raw.trim();
    if (line.length === 0) return;
    if (line === '/exit') {
      stop = true;
      return;
    }
    if (line === '/cancel') {
      // 1.V has no per-turn abort that keeps the session alive, so /cancel ends the (persisted, resumable)
      // session — its in-flight turn is aborted and `chat-resume` (2.N) can reload it later.
      cancelOnce();
      stop = true;
      return;
    }
    if (line.startsWith('/')) {
      // Echo a SANITIZED form — strip non-printable bytes + truncate — so a crafted slash can't smuggle a
      // terminal control sequence (or a flood) into stderr.
      const safe = line.replace(/[^\x20-\x7e]/g, '?').slice(0, 64);
      deps.io.writeErr(`unknown command '${safe}'. Available: /exit, /cancel.\n`);
      return;
    }
    store.appendUser(line);
    persister.beginUserTurn(line);
    await built.session.sendMessage(line);
  };

  // persister.start() subscribes for the turn events + adopts/inserts the session row; it does NOT consume
  // session:started, so it is safe before the driver. The session-open action (fresh start() / resume no-op)
  // is deferred to startSession() INSIDE the driver, after the driver has subscribed the view store.
  try {
    persister.start();
    await (deps.drive ?? drivePlain)({
      startSession,
      processLine,
      shouldStop: () => stop,
      handle: built.handle,
      store,
      io: deps.io,
      global: deps.global,
      ...(intro === undefined ? {} : { intro }),
    });
  } finally {
    cancelOnce(); // emit the terminal even on /exit or EOF (idempotent); flips the row to 'ended'
    persister.close();
    opened.close();
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
