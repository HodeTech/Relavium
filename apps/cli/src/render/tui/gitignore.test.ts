import { describe, expect, it } from 'vitest';

import { compileIgnore, parseIgnoreLines } from './gitignore.js';

describe('parseIgnoreLines', () => {
  it('drops blank lines + # comments, trims trailing whitespace, tolerates CRLF', () => {
    const body = ['# a comment', '', '  ', 'node_modules', 'dist/  ', 'a.txt\r'].join('\n');
    expect(parseIgnoreLines(body)).toEqual(['node_modules', 'dist/', 'a.txt']);
  });
});

describe('compileIgnore', () => {
  it('an empty / all-comment body ignores nothing', () => {
    const m = compileIgnore('# just a comment\n\n');
    expect(m.ignores('anything.ts', false)).toBe(false);
  });

  it('a basename pattern (no slash) matches at ANY depth', () => {
    const m = compileIgnore('node_modules\n*.log');
    expect(m.ignores('node_modules', true)).toBe(true);
    expect(m.ignores('packages/x/node_modules', true)).toBe(true);
    expect(m.ignores('a.log', false)).toBe(true);
    expect(m.ignores('deep/nested/b.log', false)).toBe(true);
    expect(m.ignores('src/app.ts', false)).toBe(false);
  });

  it('an anchored pattern (leading /) matches only at the root', () => {
    const m = compileIgnore('/dist');
    expect(m.ignores('dist', true)).toBe(true);
    expect(m.ignores('packages/x/dist', true)).toBe(false); // not at root ⇒ not ignored
  });

  it('a mid-slash pattern is anchored to the root', () => {
    const m = compileIgnore('build/output');
    expect(m.ignores('build/output', true)).toBe(true);
    expect(m.ignores('sub/build/output', true)).toBe(false); // anchored, not any-depth
  });

  it('a directory-only pattern (trailing /) never matches a FILE of the same name', () => {
    const m = compileIgnore('cache/');
    expect(m.ignores('cache', true)).toBe(true); // the directory is ignored
    expect(m.ignores('cache', false)).toBe(false); // a file named `cache` is NOT
  });

  it('drops everything UNDER an ignored directory (prefix match)', () => {
    const m = compileIgnore('node_modules');
    expect(m.ignores('node_modules/pkg/index.js', false)).toBe(true);
  });

  it('a directory-only pattern ignores FILES under the directory (the descendant fix)', () => {
    // `cache/` ignores the dir AND everything beneath it — a FILE `cache/a.txt` (isDir=false) must still match,
    // even though the rule is directory-only (the matched `cache` segment is a directory, being a mid-path segment).
    const m = compileIgnore('cache/');
    expect(m.ignores('cache/a.txt', false)).toBe(true);
    expect(m.ignores('cache/sub/b.txt', false)).toBe(true);
    expect(m.ignores('cache', true)).toBe(true); // the dir itself
    expect(m.ignores('cache', false)).toBe(false); // a FILE named `cache` is NOT dir-only-matched
  });

  it('stays fast on an adversarial many-`**` pattern + a long non-matching path (no ReDoS)', () => {
    // A regex `.*` chain would backtrack super-linearly here; the linear two-pointer matcher returns immediately.
    const pattern = `${'**/'.repeat(64)}zzz`;
    const path = `${'a/'.repeat(200)}b.ts`;
    const m = compileIgnore(pattern);
    const start = process.hrtime.bigint();
    expect(m.ignores(path, false)).toBe(false); // no `zzz` segment ⇒ no match
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    expect(elapsedMs).toBeLessThan(50); // linear — nowhere near a backtracking stall
  });

  it('`*` stays within a segment; `**` crosses directories', () => {
    const star = compileIgnore('/logs/*.txt');
    expect(star.ignores('logs/a.txt', false)).toBe(true);
    expect(star.ignores('logs/sub/a.txt', false)).toBe(false); // `*` does not cross `/`

    const globstar = compileIgnore('logs/**/*.txt');
    expect(globstar.ignores('logs/a.txt', false)).toBe(true);
    expect(globstar.ignores('logs/deep/nested/a.txt', false)).toBe(true);
  });

  it('`?` matches exactly one non-slash char', () => {
    const m = compileIgnore('/file?.txt');
    expect(m.ignores('fileA.txt', false)).toBe(true);
    expect(m.ignores('file.txt', false)).toBe(false); // needs the one extra char
    expect(m.ignores('fileAB.txt', false)).toBe(false); // only one
  });

  it('`!` negation re-includes a path an earlier rule ignored (last match wins)', () => {
    const m = compileIgnore('*.log\n!keep.log');
    expect(m.ignores('a.log', false)).toBe(true);
    expect(m.ignores('keep.log', false)).toBe(false); // re-included by the negation
    // Order matters — a later ignore re-ignores.
    const reordered = compileIgnore('!keep.log\n*.log');
    expect(reordered.ignores('keep.log', false)).toBe(true);
  });

  it('layers multiple ignore bodies (later precedence, like .gitignore then .relaviumignore)', () => {
    const m = compileIgnore('*.tmp', '!important.tmp');
    expect(m.ignores('scratch.tmp', false)).toBe(true);
    expect(m.ignores('important.tmp', false)).toBe(false); // the second body's negation wins
  });

  it('escapes regex-special chars in a literal pattern (no accidental wildcard)', () => {
    const m = compileIgnore('a.b+c'); // `.` and `+` must be literal, not regex
    expect(m.ignores('a.b+c', false)).toBe(true);
    expect(m.ignores('axbxc', false)).toBe(false);
  });
});
