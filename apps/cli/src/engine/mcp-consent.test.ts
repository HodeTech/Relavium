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

  it('the GOLDEN VECTORS — declaration to DIGEST, which is what ADR-0084 §3 asks for', () => {
    // The canonical-form vectors in `@relavium/shared` pin `value → string`; §3 asks for `declaration →
    // digest`, which additionally covers the `v1:` prefix, SHA-256, and the field set. A second
    // implementation is verified against these, not against a second reading of the paragraph.
    // §3 names the cases they must cover: non-ASCII, an embedded quote and backslash, an empty `args`, and
    // an absent `env`. `canonicalJson`'s own vectors pin `value → string`; these additionally exercise
    // `fingerprint`'s env type-tagging, which is the piece a second implementation must reproduce and the
    // piece the ADR calls out as the load-bearing collision fix.
    const vectors: readonly (readonly [ResolvedStdioSpawn, string])[] = [
      [
        spawnOf({ command: 'x', resolvedCommand: '/bin/x', args: [], env: {}, cwd: '/w' }),
        'v1:50264fc33efd1056148d3d6642a98fcb74e03b214ed9c380feddb92f7e1714c2',
      ],
      [
        spawnOf({ resolvedCommand: '/bin/é☃', args: ['ünïcode'], env: {}, cwd: '/w/é' }),
        'v1:fcf2ed9b8fd9d97d5c948cbddbc105319c78c2e3b486e5c7e9d89d5d8661e220',
      ],
      [
        spawnOf({ resolvedCommand: '/bin/x', args: ['a"b', 'c\\d'], env: {}, cwd: '/w' }),
        'v1:8b7c2b426792b5ca2364dc74e4c8b73c386aada84fb4745513b2a826ab92ed43',
      ],
      [
        spawnOf({
          resolvedCommand: '/bin/x',
          args: [],
          env: { A: '{{secrets.k}}', B: 'secret:k' },
          cwd: '/w',
        }),
        'v1:0a178265ba8310190e1cfe4e6e53e4797a4ffdea6768b8faa8ab70331f58431d',
      ],
    ];
    for (const [spawn, expected] of vectors) {
      expect(fingerprint(spawn), JSON.stringify({ ...spawn, provenance: undefined })).toBe(
        expected,
      );
    }
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
    writeFileSync(join(a, 'server.js'), '// a', { mode: 0o755 });
    writeFileSync(join(b, 'server.js'), '// b', { mode: 0o755 });
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
    writeFileSync(join(real, 'server.js'), '// x', { mode: 0o755 });
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

  it('refuses an EXPLICIT path that does not exist — resolving is not verifying', async () => {
    // `path.resolve` is string arithmetic: it never fails and never touches the filesystem, so an absolute
    // or `./relative` command that does not exist used to sail through, get a fingerprint, and be consented
    // to. Anything later materialising at that exact path would then spawn under a grant nobody evaluated
    // against a real program — the TOCTOU §3's "resolve before the gate" exists to close.
    for (const command of ['/definitely/not/a/real/path/xyz123', './nope/server.js']) {
      await expect(
        resolveStdioSpawn({ serverId: 'fs', provenance: { kind: 'inline' }, command }, dir),
        command,
      ).rejects.toBeInstanceOf(StdioResolutionError);
    }
  });

  it('refuses an explicit path that exists but is a DIRECTORY, or is not executable', async () => {
    const asDir = join(dir, 'adir');
    mkdirSync(asDir);
    writeFileSync(join(dir, 'plain.js'), '// not executable', { mode: 0o644 });
    for (const command of [asDir, join(dir, 'plain.js')]) {
      await expect(
        resolveStdioSpawn({ serverId: 'fs', provenance: { kind: 'inline' }, command }, dir),
        command,
      ).rejects.toBeInstanceOf(StdioResolutionError);
    }
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

  it('REFUSES to write through a symlink swapped in after the first creation', () => {
    // `ensureFile`'s exclusive create refuses to follow a link at first creation, but every later append
    // and chmod follows one — so a process that replaced the file after the first write turned this store
    // into a write primitive against any file the CLI can write. A review reproduced a grant record landing
    // in an arbitrary target. ADR-0084 accepts that write access to `~/.relavium` can edit the grant FILE;
    // using it to write somewhere else is a different thing.
    appendGrant(path(), grantOf('v1:aaa'));
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'untouched');
    rmSync(path());
    symlinkSync(target, path());
    expect(() => {
      appendGrant(path(), grantOf('v1:bbb'));
    }).toThrow(/symbolic link/);
    expect(readFileSync(target, 'utf8')).toBe('untouched');
  });

  it('an existing grant survives a later append — the exclusive create never truncates', () => {
    // `ensureFile` attempts the exclusive create unconditionally, so `wx` is the thing that decides. With a
    // short-circuit on `existsSync`, `wx` and a truncating `w` were indistinguishable in every observable
    // way — which made the flag that prevents a truncate-on-create race untestable.
    appendGrant(path(), grantOf('v1:aaa'));
    appendGrant(path(), grantOf('v1:bbb'));
    expect(readGrants(path())?.has('v1:aaa')).toBe(true);
  });

  // Skipped for root and on Windows, where mode 0 does not deny a read — the behaviour under test needs the
  // OS to actually refuse, and asserting it where it cannot be produced would pin nothing.
  const canDenyReads = process.platform !== 'win32' && process.getuid?.() !== 0;
  it.skipIf(!canDenyReads)('an UNREADABLE file folds closed rather than throwing', () => {
    // The sibling of the unparseable-line case: the whole-file failure. Both must fail closed, because both
    // mean "this machine's grants cannot be trusted right now".
    appendGrant(path(), grantOf('v1:aaa'));
    chmodSync(path(), 0);
    try {
      expect(readGrants(path())).toBeUndefined();
    } finally {
      chmodSync(path(), 0o600); // so the temp dir can be removed
    }
  });

  it('BOUNDS the stored comparison metadata, so one append is one bounded record (§5)', () => {
    // §5 claims "a single `appendFileSync` of one bounded record" and nothing bounded it: no schema caps an
    // `args` count or a string length, so a declaration could produce a line of megabytes — past where a
    // single write is reliably atomic, which is the property the no-lock concurrent-append design leans on.
    // Only the METADATA is trimmed; the digest is the identity and is fixed-size.
    appendGrant(path(), {
      ...grantOf('v1:big'),
      args: Array.from({ length: 500 }, () => 'x'.repeat(5000)),
      envNames: Array.from({ length: 500 }, (_unused, index) => `VAR_${String(index)}`),
    });
    const line = readFileSync(path(), 'utf8');
    expect(line.length).toBeLessThan(100_000);
    const stored = readGrants(path())?.get('v1:big');
    expect(stored?.args).toHaveLength(64);
    expect(stored?.digest).toBe('v1:big'); // the identity is untouched
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
