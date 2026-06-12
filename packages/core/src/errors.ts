/**
 * Typed, discriminated errors thrown by the engine's `WorkflowYAMLParser` (1.L) and the `{{ … }}`
 * interpolation engine (1.L2). They mirror the `@relavium/llm` `LlmConfigError` pattern — a base
 * class with a stable `code` discriminant and structured, secret-free context, narrowed on `code`
 * and never on `message` (docs/standards/error-handling.md). The user-facing fields — `message`,
 * `issues`, `field`, `leaks`, the `source` label, and the line/column — name the offending
 * field/node/symbol and never carry an authored value, a stack trace, or an absolute path. An
 * internal `cause`, where attached, is a non-secret diagnostic (a YAML rule, or a host `readFile`
 * error) kept for logs per error-handling.md; the raw ZodError is deliberately NOT attached, as it
 * can carry an authored `received` value.
 *
 * Two families: the parse-time {@link WorkflowParseError} (syntax / schema / secret-leak), thrown by
 * `parseWorkflow`; and the runtime {@link InterpolationError}, thrown while resolving a template
 * against a run scope.
 */

export type WorkflowParseErrorCode =
  | 'invalid_yaml'
  | 'schema_validation'
  | 'secret_interpolation'
  | 'invalid_graph';

/** One field-named validation problem — the unit the VS Code language server later renders. */
export interface WorkflowIssue {
  /** Human field locator, node-resolved where possible — e.g. ``node `summarize`.model``. */
  readonly field: string;
  /** The user-facing message — no secret value, no absolute path, no raw payload/stack. */
  readonly message: string;
}

/** What kind of graph fault a {@link GraphIssue} reports — callers narrow on `kind`, never on `message`. */
export type GraphIssueKind =
  | 'cycle' // the dependency graph has a directed cycle (the run could never start)
  | 'unknown_edge_target' // an edge / branch / `parallel_of` endpoint names a node that does not exist
  | 'invalid_handle' // a `nodeId:handle` edge names a handle the source node does not expose
  | 'dangling_ref'; // an `agent_ref` resolves to no agent (only checked when a resolved-agent registry is supplied)

/**
 * One field-named graph problem found by the DAG builder (1.M). Every field is a *name* — a node id,
 * an edge locator, a handle, or an `agent_ref` field — never an authored value, so a finding is safe
 * to surface and log. The unconstrained `:handle` suffix of an edge `from` is guarded against echo by
 * the builder (a non-identifier handle degrades to a positional `edge #n`).
 */
export interface GraphIssue {
  /** Human field/locator — e.g. ``edge `merge`→`gate```, ``node `gate`.branches[0].target_node``. */
  readonly field: string;
  /** The user-facing, structural message — names nodes/edges/handles, never an authored value. */
  readonly message: string;
  /** Stable discriminant for the fault class. */
  readonly kind: GraphIssueKind;
}

/**
 * One rejected secret interpolation (ADR-0029(c)). Every field is a *name* — an authored input name,
 * context key, or field locator — never a resolved value, so the finding is safe to surface and log.
 */
export interface SecretLeak {
  /** Where the secret was interpolated — e.g. ``node `scan`.prompt_template``. */
  readonly location: string;
  /** The tainted symbol referenced at that site — e.g. `inputs.api_key` or `ctx.creds` (a name). */
  readonly secret: string;
  /**
   * The **immediate** deeper tainted symbol, when laundered through a `context` entry or `input`
   * default — e.g. `inputs.api_key`. This is a single hop (the direct predecessor), not the full
   * chain; v1.0 surfaces one hop for a concise message.
   */
  readonly via?: string;
}

/** Base for every parser error — callers narrow on `code`, never on `message`. */
export abstract class WorkflowParseError extends Error {
  abstract readonly code: WorkflowParseErrorCode;
  /** A workspace-relative source label, when the caller supplied one (never an absolute path). */
  readonly source?: string;

  protected constructor(message: string, source: string | undefined, cause: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    if (source !== undefined) {
      this.source = source;
    }
  }
}

/** The text is not well-formed YAML — a syntax fault, surfaced before any schema check. */
export class WorkflowSyntaxError extends WorkflowParseError {
  readonly code = 'invalid_yaml';
  /** 1-based line of the fault, when the YAML loader reports a position. */
  readonly line?: number;
  /** 1-based column of the fault, when the YAML loader reports a position. */
  readonly column?: number;

