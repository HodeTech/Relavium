import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readSync,
  readdirSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { byCodeUnit } from '@relavium/shared';

import {
  AgentParseError,
  MAX_SOURCE_CHARS,
  WorkflowParseError,
  parseAgent,
  parseWorkflow,
  type AgentDefinition,
} from '@relavium/core';

import { CliError } from '../process/errors.js';
import { sourceLabel } from '../process/source-label.js';
import { isWithinFsRoot } from '../engine/tool-host/fs-policy.js';
import { assertProjectArtifactPath } from '../config/project-directory.js';

/**
 * Discover the workflow / agent YAML catalog under a project's `.relavium/` for `relavium list` (2.I). It is a
 * **file-discovery** read (disk is the catalog source of truth), distinct from the durable run history in
 * `history.db` — `list` overlays last-run status from the DB onto this disk catalog. Each file is parsed with
 * the same strict core parser a `run`/authoring path uses (`parseWorkflow` / `parseAgent`), so a listed entry
 * is a *valid* catalog entry; a file that fails to parse is surfaced as `valid: false` (never hidden, never
 * fatal to the whole listing) so a broken file is visible rather than silently dropped.
 */

export type CatalogKind = 'workflows' | 'agents';

/** One discovered catalog file. `slug`/`name`/`tags` come from the parsed document; on a parse miss `slug`
 *  falls back to the filename stem and `valid` is false. */
export interface CatalogEntry {
  readonly slug: string;
  readonly name: string | undefined;
  /** Authored `tags` (workflows only — `AgentSchema` has none), used for the `relavium list` tag grouping. */
  readonly tags: readonly string[];
  /**
   * The number of nodes the parsed workflow declares (`workflow.nodes.length`): a count the parse already holds, so
   * reading it costs nothing and it is bounded by the source-size cap. Present only on a VALID WORKFLOW entry: an
   * agent has no nodes, and a file that failed to parse has no document to count, so it keeps its refusal and no count.
   */
  readonly nodeCount?: number;
  /** The cwd-relative file path, for display. */
  readonly path: string;
  /** `false` when the file failed to parse — `list` shows it flagged rather than dropping it. */
  readonly valid: boolean;
  /** A short, secret-free parse-failure reason (present only when `valid` is false). */
  readonly error?: string;
}

// Longest-first, so `foo.relavium.yml` strips the compound suffix to `foo` (not `foo.relavium`).
const YAML_SUFFIXES = [
  '.relavium.yaml',
  '.relavium.yml',
  '.agent.yaml',
  '.agent.yml',
  '.yaml',
  '.yml',
] as const;

