/**
 * `WorkflowYAMLParser` (1.L / 1.L2) — the engine's entry point. Loads a `.relavium.yaml` **string**,
 * validates it against the strict `@relavium/shared` `WorkflowSchema` (ADR-0023), and runs the static
 * interpolation gates (1.L2), producing a typed `WorkflowDefinition` or a typed, field-named,
 * secret-free error.
 *
 * Three reject stages, in order: a YAML syntax fault → {@link WorkflowSyntaxError}; a schema failure
 * or a context value that reads a node output → {@link WorkflowValidationError}; a secret reaching
 * agent/human text → {@link WorkflowSecretLeakError} (ADR-0029(c)). All three are field-named and
 * secret-free, so an invalid file never yields a `WorkflowDefinition` and a run never starts on one.
 *
 * Pure by contract: it takes text (never a path), reads no filesystem, touches no environment, and
 * holds no state — the host surface (CLI / desktop / VS Code) reads the file and passes the string
 * plus an optional workspace-relative label in. Node-existence, `$ref`/`agent_ref` resolution, handle
 * resolution, and the cycle check are the DAG builder's job (1.M); interpolation *evaluation* is the
 * runtime resolver's job (`resolveTemplate`/`resolveContext`, 1.L2). The taint check here is static —
 * it reads an input's *type*, never its value.
 */

import { LineCounter, parse as parseYaml, YAMLParseError } from 'yaml';
import type { ZodIssue } from 'zod';

import { WorkflowSchema, type Workflow } from '@relavium/shared';

import {
  WorkflowSecretLeakError,
  WorkflowSyntaxError,
  WorkflowValidationError,
  type WorkflowIssue,
} from './errors.js';
import { analyzeContextReferences, analyzeSecretTaint } from './interpolation/analyze.js';

/** The validated workflow document — `@relavium/shared`'s `Workflow`, under a parser-local alias. */
export type WorkflowDefinition = Workflow;

export interface ParseWorkflowOptions {
  /**
   * A workspace-relative label for the source, used ONLY in error messages — never resolved or read
   * from disk. The host reads the file and passes the text + this label; the parser stays pure.
   */
  readonly source?: string;
}

/** A pre-parse character cap (≈ bytes for authored ASCII) — workflow files are small; a DoS guard. */
const MAX_SOURCE_CHARS = 2 * 1024 * 1024; // 2 MiB

/**
 * Parse + validate a workflow YAML string. Throws {@link WorkflowSyntaxError} on a YAML fault or
 * {@link WorkflowValidationError} (field-named, secret-free) on a schema failure — an invalid file
 * never yields a `WorkflowDefinition`, so a run never starts on one.
 */
export function parseWorkflow(yamlText: string, opts?: ParseWorkflowOptions): WorkflowDefinition {
  const source = opts?.source;

  if (yamlText.length > MAX_SOURCE_CHARS) {
    throw new WorkflowSyntaxError(
      `the source exceeds the ${MAX_SOURCE_CHARS}-character parse limit`,
      source === undefined ? undefined : { source },
    );
  }

  const lineCounter = new LineCounter();
  let raw: unknown;
  try {
    raw = parseYaml(yamlText, {
      // The hardened, deterministic, cross-platform profile (ADR-0035). The decode produces only
      // plain JSON-like data on every surface; strict Zod then enforces the contract.
      version: '1.2',
      schema: 'core', // YAML 1.2 core only — `!!timestamp`/`!!binary` never become a Date/Buffer
      resolveKnownTags: false, // an unknown `!!`-tag stays a string, never a platform object
      merge: false, // no YAML-1.1 `<<` merge keys
      uniqueKeys: true, // a duplicate map key is an error
      stringKeys: true, // complex/non-string keys are rejected (a deterministic object shape)
      maxAliasCount: 0, // anchors/aliases are not part of the authored contract — no alias-bomb expansion
      prettyErrors: false, // no source snippet in the message (secret-free); line/col via the LineCounter
      logLevel: 'error', // no `console.warn` — the parser stays a pure function (no I/O side effect)
      lineCounter,
    });
  } catch (err) {
    throw syntaxErrorFrom(err, source, lineCounter);
  }

  const result = WorkflowSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => describeIssue(issue, raw));
    // No `cause`: the raw ZodError can carry an authored `received` value (an enum/literal/discriminator)
    // and `cause` is publicly reachable — the curated, secret-free `issues` are the diagnostic surface.
    throw new WorkflowValidationError(issues, source === undefined ? undefined : { source });
  }
  const definition = result.data;

  // Static interpolation gates (1.L2) over the now-typed definition — both read structure only.
  const contextIssues = analyzeContextReferences(definition);
  if (contextIssues.length > 0) {
    throw new WorkflowValidationError(contextIssues, source === undefined ? undefined : { source });
  }
  const leaks = analyzeSecretTaint(definition);
  if (leaks.length > 0) {
    throw new WorkflowSecretLeakError(leaks, source === undefined ? undefined : { source });
  }
  return definition;
}

