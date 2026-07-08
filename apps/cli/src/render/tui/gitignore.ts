/**
 * A dependency-free `.gitignore` / `.relaviumignore` matcher for the `@`-mention completion (2.5.D, ADR-0061 —
 * a deferred follow-up landed in the 2.5 close-out). It trims the candidate list so `@` does not surface files
 * the project already ignores (build output, local scratch), matching the developer's mental model.
 *
 * NOT a security control — the confidentiality floor (a `.ssh`/`.env`/`.aws`/credential-store read/list refusal)
 * is enforced SEPARATELY and unconditionally by the `fs` capability's listing-gate, regardless of this matcher.
 * A gitignore file is untrusted project data (it can be authored/committed by anyone), so this only ever HIDES
 * more entries; it can never widen what the fs jail already refuses.
 *
 * Supported (the common subset): blank lines + `#` comments; `!` negation (later rules override earlier —
 * gitignore precedence); a trailing `/` (directory-only); a leading `/` OR an interior `/` anchors to the ignore
 * file's root, else the pattern matches a path's BASENAME at any depth; the `*` (any run of non-`/`), `**` (across
 * directories), and `?` (one non-`/`) globs. Deliberately NOT supported (documented subset, never a security gap
 * since it only under-hides): nested per-directory `.gitignore` files (only the workspace-root files are read),
 * `[a-z]` character classes, and a trailing-space / `\#` / `\!` escape. An unmatched candidate is simply shown.
 */

/** One compiled ignore rule. */
interface IgnoreRule {
  readonly re: RegExp;
  /** `!pattern` — a negation re-includes a path an earlier rule ignored (last match wins). */
  readonly negate: boolean;
  /** A trailing `/` restricts the rule to directories. */
  readonly dirOnly: boolean;
}

/** The compiled matcher: does `relPath` (a workspace-relative POSIX path) match an ignore rule? */
export interface IgnoreMatcher {
  ignores(relPath: string, isDir: boolean): boolean;
}

/** Split an ignore-file body into its non-comment, non-blank pattern lines (CRLF-tolerant, trailing-ws trimmed). */
export function parseIgnoreLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/\r$/, '').replace(/\s+$/, ''))
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/** Escape a literal char for embedding in a RegExp source. */
function escapeRe(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Translate a gitignore glob (the pattern with any leading `/` and trailing `/` already stripped) to a RegExp
 * source matching a whole path. `anchored` ⇒ match from the path start; else match at any segment boundary (so an
 * unanchored `foo` matches `foo` and `a/foo`). The trailing `(?:/|$)` lets a pattern match a path PREFIX, so a
 * directory pattern also ignores everything under it.
 */
function globToRegExp(glob: string, anchored: boolean): RegExp {
  let src = '';
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        i += 1; // consumed the second '*'
        if (glob[i + 1] === '/') {
          i += 1; // consumed the '/'
          src += '(?:.*/)?'; // `**/` — zero or more leading directories
        } else {
          src += '.*'; // `**` (crosses `/`)
        }
      } else {
        src += '[^/]*'; // a single `*` stays within a segment
      }
    } else if (ch === '?') {
      src += '[^/]';
    } else if (ch !== undefined) {
      src += escapeRe(ch);
    }
  }
  const head = anchored ? '^' : '(?:^|/)';
  return new RegExp(`${head}${src}(?:/|$)`);
}

/** Compile a single pattern line into a rule, or `undefined` if it is empty after stripping the `!`. */
function compileRule(raw: string): IgnoreRule | undefined {
  const negate = raw.startsWith('!');
  let pattern = negate ? raw.slice(1) : raw;
  const dirOnly = pattern.endsWith('/');
  if (dirOnly) pattern = pattern.slice(0, -1);
  // Anchored if a `/` is at the start or the middle (a trailing `/` was already stripped above).
  const anchored = pattern.startsWith('/') || pattern.includes('/');
  if (pattern.startsWith('/')) pattern = pattern.slice(1);
  if (pattern.length === 0) return undefined;
  return { re: globToRegExp(pattern, anchored), negate, dirOnly };
}

/** The always-ignored matcher (no rules) — nothing is ignored. */
const NEVER: IgnoreMatcher = { ignores: () => false };

/**
 * Compile one or more ignore-file bodies (e.g. `.gitignore` then `.relaviumignore`) into a matcher. The bodies
 * are concatenated in order, so a later file's rules take precedence (last match wins), matching how git layers
 * ignore sources. An empty/all-comment input yields the {@link NEVER} matcher.
 */
export function compileIgnore(...texts: string[]): IgnoreMatcher {
  const rules = texts
    .flatMap((text) => parseIgnoreLines(text))
    .map(compileRule)
    .filter((rule): rule is IgnoreRule => rule !== undefined);
  if (rules.length === 0) return NEVER;
  return {
    ignores(relPath, isDir) {
      const path = relPath.replace(/^\.\//, '').replace(/\/+$/, ''); // normalize a leading `./` + a trailing `/`
      if (path.length === 0) return false;
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue; // a `foo/` rule never matches a file
        if (rule.re.test(path)) ignored = !rule.negate; // last matching rule wins (negation re-includes)
      }
      return ignored;
    },
  };
}
