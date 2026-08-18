import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * **Every production surface that can dispatch a tool must wire the effect journal** (ADR-0080).
 *
 * This is a source-level lock, and it exists because the behavioural alternative does not work. A prior
 * review deleted the journal wiring from ALL FIVE production sites simultaneously and the entire 2,397-test
 * CLI suite stayed green — twice: once when three of five were genuinely unwired and shipped that way, and
 * again after they were fixed. Every surface's own tests inject a session or engine double, so the real
 * construction path — `createEffectJournalPort(createEffectJournalStore(opened.db, …))` — is never reached.
 *
 * The failure it guards is severe and silent: an unwired surface refuses EVERY effectful tool
 * (`run_command`, `!`-shell, an appending `write_file`, a non-GET `http_request`, every MCP tool) with a
 * message the user cannot distinguish from a genuine tool failure.
 *
 * A grep-shaped test is a blunt instrument and is chosen deliberately over nothing. If a surface later grows
 * a real integration test that dispatches a tier-3 tool against a temp-file `history.db` and asserts a
 * `run_effects` row, that test supersedes this entry — delete it here and say so.
 */

const SRC = join(import.meta.dirname, '..');

/** Each surface, and the call that proves it reached the journal. */
const SURFACES: readonly {
  file: string;
  what: string;
  needle: RegExp;
  /** The READ half — required only where the surface can RESUME a run (effect-journal.md §4). */
  resumeNeedle?: RegExp;
  /** §8's disclosure — required on every surface that can RESUME a session. */
  discloseNeedle?: RegExp;
}[] = [
  {
    file: 'commands/run.ts',
    what: '`relavium run` — the workflow engine',
    needle: /effectJournal:\s*\(correlation/,
    resumeNeedle: /effectResume:\s*createEffectResumePort\(/,
  },
  {
    file: 'commands/gate.ts',
    what: '`relavium gate` — the FAR side of a human gate, where a tool-using node does its work',
    needle: /effectJournal:\s*\(correlation/,
    resumeNeedle: /effectResume:\s*createEffectResumePort\(/,
  },
  {
    file: 'commands/agent-run.ts',
    what: '`relavium agent run` — the one-shot',
    needle: /attachEffectJournal\(\(correlation/,
  },
  {
    file: 'commands/chat.ts',
    what: '`relavium chat` / `chat-resume` / the `/clear` re-drive',
    needle: /attachEffectJournal\(\(correlation/,
    discloseNeedle: /unresolvedEffectNotice\(/,
  },
  {
    file: 'home/drive-home.tsx',
    what: 'the bare-`relavium` Home',
    needle: /attachEffectJournal\(\(correlation/,
    discloseNeedle: /unresolvedEffectNotice\(/,
  },
];

describe('the effect journal is wired on every production surface (ADR-0080)', () => {
  for (const surface of SURFACES) {
    it(`${surface.file} — ${surface.what}`, () => {
      const source = readFileSync(join(SRC, surface.file), 'utf8');
      expect(source).toMatch(surface.needle);
      // …and against the real store, not a stand-in: a surface that wired a no-op would satisfy the regex
      // above while journaling nothing.
      expect(source).toContain('createEffectJournalStore(');
      // …and the READ half wherever the surface can resume. A surface that records effects and cannot read
      // them back has the write half of the guarantee and none of the enforcement — which is the state the
      // whole repo was in until the gate landed.
      if (surface.resumeNeedle !== undefined) {
        expect(source).toMatch(surface.resumeNeedle);
      }
      // …and §8's disclosure wherever the surface can resume a SESSION. A review found the Home resuming a
      // persisted session and saying nothing, while `chat-resume` — the same rows, the same user — did.
      if (surface.discloseNeedle !== undefined) {
        expect(source).toMatch(surface.discloseNeedle);
      }
    });
  }

  it('names every surface that builds a session or an engine — a new one cannot be added silently', () => {
    // The list above is only a lock if it is complete. This is the completeness half: any file that
    // constructs a session or an engine is a dispatch surface and must appear above.
    const builders = SURFACES.map((s) => s.file);
    // `session-host.ts` and `build-engine.ts` are the CONSTRUCTORS, not surfaces — they forward what a
    // surface supplies, which is why they are excluded rather than missing.
    expect(builders).toEqual([
      'commands/run.ts',
      'commands/gate.ts',
      'commands/agent-run.ts',
      'commands/chat.ts',
      'home/drive-home.tsx',
    ]);
  });
});

/**
 * The per-attempt deadline is wired on every surface that builds a chain
 * ([ADR-0082](../../../../docs/decisions/0082-the-stream-grammar-is-a-seam-obligation-and-every-attempt-has-a-deadline.md) §6).
 *
 * Same shape and same reason as the journal lock above: the deadline is **both or neither**, so a surface
 * that forgets it does not get a weaker deadline — it gets none, silently, and an unbounded wait on a
 * provider that ignores its abort signal is the exact hang the item exists to remove. Every surface's own
 * tests inject a session or engine double, so the real construction path is never reached by them.
 */
describe('the per-attempt deadline is wired on every chain-building surface (ADR-0082)', () => {
  const CHAIN_HOSTS: readonly { file: string; what: string; needle: RegExp }[] = [
    {
      file: 'engine/build-engine.ts',
      what: 'the workflow engine — `relavium run` and `relavium gate`',
      needle: /setTimer:\s*hostAttemptTimer/,
    },
    {
      file: 'chat/session-host.ts',
      what: 'every session surface — `chat`, `chat-resume`, `agent run`, the Home',
      needle: /setTimer:\s*hostAttemptTimer/,
    },
  ];

  for (const host of CHAIN_HOSTS) {
    it(`${host.file} — ${host.what}`, () => {
      const source = readFileSync(join(SRC, host.file), 'utf8');
      expect(source).toMatch(host.needle);
    });
  }

  it('names every surface that builds a chain — a new one cannot be added silently', () => {
    // `build-engine.ts` and `session-host.ts` are the only two constructors; every command routes through
    // one of them. A third would be a third place to forget the deadline.
    expect(CHAIN_HOSTS.map((h) => h.file)).toEqual([
      'engine/build-engine.ts',
      'chat/session-host.ts',
    ]);
  });
});

