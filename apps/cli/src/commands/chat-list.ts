import type { AgentSessionRecord } from '@relavium/shared';

import { loadResolvedConfig } from '../config/load.js';
import { openSessionStore, type OpenedSessionStore } from '../history/session-open.js';
import { EXIT_CODES, type ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { GlobalOptions } from '../process/options.js';
import { writeRecordLines } from '../render/records.js';

export interface ChatListCommandDeps {
  readonly io: CliIo;
  readonly global: GlobalOptions;
  /** Injectable session-store opener — tests pass an in-memory store; production opens `~/.relavium/history.db`. */
  readonly openSessionStore?: (homeDir: string) => OpenedSessionStore;
}

/**
 * The `relavium chat-list` core (**2.O**) — list the past agent sessions (id, agent, title, last activity)
 * from durable `history.db`, the session counterpart of `relavium list`. Reads the additive `listSessions`
 * seam (non-deleted rows, most-recently-updated first); soft-deleted sessions are excluded. Framework-free
 * (no commander/ink). `--json` emits one NDJSON record per session ([ADR-0049](../../../docs/decisions/0049-cli-machine-output-contract.md));
 * an empty history is reported clearly (exit `0` — no sessions is not a fault).
 */
export function chatListCommand(deps: ChatListCommandDeps): ExitCode {
  const { homeDir } = loadResolvedConfig({
    cwd: deps.global.cwd,
    configPath: deps.global.configPath,
  });
  const opened = (deps.openSessionStore ?? openSessionStore)(homeDir);
  try {
    const sessions = opened.store.listSessions();

    if (deps.global.json) {
      writeRecordLines(deps.io, sessions.map(toJson));
      return EXIT_CODES.success;
    }

    if (sessions.length === 0) {
      deps.io.writeOut('No agent sessions yet.\n');
      return EXIT_CODES.success;
    }
    deps.io.writeOut(`Agent sessions (${sessions.length}):\n`);
    for (const session of sessions) {
      deps.io.writeOut(renderLine(session));
    }
    return EXIT_CODES.success;
  } finally {
    opened.close();
  }
}

/** One session as a terse human line: id, agent slug, status, last-activity timestamp, and the title (if any). */
function renderLine(session: AgentSessionRecord): string {
  const title = session.title === undefined ? '' : `  "${session.title}"`;
  return `  ${session.id}  ${session.agentSlug}  ${session.status}  ${session.updatedAt}${title}\n`;
}

/**
 * One session as a machine record — the secret-free identity + lifecycle fields (no transcript, no key). `title`
 * / `modelId` are `null` when the row declares none, mirroring `relavium list`'s null-for-absent convention.
 */
function toJson(session: AgentSessionRecord): unknown {
  return {
    sessionId: session.id,
    agentSlug: session.agentSlug,
    title: session.title ?? null,
    status: session.status,
    modelId: session.modelId ?? null,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    totalCostMicrocents: session.totalCostMicrocents,
  };
}
