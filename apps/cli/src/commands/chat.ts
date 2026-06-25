import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

import type { SessionHandle, SessionStreamHandleEvent } from '@relavium/core';

import { createSessionPersister } from '../chat/persister.js';
import { buildChatSession } from '../chat/session-host.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import { formatToolCall } from '../render/tui/chat-projection.js';
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
      deps.io.writeErr(`unknown command '${line}'. Available: /exit, /cancel.\n`);
      return;
    }
    store.appendUser(line);
    persister.beginUserTurn(line);
    await built.session.sendMessage(line);
  };

  persister.start();
  built.session.start();
  try {
    await (deps.drive ?? drivePlain)({
      processLine,
      shouldStop: () => stop,
      handle: built.handle,
      store,
      io: deps.io,
      global: deps.global,
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
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    ctx.io.writeOut('relavium chat — type a message, or /exit to quit.\n');
    for await (const line of rl) {
      await ctx.processLine(line);
      if (ctx.shouldStop()) break;
    }
  } finally {
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
        io.writeOut(event.token);
        return;
      case 'agent:tool_call':
        io.writeOut(`\n${formatToolCall({ toolId: event.toolId, resolved: false })}\n`);
        return;
      case 'session:turn_completed':
        io.writeOut(event.error === undefined ? '\n' : `\n[turn failed: ${event.error.code}]\n`);
        return;
      default:
        return;
    }
  };
}