  constructor(
    message: string,
    opts?: { source?: string; line?: number; column?: number; cause?: unknown },
  ) {
    super(message, opts?.source, opts?.cause);
    this.name = 'WorkflowSyntaxError';
    if (opts?.line !== undefined) {
      this.line = opts.line;
    }
    if (opts?.column !== undefined) {
      this.column = opts.column;
    }
  }
}

/** The parsed document fails the strict `WorkflowSchema` — one or more field-named issues. */
export class WorkflowValidationError extends WorkflowParseError {
  readonly code = 'schema_validation';
  readonly issues: readonly WorkflowIssue[];

  constructor(issues: readonly WorkflowIssue[], opts?: { source?: string; cause?: unknown }) {
    super(summarize(issues), opts?.source, opts?.cause);
    this.name = 'WorkflowValidationError';
    this.issues = issues;
  }
}

function summarize(issues: readonly WorkflowIssue[]): string {
  const first = issues[0];
  if (first === undefined) {
    return 'workflow validation failed';
  }
  const rest = issues.length - 1;
  const suffix = rest === 1 ? '' : 's';
  const more = rest > 0 ? ` (and ${rest} more issue${suffix})` : '';
  return `${first.field}: ${first.message}${more}`;
}

/**
 * The validated definition is structurally unrunnable as a graph — a dependency cycle, an edge or
 * branch pointing at a missing node, an invalid `nodeId:handle`, or (when a resolved-agent registry is
 * supplied) a dangling `agent_ref`. Thrown by the DAG builder (1.M) so a run never starts on a graph
 * that could not execute. A sibling of {@link WorkflowValidationError}: both reject before a run, both
 * are field-named and secret-free. The raw graph is NOT attached as `cause` (it could echo a value).
 */
export class WorkflowGraphError extends WorkflowParseError {
  readonly code = 'invalid_graph';
  readonly issues: readonly GraphIssue[];

  constructor(issues: readonly GraphIssue[], opts?: { source?: string }) {
    super(summarizeGraph(issues), opts?.source, undefined);
    this.name = 'WorkflowGraphError';
    this.issues = issues;
  }
}

function summarizeGraph(issues: readonly GraphIssue[]): string {
  const first = issues[0];
  if (first === undefined) {
    return 'workflow graph is invalid';
  }
  const rest = issues.length - 1;
  const suffix = rest === 1 ? '' : 's';
  const more = rest > 0 ? ` (and ${rest} more issue${suffix})` : '';
  return `${first.field}: ${first.message}${more}`;
}

/**
 * A `secret`-typed value — or anything transitively derived from one through a `context` entry or an
 * `input` default — reaches agent/human text (`prompt_template`, `system_prompt[_append]`,
 * `message_template`, `assignee`). Rejected at parse so a run never starts on it (ADR-0029(c)). The
 * message names the offending field and the tainted symbol; it never carries the secret's value.
 */
export class WorkflowSecretLeakError extends WorkflowParseError {
  readonly code = 'secret_interpolation';
  readonly leaks: readonly SecretLeak[];

  constructor(leaks: readonly SecretLeak[], opts?: { source?: string; cause?: unknown }) {
    super(summarizeLeaks(leaks), opts?.source, opts?.cause);
    this.name = 'WorkflowSecretLeakError';
    this.leaks = leaks;
  }
}

function summarizeLeaks(leaks: readonly SecretLeak[]): string {
  const first = leaks[0];
  if (first === undefined) {
    return 'secret interpolation rejected';
  }
  const via =
    first.via !== undefined && first.via !== first.secret ? ` (via \`${first.via}\`)` : '';
  const rest = leaks.length - 1;
  const suffix = rest === 1 ? '' : 's';
  const more = rest > 0 ? ` (and ${rest} more leak${suffix})` : '';
  return `${first.location} interpolates the secret \`${first.secret}\`${via} — secrets are rejected from agent/human text (ADR-0029)${more}`;
}

