import type { FsCapability } from '@relavium/core';

import { frameUntrusted, injectionNonce, INJECT_MAX_CHARS, INJECT_MAX_LINES } from './injection.js';

/**
 * The `@`-mention file-context injection (2.5.D step 4, [ADR-0061](../../../../docs/decisions/0061-cli-input-layer-file-injection-and-shell-escape.md)).
 * A keyboard-owning completion submode (like the `/` palette) lets the user pick a file whose text is injected
 * into their message as USER-position, UNTRUSTED context. The pure model (state + fold + formatting) lives here;
 * the read goes through {@link MentionReader}, a thin wrapper over the SAME `FsCapability` the session's tools
 * use — so the jail, the sensitive-read confidentiality floor (`.ssh` / `.env` / `.aws` / … — never listed nor
 * read, the listing-gate), the binary fail-close, and the 8 MiB size cap are all enforced by that one audited
 * boundary. A user typing `@path` replaces the `confirmAction` prompt (a stronger consent signal), NEVER the
 * floor. Paths are workspace-relative, POSIX-separated (display + jail-relative).
 */

/** A completion candidate under the browsed directory. `path` is the workspace-relative (POSIX) path. */
export interface MentionCandidate {
  readonly name: string;
  readonly type: 'file' | 'directory';
  readonly path: string;
}

/**
 * The completion submode state. `dir` is the browsed directory (workspace-relative, `''` = root); `filter` the
 * partial name typed to narrow the list; `candidates` ALL of `dir`'s entries (already confidentiality-gated by
 * the fs listing + advisory-ignore filtered, dirs first); `selected` an index into the VISIBLE (filtered) subset;
 * `loading` is `true` between opening/descending a directory and its async listing resolving (so the view shows a
 * "loading…" hint instead of a misleading "no matches" during the in-flight fs read).
 */
export interface MentionState {
  readonly dir: string;
  readonly filter: string;
  readonly candidates: readonly MentionCandidate[];
  readonly selected: number;
  readonly loading: boolean;
}

/**
 * Whether typing `@` at `cursor` in `text` should OPEN the completion (vs. insert a literal `@`): only at a word
 * boundary — the start of the buffer, or immediately after whitespace — so an email / handle typed mid-word
 * (`foo@bar`) keeps its literal `@`. Mirrors the competitor rule; makes `@` first-class without hijacking every
 * literal use. `charAt` past the end returns `''` (never whitespace), so a clamped cursor is safe.
 */
export function mentionOpensAt(text: string, cursor: number): boolean {
  if (cursor <= 0) return true;
  return /\s/.test(text.charAt(cursor - 1));
}

/** The visible candidates — those whose name contains `filter` (case-insensitive); order is the loader's (dirs first). */
export function visibleMentions(state: MentionState): readonly MentionCandidate[] {
  if (state.filter.length === 0) return state.candidates;
  const needle = state.filter.toLowerCase();
  return state.candidates.filter((candidate) => candidate.name.toLowerCase().includes(needle));
}

/** The minimal key fields the mention fold reads (a structural subset of ink's `Key`). */
export interface MentionKey {
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly escape?: boolean;
  readonly return?: boolean;
  readonly tab?: boolean;
  readonly backspace?: boolean;
  readonly delete?: boolean;
  readonly upArrow?: boolean;
  readonly downArrow?: boolean;
}

/** What a keystroke does to the open completion submode. */
export type MentionStep =
  // Cancel the completion. `restore` is the literal text to re-insert at the cursor so keystrokes are never lost:
  // Esc / Ctrl-C / an empty match restores `@` + the typed filter (the user keeps what they typed); a backspace
  // PAST the filter restores `''` (the user was deleting through the `@`, so it stays deleted).
  | { readonly kind: 'close'; readonly restore: string }
  | { readonly kind: 'descend'; readonly dir: string } // accept a directory — the caller lists it + resets
  | { readonly kind: 'accept'; readonly path: string } // accept a file — the caller reads it + injects
  | { readonly kind: 'state'; readonly state: MentionState };

