/**
 * The CLI's {@link TerminalOutbox} — a terminal the store would not accept, held in a SEPARATE FILE
 * ([ADR-0078](../../../../docs/decisions/0078-ordered-durable-append-and-the-terminal-outbox.md) §4).
 *
 * **The separate file is the whole decision, not an implementation detail.** The store that must hold a
 * refused terminal is the store that just refused it: a full disk, a corrupt `history.db`, or an exhausted
 * `SQLITE_BUSY` budget fails an outbox row for exactly the reason it failed the terminal. The maintainer
 * ruled for real fault isolation over the cheaper in-database row, so this writes its own small file beside
 * the database and never opens the database at all.
 *
 * **One line per entry, newest-wins per run.** The format is NDJSON — an append-only log read whole, with the
 * LAST line for a run winning. Append rather than rewrite because the process writing here has already
 * demonstrated that a write failed; a rewrite that dies mid-truncate loses every other run's entry too. The
 * file is small by construction (one line per run whose terminal could not be written, which is meant to be
 * approximately never) and is compacted on `remove`, when the process is by definition healthy again.
 *
 * **`0600`, like `history.db`.** A terminal payload carries `run:completed.outputs` — model output, not
 * secrets (the engine masks those at the bus, ADR-0036), but run data all the same, so it inherits
 * [ADR-0050](../../../../docs/decisions/0050-cli-history-db-at-rest-posture.md)'s posture rather than
 * defaulting to whatever the umask says.
 *
 * **Nothing here throws for a caller that cannot recover.** The engine calls `put` from inside its terminal
 * path, having already failed one write; a throw would break exactly-one-terminal on the way out of the code
 * that exists to protect it. `put` reports failure by leaving the entry unwritten — the run already reports
 * `uncertain`, which is the honest floor ADR-0078 §4's Consequences records.
 */

import { appendFileSync, chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { RunEventSchema, type RunEvent, type TerminalOutbox } from '@relavium/shared';

import { stringifyJsonLine } from '../render/sanitize.js';

/** Owner-only, matching `history.db` (ADR-0050). A no-op on Windows, as the at-rest guard there is the ACL. */
const FILE_MODE = 0o600;

/** Read every line, keeping the LAST entry per run; unreadable lines are skipped, never fatal. */
function readEntries(path: string): Map<string, RunEvent> {
  const held = new Map<string, RunEvent>();
  if (!existsSync(path)) return held;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return held; // an unreadable outbox is a lost retry, not a crash — the run already reported uncertain
  }
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    try {
      // Parsed through the canonical schema, not trusted: this file is read on a LATER start, by a binary
      // that may differ from the one that wrote it, and a malformed line must not become a fabricated
      // terminal. A line that does not parse is dropped — the same posture the run-event reader takes.
      const parsed = RunEventSchema.parse(JSON.parse(line));
      if (parsed.runId !== undefined) held.set(parsed.runId, parsed);
    } catch {
      continue;
    }
  }
  return held;
}

/**
 * Create the file-backed outbox at `path` (conventionally `~/.relavium/terminal-outbox.ndjson`).
 *
 * The directory is assumed to exist — the same one `history.db` lives in, created with `0700` by the history
 * opener. Creating it here would duplicate that permission logic in a second place.
 */
export function createFileTerminalOutbox(path: string): TerminalOutbox {
  const ensureMode = (): void => {
    try {
      chmodSync(path, FILE_MODE);
    } catch {
      // Windows, or a file we do not own. The at-rest guard there is the per-user profile ACL (ADR-0050).
    }
  };

  return {
    put: (event) => {
      try {
        if (!existsSync(dirname(path))) return Promise.resolve();
        // `stringifyJsonLine`, not a bare `JSON.stringify` — this line is read back and re-parsed, and the
        // payload carries model output. The escape is lossless, so the round-trip is exact (`CR-03`).
        appendFileSync(path, `${stringifyJsonLine(event)}\n`, { mode: FILE_MODE });
        ensureMode();
      } catch {
        // Deliberately silent — see the module docblock. The run reports `uncertain` either way.
      }
      return Promise.resolve();
    },
    list: () => Promise.resolve([...readEntries(path).values()]),
    remove: (runId) => {
      try {
        const held = readEntries(path);
        if (!held.delete(runId)) return Promise.resolve();
        // Compaction is safe HERE and not in `put`: this call happens after a successful durable write, so
        // the process has demonstrated it can write. Rewriting from inside `put` — where a write just failed
        // — could lose every other run's entry along with the one that would not land.
        const rest = [...held.values()].map((e) => `${stringifyJsonLine(e)}\n`).join('');
        writeFileSync(path, rest, { mode: FILE_MODE });
        ensureMode();
      } catch {
        // A stale entry is retried next start and dropped when its run is found already terminal — an
        // orphan costs one read, never a wrong terminal.
      }
      return Promise.resolve();
    },
  };
}
