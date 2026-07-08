/**
 * A dependency-free `.gitignore` / `.relaviumignore` matcher for the `@`-mention completion (2.5.D, ADR-0061 —
 * a deferred follow-up landed in the 2.5 close-out). It trims the candidate list so `@` does not surface files
 * the project already ignores (build output, local scratch), matching the developer's mental model.
 *
 * NOT a security control — the confidentiality floor (a `.ssh`/`.env`/`.aws`/credential-store read/list refusal)
 * is enforced SEPARATELY and unconditionally by the `fs` capability's listing-gate, regardless of this matcher.
 * A gitignore file is untrusted project data (it can be authored/committed by anyone), so this only ever HIDES
 * more entries; it can never widen what the fs jail already refuses. Because the input is untrusted, matching is
 * done with a LINEAR two-pointer glob algorithm (no regex → no super-linear backtracking / ReDoS on a crafted
 * pattern), not by compiling patterns to regexes.
 *
 * Supported (the common subset): blank lines + `#` comments; `!` negation (later rules override earlier —
 * gitignore precedence); a trailing `/` (directory-only, matched correctly for the dir AND everything under it);
 * a leading `/` OR an interior `/` anchors to the ignore file's root, else the pattern matches a path's BASENAME
 * at any depth; the `*` (any run of non-`/`), `**` (a whole path segment crossing directories), and `?` (one
 * non-`/`) globs. Deliberately NOT supported (documented subset, never a security gap since it only under-hides):
 * nested per-directory `.gitignore` files (only the workspace-root files are read), `[a-z]` character classes,
 * and a trailing-space / `\#` / `\!` escape. An unmatched candidate is simply shown.
 */

/** A doublestar path-segment sentinel (`**`) — matches zero or more whole path segments. */
const DOUBLESTAR = '**';

/** One compiled ignore rule. */
interface IgnoreRule {
  /** The pattern split into `/`-segments; a segment equal to {@link DOUBLESTAR} is the cross-dir wildcard. */
  readonly segments: readonly string[];
  /** `/foo` or `a/b` — the pattern is anchored to the ignore-file root (else it matches a basename at any depth). */
  readonly anchored: boolean;
  /** A trailing `/` restricts the rule to directories (and, transitively, everything under them). */
  readonly dirOnly: boolean;
  /** `!pattern` — a negation re-includes a path an earlier rule ignored (last match wins). */
  readonly negate: boolean;
}

/** The compiled matcher: does `relPath` (a workspace-relative POSIX path) match an ignore rule? */
export interface IgnoreMatcher {
  ignores(relPath: string, isDir: boolean): boolean;
}

/** Split an ignore-file body into its non-comment, non-blank pattern lines (CRLF-tolerant, trailing-ws trimmed). */
export function parseIgnoreLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trimEnd()) // strips a trailing `\r` (CRLF) + trailing spaces; leaves the pattern body
    .filter((line) => line.length > 0 && !line.startsWith('#'));
}

/**
 * Whether a single glob SEGMENT (`*` = any run of non-`/`, `?` = one non-`/`, else literal) matches one path
 * segment — the classic iterative wildcard match with a single star-backtrack. O(n·m) worst, linear typical, and
 * critically NON-backtracking-exponential: there is no regex and no nested quantifier, so an adversarial pattern
 * cannot make it super-linear beyond the bounded segment lengths.
 */
function segmentMatches(glob: string, seg: string): boolean {
  let g = 0;
  let s = 0;
  let starG = -1;
  let starS = 0;
  while (s < seg.length) {
    if (g < glob.length && (glob[g] === '?' || glob[g] === seg[s])) {
      g += 1;
      s += 1;
    } else if (g < glob.length && glob[g] === '*') {
      starG = g; // remember the `*` so we can extend how much it consumes on a later mismatch
      starS = s;
      g += 1;
    } else if (starG !== -1) {
      g = starG + 1; // backtrack: let the last `*` absorb one more char
      s = starS + 1;
      starS += 1;
    } else {
      return false;
    }
  }
  while (g < glob.length && glob[g] === '*') g += 1; // trailing `*`(s) match the empty remainder
  return g === glob.length;
}

/**
 * Match an ANCHORED pattern (its `/`-segments, with `**` sentinels) against the path segments, starting at the
 * root — a two-pointer walk where `**` matches zero+ segments (backtracking a WHOLE segment at a time, never a
 * character, so this is bounded/linear-ish, never exponential). Returns whether the pattern is fully consumed
 * (a match, with prefix semantics — a matched dir also matches everything under it) and, if so, whether it ended
 * BEFORE the path end (⇒ the matched thing is a directory, which the dir-only rule needs).
 */
function anchoredMatch(
  segs: readonly string[],
  pathSegs: readonly string[],
): { matched: boolean; endsBeforeEnd: boolean } {
  let pi = 0;
  let si = 0;
  let starPi = -1;
  let starSi = 0;
  while (pi < segs.length) {
    const seg = segs[pi];
    if (seg === DOUBLESTAR) {
      starPi = pi; // `**` matches zero+ segments; record a resume point and try zero first
      starSi = si;
      pi += 1;
    } else if (
      si < pathSegs.length &&
      seg !== undefined &&
      segmentMatches(seg, pathSegs[si] ?? '')
    ) {
      pi += 1;
      si += 1;
    } else if (starPi !== -1 && starSi < pathSegs.length) {
      starSi += 1; // backtrack: let the last `**` absorb one more whole segment
      si = starSi;
      pi = starPi + 1;
    } else {
      return { matched: false, endsBeforeEnd: false };
    }
  }
  return { matched: true, endsBeforeEnd: si < pathSegs.length };
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
  return { segments: pattern.split('/'), anchored, dirOnly, negate };
}

/** Whether one compiled rule matches the split path. Unanchored (single-segment) rules match a basename at any depth. */
function ruleMatches(rule: IgnoreRule, pathSegs: readonly string[], isDir: boolean): boolean {
  if (rule.anchored) {
    const { matched, endsBeforeEnd } = anchoredMatch(rule.segments, pathSegs);
    // dir-only fails ONLY when the match ends exactly at the path end (the LAST segment IS the candidate) and the
    // candidate is a file; a match ending earlier means the matched segment is a directory, so dir-only holds.
    return matched && (!rule.dirOnly || endsBeforeEnd || isDir);
  }
  // Unanchored: a single glob segment matches ANY path segment (then it + everything under it — prefix). dir-only
  // holds for a non-last matched segment (always a directory) or, on the last segment, only when isDir.
  const glob = rule.segments[0] ?? '';
  for (let i = 0; i < pathSegs.length; i += 1) {
    if (segmentMatches(glob, pathSegs[i] ?? '')) {
      const isLast = i === pathSegs.length - 1;
      if (!rule.dirOnly || !isLast || isDir) return true;
    }
  }
  return false;
}

/** The always-false matcher (no rules) — nothing is ignored. */
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
      // Normalize a leading `./` + collapse a trailing `/`, then split into segments (dropping empty ones).
      const normalized = relPath.startsWith('./') ? relPath.slice(2) : relPath;
      const pathSegs = normalized.split('/').filter((seg) => seg.length > 0);
      if (pathSegs.length === 0) return false;
      let ignored = false;
      for (const rule of rules) {
        if (ruleMatches(rule, pathSegs, isDir)) ignored = !rule.negate; // last matching rule wins (negation re-includes)
      }
      return ignored;
    },
  };
}
