import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  AgentParseError,
  MAX_SOURCE_CHARS,
  WorkflowParseError,
  parseAgent,
  parseWorkflow,
  serializeAgent,
  serializeWorkflow,
  type AgentDefinition,
  type WorkflowDefinition,
} from '@relavium/core';
import { SCHEMA_VERSION } from '@relavium/shared';

import { findProjectConfigDir } from '../config/paths.js';
import { CliError } from '../process/errors.js';
import { discoverCatalog, type CatalogKind } from '../workflows/catalog.js';

/**
 * The shared core of the **YAML-authoring lifecycle** (2.J `create` / `import` / `export`). It is
 * **surface-agnostic** — it only reads/writes git-native YAML under a project `.relavium/`, never the keychain
 * or run state — and reuses the SAME strict core parsers (`parseWorkflow` / `parseAgent`) the `run`/`list` paths
 * use, so an authored file is exactly as valid as one a run would accept. A re-serialize from the validated AST
 * (`serializeWorkflow` / `serializeAgent`) is the share-safety guarantee: a parsed document carries no resolved
 * secret VALUE by construction (keys live in the OS keychain; an MCP `env` references a secret only by a
 * `{{secrets.*}}` placeholder), and re-serializing additionally drops any authored comments.
 */

export type AuthoredKind = 'workflow' | 'agent';

/** A parsed, validated authored document + its identity (`slug` = the in-file `id`). */
export type ParsedAuthored =
  | { readonly kind: 'workflow'; readonly slug: string; readonly definition: WorkflowDefinition }
  | { readonly kind: 'agent'; readonly slug: string; readonly definition: AgentDefinition };

/** Per-kind catalog subdir (also the `discoverCatalog` kind) and canonical filename suffix. */
const KIND_DIR: Record<AuthoredKind, CatalogKind> = { workflow: 'workflows', agent: 'agents' };
const KIND_SUFFIX: Record<AuthoredKind, string> = {
  workflow: '.relavium.yaml',
  agent: '.agent.yaml',
};

/** The project `.relavium/` to author into: the nearest one walking up from `cwd`, else `<cwd>/.relavium`. */
export function resolveProjectConfigDir(cwd: string): string {
  return findProjectConfigDir(cwd) ?? join(cwd, '.relavium');
}

/** The canonical filename for an authored doc — `<slug>.relavium.yaml` (workflow) / `<slug>.agent.yaml` (agent). */
export function authoredFileName(kind: AuthoredKind, slug: string): string {
  return `${slug}${KIND_SUFFIX[kind]}`;
}

/** The canonical catalog path for an authored doc: `<projectConfigDir>/<workflows|agents>/<slug>.<suffix>`. */
export function catalogPath(projectConfigDir: string, kind: AuthoredKind, slug: string): string {
  return join(projectConfigDir, KIND_DIR[kind], authoredFileName(kind, slug));
}

/** Re-serialize a parsed authored doc to canonical, share-safe YAML (drops comments; preserves placeholders). */
export function serializeAuthored(doc: ParsedAuthored): string {
  return doc.kind === 'workflow'
    ? serializeWorkflow(doc.definition)
    : serializeAgent(doc.definition);
}

/**
 * Detect a YAML document's kind and parse-validate it into a {@link ParsedAuthored}. A malformed/invalid doc is
 * a typed, exit-2 {@link CliError} (the parser's message is field-named + secret-free by contract). The
 * `fileName` extension is a HINT that picks the parser, so a clearly-`.agent.yaml` / `.relavium.yaml` file
 * reports the right kind's error; a bare `.yaml`/`.yml` is SNIFFED — workflow first (its schema requires a
 * top-level `workflow:`), then agent — and a doc that is neither surfaces both typed reasons.
 */
export function detectAndParse(yaml: string, source: string, fileName: string): ParsedAuthored {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.agent.yaml') || lower.endsWith('.agent.yml')) {
    return parseAsAgent(yaml, source);
  }
  if (lower.endsWith('.relavium.yaml') || lower.endsWith('.relavium.yml')) {
    return parseAsWorkflow(yaml, source);
  }
  // Bare .yaml/.yml — sniff. A workflow has a top-level `workflow:`; an agent does not, so try workflow first.
  let workflowError: WorkflowParseError;
  try {
    return asWorkflow(parseWorkflow(yaml, { source }));
  } catch (err) {
    if (!(err instanceof WorkflowParseError)) throw err;
    workflowError = err;
  }
  try {
    return asAgent(parseAgent(yaml, { source }));
  } catch (err) {
    if (!(err instanceof AgentParseError)) throw err;
    throw new CliError(
      'invalid_invocation',
      `${source} is not a valid workflow (${workflowError.message}) or agent (${err.message}).`,
    );
  }
}