/** Normalize ANY parse-stage throw (a YAML fault, an anchor/alias `ReferenceError`, …) to a typed error. */
function syntaxErrorFrom(
  err: unknown,
  source: string | undefined,
  lineCounter: LineCounter,
): WorkflowSyntaxError {
  if (err instanceof YAMLParseError) {
    // With `prettyErrors: false` the message is the rule alone (no code-frame, no authored content);
    // the position comes from the LineCounter, so the source text is never carried into the error.
    // `err.pos[0]` is -1 when the yaml library has no position for the fault (e.g. a bare stream
    // error); lineCounter.linePos(-1) would return a nonsensical {line:0, col:-1}, so skip it.
    const posOffset = err.pos[0];
    const pos = posOffset >= 0 ? lineCounter.linePos(posOffset) : undefined;
    return new WorkflowSyntaxError(err.message, {
      ...(source === undefined ? {} : { source }),
      ...(pos === undefined ? {} : { line: pos.line, column: pos.col }),
      cause: err,
    });
  }
  if (err instanceof Error && /alias/i.test(err.message)) {
    // `maxAliasCount: 0` makes the resolver throw a plain `ReferenceError` (no position) on any
    // anchor/alias use — surface a clear, source-free message rather than the generic fallback.
    return new WorkflowSyntaxError('anchors and aliases are not supported', {
      ...(source === undefined ? {} : { source }),
      cause: err,
    });
  }
  return new WorkflowSyntaxError('the file is not valid YAML', {
    ...(source === undefined ? {} : { source }),
    cause: err,
  });
}

// --- Zod issue → field-named, secret-free WorkflowIssue --------------------------------------

function describeIssue(issue: ZodIssue, root: unknown): WorkflowIssue {
  return { field: locate(issue.path, root), message: messageFor(issue) };
}

/**
 * Turn a Zod issue path into a human field locator, resolving collection indices to authored names
 * (`nodes[3]` → ``node `summarize` ``) by reading the parsed value. The `workflow:` wrapper segment is
 * dropped. Never echoes a value — only field/collection names and ids, which are not secrets.
 */
function locate(path: ReadonlyArray<string | number>, root: unknown): string {
  const spec = asRecord(asRecord(root)?.['workflow']);
  const tokens: string[] = [];
  let i = path[0] === 'workflow' ? 1 : 0;
  for (; i < path.length; i += 1) {
    const seg = path[i];
    const next = path[i + 1];
    if (typeof seg === 'string' && typeof next === 'number') {
      tokens.push(itemLabel(spec, seg, next));
      i += 1; // consume the index segment too
    } else if (typeof seg === 'number') {
      tokens.push(`[${seg}]`);
    } else if (seg !== undefined) {
      tokens.push(seg);
    }
  }
  return tokens.length === 0 ? 'workflow' : tokens.join('.');
}

/**
 * A well-formed identifier (the shape of a valid id/name/key) — only such a value is echoed into a
 * field locator, so an INVALID authored value (e.g. an id that failed kebab validation, which may be
 * arbitrary text or a misplaced secret) is never reflected back; it falls back to a positional `#n`.
 */
const SAFE_LABEL = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

function itemLabel(
  spec: Record<string, unknown> | undefined,
  collection: string,
  index: number,
): string {
  const item = asRecord(asArray(spec?.[collection])?.[index]);
  const named = (key: string, prefix: string): string => {
    const value = item?.[key];
    return typeof value === 'string' && value.length <= 64 && SAFE_LABEL.test(value)
      ? `${prefix} \`${value}\``
      : `${prefix} #${index}`;
  };
  switch (collection) {
    case 'nodes':
      return named('id', 'node');
    case 'agents':
      return named('id', 'agent');
    case 'inputs':
      return named('name', 'input');
    case 'context':
      return named('key', 'context');
    case 'edges':
      return `edge #${index}`;
    default:
      return `${collection}[${index}]`;
  }
}

/**
 * A user-facing message for a Zod issue. Deliberately code-derived (type names, key names, enum
 * options) — it never echoes an authored *value*, so a secret in a credential field can never leak.
 *
 * `custom` issues come from `@relavium/shared`'s `superRefine` calls. Today every one of them emits
 * a structural message (schema-defined key names, kebab-id-validated identifiers, type-enum labels)
 * — never an authored *value*. The explicit `case 'custom':` here makes that invariant visible in
 * the call site: if a future refine ever embeds an authored value, this switch is the first place a
 * reviewer should add a safe, value-free override. The `default` branch is the last-resort fallback
 * for Zod codes not yet seen in practice; it returns a generic message so an unknown code can never
 * accidentally surface a payload.
 */
function messageFor(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_type':
      return issue.received === 'undefined'
        ? `missing — expected ${issue.expected}`
        : `expected ${issue.expected}, received ${issue.received}`;
    case 'unrecognized_keys':
      return `unknown key${issue.keys.length === 1 ? '' : 's'}: ${issue.keys
        .map((key) => `\`${key}\``)
        .join(', ')}`;
    case 'invalid_enum_value':
      return `invalid value — expected one of: ${issue.options.map(String).join(', ')}`;
    case 'invalid_union_discriminator':
      return `expected one of: ${issue.options.map(String).join(', ')}`;
    case 'invalid_string':
    case 'too_small':
    case 'too_big':
      // Zod's built-in messages for these codes are purely structural (constraint metadata, not the
      // authored value), so they are safe to surface directly.
      return issue.message;
    case 'custom':
      // All @relavium/shared superRefines emit structural-only messages — see the comment above.
      return issue.message;
    default:
      // A Zod code not explicitly handled — return a generic message rather than risking an echo of
      // an authored value via issue.message (which is code-derived for the built-in codes, but could
      // change in future Zod versions).
      return 'invalid value';
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
  return Array.isArray(value) ? value : undefined;
}
