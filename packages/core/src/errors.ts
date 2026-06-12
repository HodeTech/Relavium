/**
 * Typed, discriminated errors thrown by the engine's `WorkflowYAMLParser` (1.L). They mirror the
 * `@relavium/llm` `LlmConfigError` pattern — a base class with a stable `code` discriminant and
 * structured, secret-free context, narrowed on `code` and never on `message`
 * (docs/standards/error-handling.md). The user-facing fields — `message`, `issues`, `field`, the
 * `source` label, and the line/column — name the offending field/node and never carry an authored
 * value, a stack trace, or an absolute path. An internal `cause`, where attached, is a non-secret
 * diagnostic (a YAML rule, never the source text) kept for logs per error-handling.md; the raw
 * ZodError is deliberately NOT attached, as it can carry an authored `received` value.
 */

export type WorkflowParseErrorCode = 'invalid_yaml' | 'schema_validation';

/** One field-named validation problem — the unit the VS Code language server later renders. */
export interface WorkflowIssue {
  /** Human field locator, node-resolved where possible — e.g. ``node `summarize`.model``. */
  readonly field: string;
  /** The user-facing message — no secret value, no absolute path, no raw payload/stack. */
  readonly message: string;
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