/** Strip the longest known YAML suffix to get the catalog id fallback (`code-review.relavium.yaml` → `code-review`). */
export function fileStem(name: string): string {
  for (const suffix of YAML_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * The most `*.yaml`/`*.yml` files one catalog directory may hold. Every file costs a stat, an open, a bounded read and a full parse, and
 * the picker, `relavium list`, `/export` and the authoring commands all walk the whole catalog, so a directory of tens of thousands of
 * files (a runaway generator, a mistaken `cp -r`) would stall each of them. A catalog that large is refused with a message that says so,
 * rather than silently listing a prefix that hides the rest (a file the listing does not show cannot be told apart from one that is not there).
 */
export const MAX_CATALOG_FILES = 500;

/**
 * The most bytes of file text ONE catalog scan reads, 16 MiB. {@link MAX_CATALOG_FILES} bounds how many files a scan opens and the
 * per-file ceiling bounds each of them, but 500 files of up to 8 MiB each is 4 GiB of reads and parses on the UI thread of the Home (and
 * of every command that walks the catalog), so the scan itself is bounded too. The bytes are the files' sizes as they are admitted, in
 * the order the scan reads them (sorted by file name): the first file that would take the total past the budget is refused UNREAD, and so
 * is every file after it, each as a `valid: false` entry that says why. A skipped file is listed, never dropped, for the reason the file
 * cap refuses a directory instead of listing a prefix: what a listing does not show cannot be told apart from what is not there.
 */
export const MAX_CATALOG_SCAN_BYTES = 16 * 1024 * 1024;

/**
 * Scan `<projectConfigDir>/<kind>/` (non-recursive) for `*.yaml`/`*.yml` files, parse each, and return the
 * catalog entries sorted by slug. A missing directory yields `[]` (no catalog of that kind); an unreadable
 * directory is a real fault (exit 2); a directory of more than {@link MAX_CATALOG_FILES} files is refused
 * (`invalid_invocation`, "too many workflow files") before any of them is opened. A per-file read/parse failure
 * becomes a `valid: false` entry, not a throw, so one broken file never breaks the whole listing; so does every file past the scan's
 * {@link MAX_CATALOG_SCAN_BYTES} budget.
 */
export function discoverCatalog(opts: {
  readonly projectConfigDir: string;
  readonly cwd: string;
  readonly kind: CatalogKind;
  readonly homeDir: string;
}): CatalogEntry[] {
  const scan = scanCatalogDirectory(opts);
  if (scan === undefined) return []; // no workflows/ (or agents/) directory — an empty catalog, not an error
  const entries = scan.names.map((name) =>
    readEntry(join(scan.dir, name), opts.cwd, opts.kind, scan.root, scan.budget, opts.homeDir),
  );
  return entries.sort((a, b) => byCodeUnit(a.slug, b.slug));
}

/** One agent file of the catalog: its entry, and the parsed definition when (and only when) the file is valid. */
export interface AgentCatalogItem {
  readonly entry: CatalogEntry;
  readonly agent: AgentDefinition | undefined;
}

/**
 * {@link discoverCatalog} for the agents catalog, keeping each valid file's parsed definition beside its entry (a read the Home's
 * agent browser needs: the entry carries only the slug and the name). It is the SAME hardened read, not a second one: the same
 * directory scan (containment, the file cap, the extension filter) and the same per-file read (admitted project artifact, within the
 * catalog root, a regular file, a size ceiling, an exact-identity open, the scan's byte budget) through {@link readCatalogText}, then the
 * strict core {@link parseAgent}. A file that fails any step is a `valid: false` entry with no definition, never a throw, and the
 * entries sort by slug exactly as {@link discoverCatalog} sorts them.
 */
export function discoverAgentDefinitions(opts: {
  readonly projectConfigDir: string;
  readonly cwd: string;
  readonly homeDir: string;
}): AgentCatalogItem[] {
  const scan = scanCatalogDirectory({ ...opts, kind: 'agents' });
  if (scan === undefined) return [];
  const items = scan.names.map((name) =>
    readAgentItem(join(scan.dir, name), opts.cwd, scan.root, scan.budget, opts.homeDir),
  );
  return items.sort((a, b) => byCodeUnit(a.entry.slug, b.entry.slug));
}

/**
 * The catalog directory a scan read: its path, its real root, the candidate file names (not yet opened, sorted by code unit so the
 * scan reads them in one order wherever the filesystem lists them) and the byte budget every file of THIS scan is charged to.
 */
interface CatalogScan {
  readonly dir: string;
  readonly root: string;
  readonly names: readonly string[];
  readonly budget: ScanBudget;
}

/** What one scan may still read, kept per scan (never across scans) and handed to every file read of it. */
interface ScanBudget {
  /** Charge `bytes` to the scan; `false` (and `false` for every later charge) when they would take it past {@link MAX_CATALOG_SCAN_BYTES}. */
  readonly charge: (bytes: number) => boolean;
  /** `true` once a charge was refused: every later file is skipped without being touched. */
  readonly spent: () => boolean;
  /** The reason a skipped file carries: fixed text, no authored content, naming the directory to thin out. */
  readonly reason: string;
}

function newScanBudget(kind: CatalogKind): ScanBudget {
  let used = 0;
  let spent = false;
  return {
    charge: (bytes) => {
      if (spent || used + bytes > MAX_CATALOG_SCAN_BYTES) {
        spent = true;
        return false;
      }
      used += bytes;
      return true;
    },
    spent: () => spent,
    reason: `skipped: the catalog is larger than ${String(MAX_CATALOG_SCAN_BYTES / (1024 * 1024))} MiB; move some files out of .relavium/${kind}/`,
  };
}

/**
 * The directory half of a catalog read, shared by {@link discoverCatalog} and {@link discoverAgentDefinitions}: contain the directory,
 * list its YAML files in code-unit order, refuse a directory over {@link MAX_CATALOG_FILES}, and start the scan's byte budget
 * ({@link MAX_CATALOG_SCAN_BYTES}): the one place every kind and both discovery functions pass through. `undefined` when the directory
 * does not exist.
 */
function scanCatalogDirectory(opts: {
  readonly projectConfigDir: string;
  readonly kind: CatalogKind;
  readonly homeDir: string;
}): CatalogScan | undefined {
  const dir = join(opts.projectConfigDir, opts.kind);
  assertProjectArtifactPath(dir, opts.homeDir);
  let names: readonly string[];
  let root: string;
  try {
    root = realpathSync.native(opts.projectConfigDir);
    const realDir = realpathSync.native(dir);
    if (!isWithinFsRoot(root, realDir)) throw new Error('outside catalog authority');
    names = readdirSync(realDir, { withFileTypes: true })
      // Include symlinks (a `.yaml` may be symlinked into the catalog) so `list` matches `run`, which
      // resolves a symlinked workflow path; a dangling/dir symlink simply fails the read → a flagged entry.
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return undefined; // no workflows/ (or agents/) directory — an empty catalog, not an error
    }
    throw new CliError('invalid_invocation', `could not read the ${opts.kind} catalog directory.`, {
      cause: err,
    });
  }

  if (names.length > MAX_CATALOG_FILES) {
    // Thrown HERE, outside the `try` above: that one files every failure as "could not read the catalog directory".
    throw new CliError(
      'invalid_invocation',
      `too many ${opts.kind === 'workflows' ? 'workflow' : 'agent'} files in the catalog (more than ${String(MAX_CATALOG_FILES)}); move some out of .relavium/${opts.kind}/ to list them.`,
    );
  }
  // The order the budget is spent in: a directory listing is in whatever order the filesystem keeps, which must not decide which files
  // are read and which are skipped. Sorted only after the count is known to be within the ceiling, so a runaway directory is refused, not sorted.
  return { dir, root, names: [...names].sort(byCodeUnit), budget: newScanBudget(opts.kind) };
}

/**
 * Every id a NEW workflow file must not take in `<projectConfigDir>/workflows/` (MVP-A3): each workflow entry's
 * slug — a valid file's `workflow.id`, an invalid one's file stem — and each file's stem, and the same for the
 * agents catalog, because an id must be unique across both. The stem counts on its own because `relavium run <id>`
 * resolves a bare id by file name first, so a new `<id>.relavium.yaml` would shadow a file whose name is `<id>.yaml`
 * but whose `workflow.id` differs. Every value is also added lower-cased: ids are lower-case, and on a
 * case-insensitive filesystem `My-Id.yaml` is the same name as `my-id.yaml`. Throws the catalog's own error for an
 * unreadable or out-of-project directory.
 */
export function takenWorkflowIds(
  projectConfigDir: string,
  cwd: string,
  homeDir: string,
): ReadonlySet<string> {
  const taken = new Set<string>();
  for (const kind of ['workflows', 'agents'] as const) {
    for (const entry of discoverCatalog({ projectConfigDir, cwd, kind, homeDir })) {
      for (const id of [entry.slug, fileStem(basename(entry.path))]) {
        taken.add(id);
        taken.add(id.toLowerCase());
      }
    }
  }
  return taken;
}

/** A `valid: false` catalog entry whose slug falls back to the filename stem — the secret-free, path-free shape. */
function invalidEntry(path: string, rel: string, error: string): CatalogEntry {
  return {
    slug: fileStem(basename(path)),
    name: undefined,
    tags: [],
    path: rel,
    valid: false,
    error,
  };
}

/** UTF-8 that refuses malformed input instead of repairing it; `ignoreBOM` keeps a leading U+FEFF in the text, as `Buffer#toString` did. */
const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** The hardened read of one catalog file: its text, or the `valid: false` entry that says why it was not read. */
type CatalogText =
  | { readonly ok: true; readonly yaml: string; readonly rel: string }
  | { readonly ok: false; readonly entry: CatalogEntry };

function refused(path: string, rel: string, reason: string): CatalogText {
  return { ok: false, entry: invalidEntry(path, rel, reason) };
}

/**
 * The file half of a catalog read, shared by every kind and by {@link discoverAgentDefinitions}: admit the path (a project
 * artifact, inside the catalog root), require a regular file under the size ceiling, charge its size to the scan's byte budget, open its
 * canonical target by exact identity and read it in bounded chunks. Any fault is a refusal carrying a short, path-free reason, never a
 * throw.
 *
 * **The scan's byte budget is accounted HERE** ({@link ScanBudget}): every kind and both discovery functions read through this function,
 * so none can skip it. Once a file has crossed the budget every later file is refused before it is even resolved; the file that crosses
 * it is refused before it is opened, so it is never partly read.
 */
function readCatalogText(
  path: string,
  cwd: string,
  root: string,
  budget: ScanBudget,
  homeDir: string,
): CatalogText {
  const rel = sourceLabel(cwd, path);
  if (budget.spent()) return refused(path, rel, budget.reason);
  let yaml: string;
  try {
    const canonical = realpathSync.native(path);
    try {
      assertProjectArtifactPath(canonical, homeDir);
    } catch {
      return refused(path, rel, 'not an admitted project artifact; check global catalog links');
    }
    if (!isWithinFsRoot(root, canonical)) return refused(path, rel, 'outside the project catalog');
    const stats = statSync(canonical, { bigint: true });
    // statSync FOLLOWS a symlink, so a `.yaml` symlinked to a directory, FIFO, or character device (e.g.
    // /dev/zero) resolves here — and readFileSync on a FIFO/char-device BLOCKS INDEFINITELY (a local DoS via a
    // crafted symlink in the catalog dir). Reject anything that is not a regular file BEFORE reading; the size
    // check cannot guard it (a device reports stat.size 0, which passes).
    if (!stats.isFile()) {
      return refused(path, rel, 'not a regular file');
    }
    // The parser's authoritative cap is a CHARACTER count; `stat.size` is BYTES. UTF-8 encodes at most 4
    // bytes/char, so `chars * 4` is a byte ceiling that never false-rejects a within-limit file (a dense
    // multibyte file just under the char cap is not wrongly hidden) while still bailing before we slurp a
    // genuinely huge file into memory. The parser then re-applies the exact char cap.
    if (stats.size > BigInt(MAX_SOURCE_CHARS * 4)) {
      return refused(path, rel, 'exceeds the size limit');
    }
    // The file will be read: charge it. A file the checks above refused cost nothing, so only bytes that are really read count.
    if (!budget.charge(Number(stats.size))) return refused(path, rel, budget.reason);
    // Contained aliases are allowed; open their canonical target without following a newly planted final link.
    const fd = openSync(
      canonical,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      // Exact bigint identities: Windows has no O_NOFOLLOW, so this is its only swap guard, and its
      // 64-bit file IDs exceed a Number's precision.
      const opened = fstatSync(fd, { bigint: true });
      if (!opened.isFile() || opened.dev !== stats.dev || opened.ino !== stats.ino) {
        return refused(path, rel, 'not the admitted regular file');
      }
      const maxBytes = MAX_SOURCE_CHARS * 4;
      const chunks: Buffer[] = [];
      let total = 0;
      for (;;) {
        const buffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
        const count = readSync(fd, buffer, 0, buffer.length, null);
        if (count === 0) break;
        total += count;
        if (total > maxBytes) return refused(path, rel, 'exceeds the size limit');
        chunks.push(buffer.subarray(0, count));
      }
      // A file that grew after its `stat` was charged for its old size: the bytes read beyond it are charged now, so the budget follows
      // what was really read. (Past the budget the file is refused, as a file that did not fit is.)
      const grown = total - Number(stats.size);
      if (grown > 0 && !budget.charge(grown)) return refused(path, rel, budget.reason);
      try {
        yaml = STRICT_UTF8.decode(Buffer.concat(chunks, total));
      } catch {
        // A lenient decode turns each malformed sequence into U+FFFD: the entry would list as VALID, and the Home would bind and run an
        // agent whose prompt is no longer the one in the file (review P05-2; the authoring read refuses the same bytes).
        return refused(path, rel, 'not valid UTF-8');
      }
    } finally {
      closeSync(fd);
    }
  } catch (err) {
    // Generic, path-free reason — never echo a raw fs `err.message` (it carries the absolute path) into the
    // catalog entry / `--json` `error` field (error-handling.md; same discipline as parseReason below).
    return refused(
      path,
      rel,
      errnoCode(err) === 'EACCES' ? 'permission denied' : 'could not read the file',
    );
  }

  return { ok: true, yaml, rel };
}

/** Read + parse one catalog file into an entry; any read/parse fault becomes a `valid: false` entry. */
function readEntry(
  path: string,
  cwd: string,
  kind: CatalogKind,
  root: string,
  budget: ScanBudget,
  homeDir: string,
): CatalogEntry {
  if (kind === 'agents') return readAgentItem(path, cwd, root, budget, homeDir).entry;
  const text = readCatalogText(path, cwd, root, budget, homeDir);
  if (!text.ok) return text.entry;
  try {
    const def = parseWorkflow(text.yaml, { source: text.rel });
    return {
      slug: def.workflow.id,
      name: def.workflow.name,
      tags: def.workflow.tags ?? [],
      nodeCount: def.workflow.nodes.length,
      path: text.rel,
      valid: true,
    };
  } catch (err) {
    return invalidEntry(path, text.rel, parseReason(err));
  }
}

/** Read + parse one agent file: the entry `discoverCatalog` lists, and the definition it parsed (absent when the file is refused). */
function readAgentItem(
  path: string,
  cwd: string,
  root: string,
  budget: ScanBudget,
  homeDir: string,
): AgentCatalogItem {
  const text = readCatalogText(path, cwd, root, budget, homeDir);
  if (!text.ok) return { entry: text.entry, agent: undefined };
  try {
    const agent = parseAgent(text.yaml, { source: text.rel });
    return {
      entry: { slug: agent.id, name: agent.name, tags: [], path: text.rel, valid: true },
      agent,
    };
  } catch (err) {
    return { entry: invalidEntry(path, text.rel, parseReason(err)), agent: undefined };
  }
}

/** What {@link readAgentFile} says: the parsed definition, or which of the two ways the file was not taken (never a path, never a message). */
export type AgentFileRead =
  | { readonly kind: 'read'; readonly agent: AgentDefinition }
  /** The hardened read did not admit the file: gone, outside the catalog (a link out of the project), not a regular file, too large, unreadable. */
  | { readonly kind: 'refused' }
  /** The file was read, and it does not parse as an agent. */
  | { readonly kind: 'invalid' };

/**
 * The hardened read of ONE agent file the catalog listed, for a caller that binds what it reads (the Home's `c` on an agent's page). It is
 * {@link discoverAgentDefinitions}' own per-file read, not another: the same {@link readCatalogText} (admitted project artifact, inside
 * the `agents/` directory's real path, a regular file, a size ceiling, an open by canonical path with no final-link following and no blocking, an exact
 * device and inode identity) and then the same strict {@link parseAgent}, so a file swapped for a link out of the project, or for a FIFO,
 * is refused here as it is in a listing. `path` is the file's ABSOLUTE path, and the text it reads is the only read: the caller binds the
 * definition this returns and never reads the file again.
 */
export function readAgentFile(opts: {
  readonly path: string;
  readonly cwd: string;
  readonly projectConfigDir: string;
  readonly homeDir: string;
}): AgentFileRead {
  // The root is the AGENTS directory's real path, not the project configuration directory's: a file elsewhere under `.relavium/` (the
  // workflows, a note, a copy) is not an agent the catalog listed, and a directory `agents` that is itself a link out of the project must
  // not move the root with it, so it has to be within the configuration directory too (the scan's own rule, `scanCatalogDirectory`).
  let root: string;
  try {
    const configRoot = realpathSync.native(opts.projectConfigDir);
    root = realpathSync.native(join(opts.projectConfigDir, 'agents'));
    if (!isWithinFsRoot(configRoot, root)) return { kind: 'refused' };
  } catch {
    return { kind: 'refused' };
  }
  const text = readCatalogText(opts.path, opts.cwd, root, newScanBudget('agents'), opts.homeDir);
  if (!text.ok) return { kind: 'refused' };
  try {
    return { kind: 'read', agent: parseAgent(text.yaml, { source: text.rel }) };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * A short, secret-free reason from a typed parse error. Only the contract-guaranteed parse errors surface
 * their `.message` ({@link AgentParseError} + every {@link WorkflowParseError} subclass are field-named and
 * secret-free by construction — including `WorkflowSecretLeakError`, whose message names a *taint path* like
 * `inputs.api_key`, never a resolved value). Any OTHER thrown value (a future wrapper, an unexpected fault)
 * gets a generic reason — its `.message` is never echoed into the catalog entry / `--json` `error` field.
 */
function parseReason(err: unknown): string {
  if (err instanceof AgentParseError || err instanceof WorkflowParseError) {
    return err.message;
  }
  return 'could not parse the file';
}

/** The `errno` code of a Node fs error (`ENOENT`, `EACCES`, …), or `undefined` if it is not one. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
