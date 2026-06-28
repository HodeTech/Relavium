import { randomUUID } from 'node:crypto';

import { createRunHistoryReader } from '@relavium/db';
import { render } from 'ink';
import { createElement } from 'react';

import { createChatLineHandler } from '../commands/chat.js';
import { buildChatSession, type BuiltChatSession } from '../chat/session-host.js';
import { createSessionPersister } from '../chat/persister.js';
import { loadResolvedConfig } from '../config/load.js';
import { createProviderResolver, type ProviderResolver } from '../engine/providers.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import type { CliIo } from '../process/io.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { createMcpSecretResolver, type McpSecretResolver } from '../secrets/mcp-secret.js';
import { createChatStore } from '../render/tui/chat-store.js';
import {
  RootApp,
  FRAME_MS,
  type HomeChatSession,
  type RootAppProps,
} from '../render/tui/home-app.js';
import { createHomeStore } from './home-store.js';

/**
 * `driveHome` — the imperative entry behind a bare `relavium` in a TTY (2.5.B / [ADR-0054](../../../../docs/decisions/0054-cli-bare-invocation-interactive-home.md)).
 * It opens the durable `history.db` ONCE, wires the {@link createHomeStore} read seam, and mounts the single-ink
 * tree {@link RootApp}. The Home defers the per-chat build to a submit: `startChat` builds a fresh chat session
 * (the default agent, the chat config, inline MCP) AFTER the mount, so the strip shows immediately and a slow /
 * failed build surfaces as a loading state / a Home-banner rather than blocking the entry. A chat's teardown
 * closes only ITS resources (persister + frame loop + subscription + MCP); the shared db is closed once here.
 *
 * The signal lifecycle (an external SIGINT/SIGTERM → 128+signo, the unified MCP teardown) is refined in 2.5.B
 * step 3; here a keyboard Ctrl-C is intercepted by `RootApp`'s `useInput` (Home → clean exit 0; chat → /cancel).
 */
export interface HomeDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  readonly providers?: ProviderResolver;
  /** Injectable session builder (tests inject a scripted provider via `providers`). Default {@link buildChatSession}. */
  readonly buildSession?: typeof buildChatSession;
  /** Injectable session-store opener (tests pass an in-memory store). Default {@link openSessionStore}. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
  readonly mcpSecretResolver?: McpSecretResolver;
  readonly now?: () => number;
  readonly uuid?: () => string;
  /** Injectable ink mount + the terminal-size seam (tests drive `RootApp` props without a real TTY). */
  readonly render?: (props: RootAppProps) => { unmount: () => void };
  readonly getSize?: () => { cols: number; rows: number };
  readonly subscribeResize?: (onResize: () => void) => () => void;
}

export async function driveHome(deps: HomeDeps): Promise<ExitCode> {
  const now = deps.now ?? Date.now;
  const uuid = deps.uuid ?? randomUUID;
  const { config, projectConfigDir, homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const providers = deps.providers ?? createProviderResolver(deps.io.env);
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  const homeStore = createHomeStore({
    sessions: opened.store,
    runs: createRunHistoryReader(opened.db),
  });

  // Build + wire + START a fresh chat session (the Home sends the first message on transition). Mirrors the chat
  // command's build, but defers it to a Home submit and drives it inside the already-mounted RootApp.
  const startChat = async (): Promise<HomeChatSession> => {
    const store = createChatStore(deps.global.color);
    const built: BuiltChatSession = await (deps.buildSession ?? buildChatSession)({
      chat: config.chat,
      agentRef: undefined, // the built-in default agent (zero-config first run)
      cwd: deps.global.cwd,
      projectConfigDir,
      now,
      uuid,
      providers,
      mcpSecretResolver: deps.mcpSecretResolver ?? createMcpSecretResolver(deps.io.env),
      mcpRegistrations: config.mcpServers,
      onBudgetWarning: (warning) =>
        deps.io.writeErr(
          `budget warning: ~${warning.thresholdPct}% of the ${warning.limitMicrocents}µ¢ cap reached\n`,
        ),
    });
    const persister = createSessionPersister({
      store: opened.store,
      handle: built.handle,
      sessionId: built.sessionId,
      agent: built.agent,
      context: built.context,
      now,
      uuid,
    });
    const { processLine, cancelOnce, shouldStop } = createChatLineHandler(
      { built, opened, store, persister },
      deps,
    );
    // Subscribe the view store BEFORE opening the session so the synchronous session:started is observed.
    const unsubscribe = built.handle.subscribe((event) => store.apply(event));
    const frame = setInterval(() => store.tick(), FRAME_MS);
    frame.unref();
    persister.start();
    built.session.start();
    const teardown = async (): Promise<void> => {
      cancelOnce(); // the session's sole terminal (idempotent) — persister marks the row 'ended'
      clearInterval(frame);
      unsubscribe();
      try {
        persister.close();
      } finally {
        await built.closeMcp?.().catch(() => undefined); // best-effort; never orphan a spawned stdio child
      }
    };
    return { store, processLine, shouldStop, teardown };
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

  let instance: { unmount: () => void } | undefined;
  try {
    return await new Promise<ExitCode>((resolve, reject) => {
      const props: RootAppProps = {
        homeStore,
        startChat,
        nowMs: now,
        color: deps.global.color,
        getSize,
        subscribeResize,
        onExit: () => resolve(EXIT_CODES.success), // a clean Home exit is exit 0
        onError: (err) => reject(err instanceof Error ? err : new Error(String(err))),
      };
      instance =
        deps.render !== undefined
          ? deps.render(props)
          : render(createElement(RootApp, props), {
              exitOnCtrlC: false, // RootApp's useInput drives Ctrl-C, not ink's process.exit
              patchConsole: false,
              maxFps: Math.max(1, Math.round(1000 / FRAME_MS)),
            });
    });
  } finally {
    instance?.unmount();
    opened.close(); // close the shared db ONCE, after the Home (and any chat) has torn down
  }
}