/** Clamp a selection index to `0..count-1` (or 0 when the list is empty). */
function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * The parent of a workspace-relative directory — the last POSIX segment stripped (`'src/lib'` → `'src'`,
 * `'src'` → `''` the workspace root, `''` → `''`). The values only ever ASCEND toward `''`, never above it (there
 * is no literal `..` segment), so an ascend can never escape the workspace jail. Used by the `..` synthetic
 * candidate + the backspace-to-parent shortcut.
 */
export function parentDir(dir: string): string {
  if (dir.length === 0) return '';
  const slash = dir.lastIndexOf('/');
  return slash <= 0 ? '' : dir.slice(0, slash);
}

/**
 * Fold one keystroke into the open `@`-completion submode (the keyboard-owning contract, mirroring the `/`
 * palette): `Esc`/`Ctrl-C` cancels; `↑`/`↓` move the selection; `Enter`/`Tab` (and `/`) accept the selected
 * candidate (a directory descends, a file injects); backspace trims the filter, then — below the root — ASCENDS
 * one directory (at the root, backspace on an empty filter cancels, dropping the `@`); a single printable code
 * point extends the filter (a multi-char paste blob is dropped, matching the other submodes); every other key is
 * ignored (stays open).
 */
export function foldMentionKey(char: string, key: MentionKey, state: MentionState): MentionStep {
  // Esc / Ctrl-C cancels but RESTORES the literal keystrokes (`@` + filter) — canceling never silently eats text.
  if (key.escape === true || (key.ctrl === true && char === 'c')) {
    return { kind: 'close', restore: `@${state.filter}` };
  }
  const visible = visibleMentions(state);
  if (key.upArrow === true) {
    return {
      kind: 'state',
      state: { ...state, selected: clampSelection(state.selected - 1, visible.length) },
    };
  }
  if (key.downArrow === true) {
    return {
      kind: 'state',
      state: { ...state, selected: clampSelection(state.selected + 1, visible.length) },
    };
  }
  // Shift+Tab is the mode-cycle chord (reduceChatKey), NOT an accept — the overlay must not swallow it as a Tab
  // accept. It is ignored here (stays open); the user Escs first to cycle the mode. Plain Tab / Enter / `/` accept.
  const acceptKey = (key.tab === true && key.shift !== true) || key.return === true || char === '/';
  if (acceptKey) {
    const chosen = visible[state.selected];
    // Nothing to accept (an empty/over-filtered list) — treat like Esc: cancel + restore the typed keystrokes.
    if (chosen === undefined) return { kind: 'close', restore: `@${state.filter}` };
    return chosen.type === 'directory'
      ? { kind: 'descend', dir: chosen.path }
      : { kind: 'accept', path: chosen.path };
  }
  if (key.backspace === true || key.delete === true) {
    if (state.filter.length > 0) {
      return { kind: 'state', state: { ...state, filter: state.filter.slice(0, -1), selected: 0 } };
    }
    // Backspace PAST the filter, below the root, ASCENDS one directory (competitor muscle memory — never a
    // dead-end descent); AT the root it deletes the `@` itself (restore nothing — the user is deleting through it).
    if (state.dir.length > 0) return { kind: 'descend', dir: parentDir(state.dir) };
    return { kind: 'close', restore: '' };
  }
  if ([...char].length === 1 && key.ctrl !== true && key.meta !== true) {
    return { kind: 'state', state: { ...state, filter: state.filter + char, selected: 0 } };
  }
  return { kind: 'state', state };
}

/* -------------------------------------------------------------------------------------------------- *
 * The reader — a thin wrapper over the session's FsCapability (the ONE audited jail + floor).
 * -------------------------------------------------------------------------------------------------- */

/** Directories always skipped from the completion candidate list (advisory noise — build output, VCS, deps). This
 *  fixed set is the **v1 advisory trim**; the ADR-0061 `.gitignore` / `.relaviumignore` matcher is a deferred
 *  follow-up (docs/roadmap/deferred-tasks.md) — NOT a security control (the confidentiality floor is enforced
 *  SEPARATELY by the fs listing-gate, `.git`/`.ssh`/`.env`/… never appear here regardless of this set). */
