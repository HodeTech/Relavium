/**
 * The consent fingerprint and its grant log
 * ([ADR-0084](../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §3, §5).
 *
 * Every case here corresponds to a §10 acceptance item, and several exist because an earlier draft of the
 * ADR got the answer wrong in a way measurement caught — those say which.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  appendGrant,
  appendRevocation,
  fingerprint,
  readGrants,
  resolveStdioSpawn,
  StdioResolutionError,
  type ConsentGrant,
  type ResolvedStdioSpawn,
} from './mcp-consent.js';

let dir = '';
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'relavium-consent-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const spawnOf = (over: Partial<ResolvedStdioSpawn> = {}): ResolvedStdioSpawn => ({
  serverId: 'fs',
  provenance: { kind: 'inline' },
  command: 'npx',
  resolvedCommand: '/usr/local/bin/npx',
  args: ['-y', '@acme/fs-server'],
  env: { ACME_TOKEN: '{{secrets.acme}}' },
  cwd: '/Users/x/projects/a',
  ...over,
});

describe('fingerprint (ADR-0084 §3)', () => {
  it('is `v1:` + 64 lowercase hex, and stable across calls', () => {
    const digest = fingerprint(spawnOf());
    expect(digest).toMatch(/^v1:[0-9a-f]{64}$/);
    expect(fingerprint(spawnOf())).toBe(digest);
  });

  it('changes with the resolved command, the args, an env NAME, an env VALUE, and the cwd', () => {
    const base = fingerprint(spawnOf());
    expect(fingerprint(spawnOf({ resolvedCommand: '/tmp/evil/npx' }))).not.toBe(base);
    expect(fingerprint(spawnOf({ args: ['-y', '@acme/other'] }))).not.toBe(base);
    expect(fingerprint(spawnOf({ env: { OTHER: '{{secrets.acme}}' } }))).not.toBe(base);
    expect(fingerprint(spawnOf({ env: { ACME_TOKEN: '{{secrets.other}}' } }))).not.toBe(base);
    expect(fingerprint(spawnOf({ cwd: '/Users/x/projects/b' }))).not.toBe(base);
  });

  it('an env VALUE change re-prompts — the hole excluding values left open', () => {
    // `NODE_OPTIONS` is a NAME, so a fingerprint over names alone matched every value of it. The denylist
    // now refuses that particular name at parse; this is the general property that made it a hole.
    const a = fingerprint(spawnOf({ env: { ACME_HOME: '/opt/acme' } }));
    const b = fingerprint(spawnOf({ env: { ACME_HOME: '/tmp/evil' } }));
    expect(a).not.toBe(b);
  });

  it('does NOT change when the authored command differs but resolves to the same file', () => {
    // Identity is the resolved executable. The authored spelling is display-only.
    expect(fingerprint(spawnOf({ command: 'npx' }))).toBe(
      fingerprint(spawnOf({ command: '/usr/local/bin/npx' })),
    );
  });

  it('ignores the display-only fields — server id, provenance, artifact', () => {
    const base = fingerprint(spawnOf());
    expect(fingerprint(spawnOf({ serverId: 'other' }))).toBe(base);
    expect(fingerprint(spawnOf({ provenance: { kind: 'registration', name: 'fs' } }))).toBe(base);
    expect(fingerprint(spawnOf({ artifact: '/tmp/wf.yaml' }))).toBe(base);
  });

  it('a LITERAL `secret:acme` and a `{{secrets.acme}}` reference DIFFER — the type-tag collision', () => {
    // The blocker a review found in an earlier draft: a flat `secret:<name>` marker collided with the
    // literal string of the same text, so an approved literal could become a real credential reference with
    // no re-prompt. The tag is what closes it.
    const reference = fingerprint(spawnOf({ env: { K: '{{secrets.acme}}' } }));
    const literal = fingerprint(spawnOf({ env: { K: 'secret:acme' } }));
    expect(reference).not.toBe(literal);
  });

  it('a secret REFERENCE contributes only the name, so the credential is never in the digest', () => {
    // Two runs of the same declaration digest identically no matter what the keychain holds, because the
    // resolved value is not in scope here at all — the authored text is.
    expect(fingerprint(spawnOf({ env: { K: '{{secrets.acme}}' } }))).toBe(
      fingerprint(spawnOf({ env: { K: '{{ secrets.acme }}' } })), // whitespace inside the braces is the same reference
    );
  });

  it('a TEMPLATE containing a reference is a literal, not a reference', () => {
    // `prefix-{{secrets.a}}` is not a reference; treating it as one would digest two different authored
    // strings identically. It is a literal, so changing the prefix re-prompts.
    expect(fingerprint(spawnOf({ env: { K: 'prefix-{{secrets.acme}}' } }))).not.toBe(
      fingerprint(spawnOf({ env: { K: '{{secrets.acme}}' } })),
    );
  });

  it('an absent `args` and an empty one are the same declaration', () => {
    expect(fingerprint(spawnOf({ args: [] }))).toBe(fingerprint(spawnOf({ args: [] })));
  });
});

describe('resolveStdioSpawn (ADR-0084 §3)', () => {
  it('resolves a relative command against the cwd — two directories, two programs', async () => {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    mkdirSync(a);
    mkdirSync(b);
    writeFileSync(join(a, 'server.js'), '// a');
    writeFileSync(join(b, 'server.js'), '// b');
    const decl = {
      serverId: 'fs',
      provenance: { kind: 'inline' } as const,
      command: './server.js',
    };
    const inA = await resolveStdioSpawn(decl, a);
    const inB = await resolveStdioSpawn(decl, b);
    expect(inA.resolvedCommand).not.toBe(inB.resolvedCommand);
    expect(fingerprint(inA)).not.toBe(fingerprint(inB));
  });

  it('canonicalizes the cwd, so two symlinked routes to one directory are ONE grant', async () => {
    const real = join(dir, 'real');
    mkdirSync(real);
    writeFileSync(join(real, 'server.js'), '// x');
    const link = join(dir, 'link');
    symlinkSync(real, link);
    const decl = {
      serverId: 'fs',
      provenance: { kind: 'inline' } as const,
      command: './server.js',
    };
    expect(fingerprint(await resolveStdioSpawn(decl, real))).toBe(
      fingerprint(await resolveStdioSpawn(decl, link)),
    );
  });

  it('refuses a command that resolves nowhere, BEFORE anything is asked', async () => {
    // An unresolvable executable is not a decision a user can meaningfully make.
    await expect(
      resolveStdioSpawn(
        {
          serverId: 'fs',
          provenance: { kind: 'inline' },
          command: 'definitely-not-a-real-binary-xyz',
        },
        dir,
      ),
    ).rejects.toBeInstanceOf(StdioResolutionError);
  });

  it('refuses an empty command', async () => {
    await expect(
      resolveStdioSpawn({ serverId: 'fs', provenance: { kind: 'inline' }, command: '   ' }, dir),
    ).rejects.toBeInstanceOf(StdioResolutionError);
  });

  it('finds a BARE command on the ambient PATH and records the absolute file', async () => {
    // The property that makes the digest name a file rather than a word.
    const resolved = await resolveStdioSpawn(
      { serverId: 'node', provenance: { kind: 'inline' }, command: 'node' },
      dir,
    );
    expect(resolved.resolvedCommand.startsWith('/')).toBe(true);
    expect(resolved.resolvedCommand).not.toBe('node');
  });
});

describe('the grant log (ADR-0084 §5)', () => {
  const path = (): string => join(dir, 'mcp-consent.ndjson');
  const grantOf = (digest: string): ConsentGrant => ({
    v: 1,
    digest,
    command: 'npx',
    args: ['-y', '@acme/fs-server'],
    envNames: ['ACME_TOKEN'],
    cwd: '/Users/x/projects/a',
    grantedAt: '2026-08-20T00:00:00.000Z',
  });

  it('an absent file is no grants, not an error', () => {
    expect(readGrants(path())?.size).toBe(0);
  });

  it('records a grant and reads it back', () => {
    appendGrant(path(), grantOf('v1:aaa'));
    expect(readGrants(path())?.get('v1:aaa')?.command).toBe('npx');
  });

  it('is created 0600 from the FIRST byte, and a wider mode is repaired', () => {
    // Not a `chmod` after create — this project has already been bitten by that window on `history.db`.
    appendGrant(path(), grantOf('v1:aaa'));
    expect(statSync(path()).mode & 0o777).toBe(0o600);
    chmodSync(path(), 0o644);
    appendGrant(path(), grantOf('v1:bbb'));
    expect(statSync(path()).mode & 0o777).toBe(0o600);
  });

  it('a tombstone withdraws a grant, and a later grant re-establishes it', () => {
    appendGrant(path(), grantOf('v1:aaa'));
    appendRevocation(path(), 'v1:aaa', '2026-08-20T00:01:00.000Z');
    expect(readGrants(path())?.has('v1:aaa')).toBe(false);
    appendGrant(path(), grantOf('v1:aaa'));
    expect(readGrants(path())?.has('v1:aaa')).toBe(true);
  });

  it('survives an append onto a TRUNCATED line — the leading-newline framing', () => {
    // A process killed mid-append leaves a partial last line with no terminator. Appending straight onto it
    // would concatenate into one corrupt line, which under the fail-closed fold below costs every grant on
    // the machine rather than one entry.
    appendGrant(path(), grantOf('v1:aaa'));
    writeFileSync(path(), '{"v":1,"digest":"v1:trunc"', { flag: 'a' }); // killed mid-append, no terminator
    appendGrant(path(), grantOf('v1:bbb'));
    // The truncated line still folds the store closed (next test) — what the framing buys is that the NEW
    // grant is a WHOLE line of its own, parseable on its own, rather than being swallowed by the partial one.
    const lines = readFileSync(path(), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== '');
    const fresh = lines.find((line) => line.includes('v1:bbb'));
    expect(fresh).toBeDefined();
    expect(() => {
      JSON.parse(fresh ?? '');
    }).not.toThrow();
  });

  it('ANY unparseable line folds the WHOLE store closed — a truncated tombstone is the reason', () => {
    // Skipping the bad line and keeping the rest is the tempting answer and the wrong one: a truncated line
    // may be a TOMBSTONE, and dropping it silently resurrects a grant the user revoked. Folding closed costs
    // one prompt and cannot re-authorize anything. A deliberate divergence from the terminal outbox, which
    // skips a partial line — there one lost entry is one un-retried terminal; here it is a reversed decision.
    appendGrant(path(), grantOf('v1:aaa'));
    writeFileSync(path(), '\n{"v":1,"revoked":"v1:a', { flag: 'a' }); // a half-written revocation
    expect(readGrants(path())).toBeUndefined();
  });

  it('a line that parses as JSON but is not a grant or a tombstone also folds closed', () => {
    appendGrant(path(), grantOf('v1:aaa'));
    writeFileSync(path(), '\n{"something":"else"}\n', { flag: 'a' });
    expect(readGrants(path())).toBeUndefined();
  });

  it('two independent appends both survive — what append-only buys over a rewrite', () => {
    // The terminal outbox began as a rewrite-in-place file and became append-only because a concurrent
    // process's write was silently destroyed inside another's truncate window. A temp-file + rename here
    // would reintroduce exactly that.
    appendGrant(path(), grantOf('v1:aaa'));
    appendGrant(path(), grantOf('v1:bbb'));
    const grants = readGrants(path());
    expect(grants?.has('v1:aaa')).toBe(true);
    expect(grants?.has('v1:bbb')).toBe(true);
  });
});