function parseAsWorkflow(yaml: string, source: string): ParsedAuthored {
  try {
    return asWorkflow(parseWorkflow(yaml, { source }));
  } catch (err) {
    if (err instanceof WorkflowParseError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}

function parseAsAgent(yaml: string, source: string): ParsedAuthored {
  try {
    return asAgent(parseAgent(yaml, { source }));
  } catch (err) {
    if (err instanceof AgentParseError) {
      throw new CliError('invalid_invocation', err.message, { cause: err });
    }
    throw err;
  }
}

function asWorkflow(definition: WorkflowDefinition): ParsedAuthored {
  return { kind: 'workflow', slug: definition.workflow.id, definition };
}
function asAgent(definition: AgentDefinition): ParsedAuthored {
  return { kind: 'agent', slug: definition.id, definition };
}

/** The answers a `create` wizard gathers (the surface-agnostic core; the clack TTY layer is a separate module). */
export interface CreateSpec {
  readonly kind: AuthoredKind;
  readonly name: string;
  readonly provider: AgentDefinition['provider'];
  readonly model: string;
  readonly systemPrompt: string;
  readonly tools: readonly string[];
}

/**
 * The interactive `create` wizard seam — gather a {@link CreateSpec}, or `null` when the user cancels the prompt
 * itself (Ctrl-C / ESC). The `@clack/prompts`-backed implementation lives in its own module (the ONLY place the
 * prompt library is imported, mirroring the gate prompter + the ink renderer split); tests inject a fake.
 */
export interface CreatePrompter {
  gather(): Promise<CreateSpec | null>;
}

/**
 * Derive a kebab-case id from a human name — lowercase, ASCII-alphanumeric runs joined by single dashes (the
 * `kebabIdSchema` charset). A name with no usable `[a-z0-9]` (e.g. only punctuation / non-ASCII) yields an empty
 * slug, which is a clean exit-2 {@link CliError} (the name is NOT echoed — it is arbitrary user input).
 */
export function toSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((segment) => segment.length > 0)
    .join('-');
  if (slug.length === 0) {
    throw new CliError(
      'invalid_invocation',
      'the name needs at least one ASCII letter or digit to form an id.',
    );
  }
  return slug;
}

/**
 * Build a new authored document from a {@link CreateSpec} and VALIDATE it by round-tripping through the strict
 * parser — a bad model/provider/system_prompt (or a slug the schema rejects) surfaces as the SAME typed exit-2
 * {@link CliError} a `run` would raise. A `workflow` wraps the agent in a minimal `input → agent → output`
 * scaffold (the inline agent, a single agent node, the two edges). Returns the validated {@link ParsedAuthored}.
 */
export function buildAuthored(spec: CreateSpec): ParsedAuthored {
  const id = toSlug(spec.name);
  const agent: AgentDefinition = {
    id,
    ...(spec.name === id ? {} : { name: spec.name }),
    provider: spec.provider,
    model: spec.model,
    system_prompt: spec.systemPrompt,
    ...(spec.tools.length === 0 ? {} : { tools: [...spec.tools] }),
  };
  if (spec.kind === 'agent') {
    return detectAndParse(serializeAgent(agent), `<new agent>`, '.agent.yaml');
  }
  const definition: WorkflowDefinition = {
    schema_version: SCHEMA_VERSION,
    workflow: {
      id,
      ...(agent.name === undefined ? {} : { name: agent.name }),
      agents: [agent],
      nodes: [
        { id: 'input', type: 'input' },
        { id: 'main', type: 'agent', agent_ref: id },
        { id: 'output', type: 'output' },
      ],
      edges: [
        { from: 'input', to: 'main' },
        { from: 'main', to: 'output' },
      ],
    },
  };
  return detectAndParse(serializeWorkflow(definition), `<new workflow>`, '.relavium.yaml');
}

/**
 * Read a YAML file as UTF-8 for authoring, with the SAME regular-file + size guards the catalog scan uses (a
 * crafted symlink to a FIFO/char-device would otherwise block `readFileSync` indefinitely). A missing /
 * unreadable file, a non-regular-file target, or one over the source cap is a typed, exit-2 {@link CliError}
 * whose message is path-free of the absolute path (never echo a raw fs error — error-handling.md).
 */
export function readAuthoredFile(path: string, displayPath: string): string {
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(path);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') {
      throw new CliError('invalid_invocation', `no file at ${displayPath}`);
    }
    throw new CliError('invalid_invocation', `could not read ${displayPath}`);
  }
  if (!stats.isFile()) {
    throw new CliError('invalid_invocation', `${displayPath} is not a regular file`);
  }
  // The parser's cap is a CHARACTER count; stat.size is BYTES (≤ 4 bytes/UTF-8 char), so `chars * 4` is a byte
  // ceiling that never false-rejects a within-limit file while bailing before slurping a huge file into memory.
  if (stats.size > MAX_SOURCE_CHARS * 4) {
    throw new CliError('invalid_invocation', `${displayPath} exceeds the size limit`);
  }
  try {
    return readFileSync(path, 'utf8');
  } catch {
    throw new CliError('invalid_invocation', `could not read ${displayPath}`);
  }
}

