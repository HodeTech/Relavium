import type { FsCapability } from '@relavium/core';

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
 * the fs listing + advisory-ignore filtered, dirs first); `selected` an index into the VISIBLE (filtered) subset.
 */
export interface MentionState {
  readonly dir: string;
  readonly filter: string;
  readonly candidates: readonly MentionCandidate[];
  readonly selected: number;
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
  | { readonly kind: 'close' } // Esc / Ctrl-C / backspace-past-filter — cancel, drop the '@'
  | { readonly kind: 'descend'; readonly dir: string } // accept a directory — the caller lists it + resets
  | { readonly kind: 'accept'; readonly path: string } // accept a file — the caller reads it + injects
  | { readonly kind: 'state'; readonly state: MentionState };

/** Clamp a selection index to `0..count-1` (or 0 when the list is empty). */
function clampSelection(index: number, count: number): number {
  if (count <= 0) return 0;
  return Math.max(0, Math.min(index, count - 1));
}

/**
 * Fold one keystroke into the open `@`-completion submode (the keyboard-owning contract, mirroring the `/`
 * palette): `Esc`/`Ctrl-C` cancels; `↑`/`↓` move the selection; `Enter`/`Tab` (and `/`) accept the selected
 * candidate (a directory descends, a file injects); backspace trims the filter, and backspace on an empty filter
 * cancels (dropping the `@`); a single printable code point extends the filter (a multi-char paste blob is
 * dropped, matching the other submodes); every other key is ignored (stays open).
 */
export function foldMentionKey(char: string, key: MentionKey, state: MentionState): MentionStep {
  if (key.escape === true || (key.ctrl === true && char === 'c')) return { kind: 'close' };
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
  if (key.return === true || key.tab === true || char === '/') {
    const chosen = visible[state.selected];
    if (chosen === undefined) return { kind: 'close' };
    return chosen.type === 'directory'
      ? { kind: 'descend', dir: chosen.path }
      : { kind: 'accept', path: chosen.path };
  }
  if (key.backspace === true || key.delete === true) {
    if (state.filter.length > 0) {
      return { kind: 'state', state: { ...state, filter: state.filter.slice(0, -1), selected: 0 } };
    }
    return { kind: 'close' }; // backspace past the filter drops the '@'
  }
  if ([...char].length === 1 && key.ctrl !== true && key.meta !== true) {
    return { kind: 'state', state: { ...state, filter: state.filter + char, selected: 0 } };
  }
  return { kind: 'state', state };
}

/* -------------------------------------------------------------------------------------------------- *
 * The reader — a thin wrapper over the session's FsCapability (the ONE audited jail + floor).
 * -------------------------------------------------------------------------------------------------- */

/** Directories always skipped from the completion candidate list (advisory noise — build output, VCS, deps). The
 *  confidentiality floor (`.git`, `.ssh`, `.env`, …) is enforced SEPARATELY by the fs listing-gate, not here. */
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
      return [...candidates].sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
      });
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

/**
 * Format a mentioned file for injection into the user message as UNTRUSTED, user-position context. The path is
 * stripped of quotes/control chars (it lands in an attribute); the content is verbatim data the model must NOT
 * treat as instructions. Framed with `<file>` tags so the model can tell where the injected data begins/ends.
 */
export function formatMentionInjection(path: string, content: string): string {
  const safePath = path.replace(/[<>"]/g, '');
  return `\n\n<file path="${safePath}">\n${content}\n</file>`;
}