/** Stable discriminant for a runtime interpolation failure — callers narrow on `code`, not `message`. */
export type InterpolationErrorCode =
  | 'unresolved_reference' // a `{{ … }}` head/path resolved to no value (and no `| default(…)` rescued it)
  | 'unknown_namespace' // a reference reads from a namespace the resolver does not serve (e.g. `secrets`)
  | 'unknown_filter' // a pipe filter name is not in the registry
  | 'filter_arity' // a filter was given the wrong number of arguments
  | 'filter_type' // a filter cannot apply to the value's type (e.g. `length` on a number)
  | 'unserializable' // a reference resolved to an object/array used as text without a `| json` filter
  | 'invalid_path' // a malformed property/index access after the head
  | 'read_file_unavailable' // the `read_file` filter ran without a host `readFile` capability
  | 'read_file_failed' // the host `readFile` capability threw (cause kept for logs, off the message)
  | 'aborted'; // the run's `AbortSignal` fired mid-resolution (cooperative cancellation)

/**
 * A runtime interpolation failure raised while *resolving* `{{ … }}` against a run scope (1.L2) —
 * distinct from the parse-time {@link WorkflowParseError} family. User-facing and secret-free: the
 * message names the offending reference (its verbatim `{{ … }}`) and never a resolved value; an
 * absolute path from a host `readFile` failure stays on the `cause` (for logs), never in the message.
 */
export class InterpolationError extends Error {
  readonly code: InterpolationErrorCode;
  /** The offending `{{ … }}` occurrence, verbatim — names the reference, never a resolved value. */
  readonly location?: string;

  constructor(
    code: InterpolationErrorCode,
    message: string,
    opts?: { location?: string; cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'InterpolationError';
    this.code = code;
    if (opts?.location !== undefined) {
      this.location = opts.location;
    }
  }
}

/**
 * Why an expression-sandbox evaluation failed (1.AB) — callers narrow on `reason`, never on
 * `message`. The retryable/fatal split is a pure function of this discriminant
 * (docs/standards/error-handling.md): only a wall-clock-`timeout` trip is retryable (a
 * non-idempotent safety net that may pass on re-execution); every other reason is deterministic and
 * therefore fatal. See [expression-sandbox-spec.md](../../../docs/reference/shared-core/expression-sandbox-spec.md).
 */
export type SandboxErrorReason =
  | 'syntax' // the author's expression is not valid JavaScript (fatal — a retry repeats it)
  | 'runtime' // a thrown Reference/Type/Range error while evaluating (fatal)
  | 'timeout' // the wall-clock deadline tripped (RETRYABLE — the one non-idempotent safety net)
  | 'memory' // the heap cap tripped (fatal)
  | 'stack' // the stack cap tripped (fatal)
  | 'result_type' // a `condition` result was not a boolean/string/number (fatal)
  | 'non_serializable' // a `transform`/`merge_fn` result was not JSON-serializable (fatal)
  | 'scope'; // the injected scope was itself not serializable — an engine/caller fault (fatal)

/**
 * A failure inside the deterministic, resource-capped expression sandbox (ADR-0027, 1.AB) that
 * evaluates `condition` / `transform` / `merge_fn`. Surfaced to the run as the closed `ErrorCode`
 * member `sandbox_error`. The user-facing `message` is a fixed, generic, secret-free string per
 * `reason` — it never echoes the expression source, a variable name, a scope value, or a host stack.
 * Any raw diagnostic (the quickjs `dump()` of the thrown value) is kept on the internal-only
 * {@link detail} for logs, and an `AbortSignal`/host `cause` on the standard `cause` — neither is the
 * user message. Callers narrow on {@link reason} / {@link retryable}, never on `message`.
 */
export class SandboxError extends Error {
  /** The closed-enum run `ErrorCode` this maps to (sse-event-schema.md). */
  readonly code = 'sandbox_error';
  /** Stable fault discriminant — the one field policy (retry vs fail) branches on. */
  readonly reason: SandboxErrorReason;
  /** A pure function of {@link reason}: only a wall-clock `timeout` trip is retryable. */
  readonly retryable: boolean;
  /**
   * Internal-only diagnostic (the scrubbed quickjs error text) for logs keyed by a correlation id —
   * never surfaced as the user message. May carry expression-derived text, never a secret (secrets
   * are filtered out of the scope before evaluation).
   */
  readonly detail?: string;

  constructor(reason: SandboxErrorReason, message: string, opts?: { detail?: string; cause?: unknown }) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'SandboxError';
    this.reason = reason;
    this.retryable = reason === 'timeout';
    if (opts?.detail !== undefined) {
      this.detail = opts.detail;
    }
  }
}