/**
 * Atomically write an authored YAML file, creating parent dirs. Without `force`, an existing target is a clean
 * exit-2 fault — `wx` fails `EEXIST` so there is no TOCTOU window between a separate existence check and the
 * write; `w` truncates/overwrites under `force`. A non-file target (`EISDIR`/`ENOTDIR`) is also exit 2; other
 * write faults (permissions, disk) propagate.
 */
export function writeAuthoredFile(path: string, content: string, force: boolean): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { encoding: 'utf8', flag: force ? 'w' : 'wx' });
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST') {
      throw new CliError(
        'invalid_invocation',
        `${path} already exists — pass --force to overwrite`,
        {
          cause: err,
        },
      );
    }
    if (code === 'EISDIR' || code === 'ENOTDIR') {
      throw new CliError(
        'invalid_invocation',
        `cannot write ${path}: the target path is not a file`,
        {
          cause: err,
        },
      );
    }
    throw err;
  }
}

/**
 * Locate an authored file by its in-file `id` across BOTH catalogs (the `relavium export <id>` resolution).
 * Returns the matched kind + the absolute path. A missing id is a clean exit-2 fault; an id that names BOTH a
 * workflow and an agent is ambiguous (exit 2) — disambiguate by renaming one. Only VALID catalog entries match
 * (an unparseable file's slug is a filename FALLBACK, never a real id).
 */
export function resolveById(opts: { projectConfigDir: string; cwd: string; id: string }): {
  kind: AuthoredKind;
  path: string;
} {
  const matches: { kind: AuthoredKind; path: string }[] = [];
  for (const kind of ['workflow', 'agent'] as const) {
    const entry = discoverCatalog({
      projectConfigDir: opts.projectConfigDir,
      cwd: opts.cwd,
      kind: KIND_DIR[kind],
    }).find((e) => e.valid && e.slug === opts.id);
    if (entry !== undefined) {
      matches.push({ kind, path: resolve(opts.cwd, entry.path) });
    }
  }
  if (matches.length === 0) {
    throw new CliError(
      'invalid_invocation',
      `no workflow or agent with id '${opts.id}' in this project.`,
    );
  }
  if (matches.length > 1) {
    throw new CliError(
      'invalid_invocation',
      `'${opts.id}' names both a workflow and an agent — rename one to disambiguate.`,
    );
  }
  return matches[0]!;
}

/** True if a VALID catalog entry of `kind` already has this `slug` (the `import`/`create` collision check). */
export function slugExists(opts: {
  projectConfigDir: string;
  cwd: string;
  kind: AuthoredKind;
  slug: string;
}): boolean {
  return discoverCatalog({
    projectConfigDir: opts.projectConfigDir,
    cwd: opts.cwd,
    kind: KIND_DIR[opts.kind],
  }).some((e) => e.valid && e.slug === opts.slug);
}

/** The `errno` code of a Node fs error (`ENOENT`, `EACCES`, …), or `undefined` if it is not one. */
function errnoCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code: unknown = err.code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}