const NOISE_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.cache',
  '.next',
  '.turbo',
  '.git',
  '__pycache__',
  'vendor',
]);

export interface MentionReadResult {
  readonly content: string;
  readonly sizeBytes: number;
}

export interface MentionReader {
  /** List the workspace-relative directory `dir` (`''` = root) — files + dirs, confidentiality-gated by the fs
   *  capability + advisory-noise filtered, directories first then case-insensitive by name. */
  list(dir: string): Promise<readonly MentionCandidate[]>;
  /** Read the workspace-relative file `path` through the fs jail + floor + binary/size guards (throws on a
   *  jail/floor/binary/oversize/not-found violation — NEVER a raw read). */
  read(path: string): Promise<MentionReadResult>;
}

/** Join a workspace-relative dir + a name into a POSIX path (`''` dir ⇒ the bare name). */
function joinRelative(dir: string, name: string): string {
  return dir.length === 0 ? name : `${dir}/${name}`;
}

/** Build a {@link MentionReader} over an `FsCapability` — the read/list go through that one audited boundary. */
export function createMentionReader(fs: FsCapability): MentionReader {
  return {
    async list(dir) {
      // `''` lists the workspace root ('.'); the fs capability jails every path + the listing skips a sensitive
      // store (the listing-gate), so a `.ssh`/`.env`/`.aws` entry is never even offered.
      const listing = await fs.listDirectory(dir.length === 0 ? '.' : dir, {});
      const candidates = listing.entries
        .filter((entry) => !(entry.type === 'directory' && NOISE_DIRS.has(entry.name)))
        .map((entry) => ({
          name: entry.name,
          type: entry.type,
          path: joinRelative(dir, entry.name),
        }));
      // Directories first, then case-insensitive by name — a stable, glanceable order.
      const sorted = [...candidates].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
      // Below the workspace root, offer a synthetic `..` ascend row at the very top (dir-navigation is first-class,
      // ADR-0061) — it descends to the parent (which only ever climbs toward `''`, never above the jailed root).
      if (dir.length === 0) return sorted;
      return [{ name: '..', type: 'directory' as const, path: parentDir(dir) }, ...sorted];
    },
    async read(path) {
      const file = await fs.readFile(path, {});
      return { content: file.content, sizeBytes: file.sizeBytes };
    },
  };
}

/* -------------------------------------------------------------------------------------------------- *
 * Injection + heuristics (pure).
 * -------------------------------------------------------------------------------------------------- */

/** A byte-heuristic token estimate (~4 bytes/token) — NO tokenizer, NO new dependency. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

/** The token count above which a mentioned file gets a size warning (a soft, informational threshold). */
export const MENTION_TOKEN_WARN = 8000;

/** The `@`-injection content bounds — the shared injection caps ({@link injection.ts}). Re-exported under the
 *  historical names the tests + callers reference. */
export const MENTION_MAX_INJECT_CHARS = INJECT_MAX_CHARS;
export const MENTION_MAX_INJECT_LINES = INJECT_MAX_LINES;

/** A fresh per-injection fence nonce ({@link injectionNonce}) — re-exported under the `@`-scoped name. */
export const mentionNonce = injectionNonce;

/**
 * Format a mentioned file for injection into the user message as UNTRUSTED, user-position context — the shared
 * {@link frameUntrusted} framing over a `<file id="NONCE" path="…">` tag: the path is sanitized (control + bidi +
 * framing chars stripped, so a crafted filename can neither break the attribute nor forge a tag), the content is
 * nonce-fenced (its bytes cannot forge/close the frame) and byte+line bounded (a large file cannot freeze the
 * editor). The content is verbatim data the model must NOT treat as instructions.
 */
export function formatMentionInjection(path: string, content: string, nonce: string): string {
  return frameUntrusted('file', { path }, content, nonce);
}
