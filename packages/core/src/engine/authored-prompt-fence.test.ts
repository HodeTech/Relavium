/**
 * The lint fence that carries ADR-0081 §1's enforcement claim, verified against the SHIPPED eslint config.
 *
 * **Why a test and not a comment.** A brand is nominal to the type-checker but not to `as`, and this repo
 * has no assertion ban — so the fence is the whole difference between "the compiler enforces the boundary"
 * and a convention. The ADR states precisely which forms it catches and which two it does not; this file is
 * what keeps that statement true as the config changes.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ESLint } from 'eslint';
import { afterAll, describe, expect, it } from 'vitest';

const dir = mkdtempSync(join(tmpdir(), 'relavium-fence-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Lint a fixture written INSIDE `packages/core/src/engine`, so the repo's real config applies to it. */
async function fenceErrors(source: string): Promise<number> {
  const path = join(import.meta.dirname, `fence-fixture-${String(source.length)}.ts`);
  writeFileSync(path, source, 'utf8');
  try {
    const results = await new ESLint().lintFiles([path]);
    return results
      .flatMap((r) => r.messages)
      .filter((m) => (m.message ?? '').includes('AuthoredSystemPrompt')).length;
  } finally {
    rmSync(path, { force: true });
  }
}

const HEAD = `import type { AuthoredSystemPrompt } from './authored-system-prompt.js';\nconst d: string = 'x';\n`;

describe('the AuthoredSystemPrompt fence (ADR-0081 §1)', () => {
  const caught: readonly { form: string; source: string }[] = [
    { form: '`x as T`', source: `${HEAD}export const a = d as AuthoredSystemPrompt;\n` },
    { form: 'angle-bracket assertion', source: `${HEAD}export const b = <AuthoredSystemPrompt>d;\n` },
    { form: '`x as unknown as T`', source: `${HEAD}export const c = d as unknown as AuthoredSystemPrompt;\n` },
    {
      form: 'a return-position assertion',
      source: `${HEAD}export function g(): AuthoredSystemPrompt { return d as AuthoredSystemPrompt; }\n`,
    },
    {
      form: 'a type ALIAS naming the brand — the one-hop evasion, closed at its root',
      source: `${HEAD}type Alias = AuthoredSystemPrompt;\nexport const e = d as Alias;\n`,
    },
  ];

  for (const { form, source } of caught) {
    it(`reports ${form}`, async () => {
      expect(await fenceErrors(source)).toBeGreaterThan(0);
    });
  }

  it('does NOT report a legitimate use of the type — the negative control', async () => {
    // Without this the assertions above pass for a rule that flagged every mention of the name, which would
    // make the type unusable and get the fence disabled.
    expect(
      await fenceErrors(
        `${HEAD}import { authoredSystemPrompt } from './authored-system-prompt.js';\n` +
          `export function ok(p: AuthoredSystemPrompt): AuthoredSystemPrompt { return p; }\n` +
          `export const v = authoredSystemPrompt({ kind: 'engine', prompt: 'compaction' });\n`,
      ),
    ).toBe(0);
  });

  it('does NOT catch a generic cast helper — the residual the ADR names', async () => {
    // Recorded as a TEST rather than only as prose, so the ADR's "a forgery is visible, not impossible"
    // stays honest: if a future rule ever closes this, this expectation fails and the ADR gets updated.
    expect(
      await fenceErrors(
        `${HEAD}function id<T>(v: unknown): T { return v as T; }\n` +
          `export const j = id<AuthoredSystemPrompt>(d);\n`,
      ),
    ).toBe(0);
  });
});
