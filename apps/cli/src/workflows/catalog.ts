import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';

import {
  AgentParseError,
  MAX_SOURCE_CHARS,
  WorkflowParseError,
  parseAgent,
  parseWorkflow,
} from '@relavium/core';

import { CliError } from '../process/errors.js';

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
function fileStem(name: string): string {
  for (const suffix of YAML_SUFFIXES) {
    if (name.endsWith(suffix)) {
      return name.slice(0, -suffix.length);
    }
  }
  return name;
}

/**
 * Scan `<projectConfigDir>/<kind>/` (non-recursive) for `*.yaml`/`*.yml` files, parse each, and return the
 * catalog entries sorted by slug. A missing directory yields `[]` (no catalog of that kind); an unreadable
 * directory is a real fault (exit 2). A per-file read/parse failure becomes a `valid: false` entry, not a throw,
 * so one broken file never breaks the whole listing.
 */
export function discoverCatalog(opts: {
  readonly projectConfigDir: string;
  readonly cwd: string;
  readonly kind: CatalogKind;
}): CatalogEntry[] {
  const dir = join(opts.projectConfigDir, opts.kind);
  let names: readonly string[];
  try {
    names = readdirSync(dir, { withFileTypes: true })
      // Include symlinks (a `.yaml` may be symlinked into the catalog) so `list` matches `run`, which
      // resolves a symlinked workflow path; a dangling/dir symlink simply fails the read → a flagged entry.
      .filter((d) => d.isFile() || d.isSymbolicLink())
      .map((d) => d.name)
      .filter((name) => name.endsWith('.yaml') || name.endsWith('.yml'));
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      return []; // no workflows/ (or agents/) directory — an empty catalog, not an error
    }
    throw new CliError(
      'invalid_invocation',
      `could not read the ${opts.kind} catalog at '${dir}'.`,
      {
        cause: err,
      },
    );
  }

  const entries = names.map((name) => readEntry(join(dir, name), opts.cwd, opts.kind));
  return entries.sort((a, b) => a.slug.localeCompare(b.slug));
}

/** Read + parse one catalog file into an entry; any read/parse fault becomes a `valid: false` entry. */
function readEntry(path: string, cwd: string, kind: CatalogKind): CatalogEntry {
  const rel = relative(cwd, path);
  let yaml: string;
  try {
    const stats = statSync(path);
    // The parser's authoritative cap is a CHARACTER count; `stat.size` is BYTES. UTF-8 encodes at most 4
    // bytes/char, so `chars * 4` is a byte ceiling that never false-rejects a within-limit file (a dense
    // multibyte file just under the char cap is not wrongly hidden) while still bailing before we slurp a
    // genuinely huge file into memory. The parser then re-applies the exact char cap.
    if (stats.size > MAX_SOURCE_CHARS * 4) {
      return {
        slug: fileStem(basename(path)),
        name: undefined,
        tags: [],
        path: rel,
        valid: false,
        error: 'exceeds the size limit',
      };
    }
    yaml = readFileSync(path, 'utf8');
  } catch (err) {
    // Generic, path-free reason — never echo a raw fs `err.message` (it carries the absolute path) into the
    // catalog entry / `--json` `error` field (error-handling.md; same discipline as parseReason below).
    return {
      slug: fileStem(basename(path)),
      name: undefined,
      tags: [],
      path: rel,
      valid: false,
      error: errnoCode(err) === 'EACCES' ? 'permission denied' : 'could not read the file',
    };
  }

  try {
    if (kind === 'workflows') {
      const def = parseWorkflow(yaml, { source: rel });
      return {
        slug: def.workflow.id,
        name: def.workflow.name,
        tags: def.workflow.tags ?? [],
        path: rel,
        valid: true,
      };
    }
    const agent = parseAgent(yaml, { source: rel });
    return { slug: agent.id, name: agent.name, tags: [], path: rel, valid: true };
  } catch (err) {
    return {
      slug: fileStem(basename(path)),
      name: undefined,
      tags: [],
      path: rel,
      valid: false,
      error: parseReason(err),
    };
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
