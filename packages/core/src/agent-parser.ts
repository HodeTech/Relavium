/**
 * `parseAgent` — the standalone `.agent.yaml` parser, the agent sibling of {@link ./parser.ts}'s
 * `parseWorkflow`. It loads an agent-document **string**, decodes it through the one hardened YAML profile
 * ({@link ./yaml-decode.ts}), and validates against the strict `@relavium/shared` `AgentSchema` (ADR-0023),
 * producing a typed `AgentDefinition` or a typed, field-named, secret-free {@link AgentParseError}.
 *
 * Pure by contract (like `parseWorkflow`): it takes text, never a path — the host surface (CLI catalog scan
 * 2.I, the authoring commands 2.J) reads the file and passes the string plus an optional workspace-relative
 * label. An agent file is plain config (model/provider/system_prompt/tools); it carries no secret VALUES (keys
 * live in the keychain, ADR-0006), but the error still echoes only field *paths*, never an authored value.
 */

import { LineCounter, YAMLParseError } from 'yaml';
import type { ZodIssue } from 'zod';

import { AgentSchema, type Agent } from '@relavium/shared';

import { MAX_SOURCE_CHARS } from './parser.js';
import { decodeHardenedYaml } from './yaml-decode.js';

/** The validated agent document — `@relavium/shared`'s `Agent`, under a parser-local alias (mirrors `WorkflowDefinition`). */
export type AgentDefinition = Agent;

export interface ParseAgentOptions {
  /** A workspace-relative label for the source, used ONLY in the error message — never resolved or read from disk. */
  readonly source?: string;
}

/**
 * A typed, secret-free agent parse failure — a YAML syntax fault or a schema rejection. Narrow on `code`,
 * never on `message`. `fields` lists the failing field *paths* (key names / indices only, no authored values).
 * For an `agent_syntax` YAML fault the `line`/`column` (1-based) of the fault are attached when the loader
 * reports a position — parity with `WorkflowSyntaxError` (errors.ts) — and are also folded into the message.
 */
export class AgentParseError extends Error {
  readonly code: 'agent_syntax' | 'agent_validation';
  readonly fields: readonly string[];
  /** 1-based line of a YAML syntax fault, when the loader reports a position (`agent_syntax` only). */
  readonly line?: number;
  /** 1-based column of a YAML syntax fault, when the loader reports a position (`agent_syntax` only). */
  readonly column?: number;
  constructor(
    code: 'agent_syntax' | 'agent_validation',
    message: string,
    fields: readonly string[] = [],
    opts?: { readonly cause?: unknown; readonly line?: number; readonly column?: number },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AgentParseError';
    this.code = code;
    this.fields = fields;
    if (opts?.line !== undefined) {
      this.line = opts.line;
    }
    if (opts?.column !== undefined) {
      this.column = opts.column;
    }
  }
}

/** A secret-free ` (source — line L, column C)` locator suffix from a workspace-relative source label and/or a
 *  YAML position. Only field-name/integer context — never an authored value or a source snippet. Empty when
 *  neither is known. The ` (line L, column C)` shape mirrors the config loader's TOML suffix (config/load.ts). */
function locate(source: string | undefined, pos?: { line: number; col: number }): string {
  const parts = [
    source,
    pos === undefined ? undefined : `line ${pos.line}, column ${pos.col}`,
  ].filter((part): part is string => part !== undefined);
  return parts.length === 0 ? '' : ` (${parts.join(' — ')})`;
}

/**
 * Normalize a YAML decode throw to a typed, secret-free `agent_syntax` error, attaching the fault's line/column
 * (1-based) when the loader reports a position — the agent sibling of parser.ts's `syntaxErrorFrom`, so agent
 * files get the same actionable diagnostics as workflow files. `prettyErrors: false` (yaml-decode.ts) keeps the
 * `YAMLParseError` message the RULE alone — no source snippet, no authored key/value — so echoing it is safe.
 */
function agentSyntaxErrorFrom(
  err: unknown,
  source: string | undefined,
  lineCounter: LineCounter,
): AgentParseError {
  if (err instanceof YAMLParseError) {
    // `err.pos[0]` is -1 when the loader has no offset for the fault (a bare stream error); `linePos(-1)` would
    // return a nonsensical {line:0, col:-1}, so skip it and emit a positionless error (mirrors parser.ts).
    const posOffset = err.pos[0];
    const pos = posOffset >= 0 ? lineCounter.linePos(posOffset) : undefined;
    return new AgentParseError('agent_syntax', `${err.message}${locate(source, pos)}`, [], {
      cause: err,
      ...(pos === undefined ? {} : { line: pos.line, column: pos.col }),
    });
  }
  if (err instanceof Error && /alias/i.test(err.message)) {
    // `maxAliasCount: 0` throws a plain `ReferenceError` ("Alias resolution is disabled") with no position —
    // surface a clear, source-free message rather than the generic fallback (parity with parser.ts).
    return new AgentParseError(
      'agent_syntax',
      `anchors and aliases are not supported${locate(source)}`,
    );
  }
  return new AgentParseError(
    'agent_syntax',
    `the agent file is not valid YAML${locate(source)}`,
    [],
    {
      cause: err,
    },
  );
}

/**
 * Parse + validate an agent YAML string. Throws {@link AgentParseError} (`agent_syntax` on a YAML fault,
 * `agent_validation` on a schema failure) — an invalid file never yields an `AgentDefinition`.
 */
export function parseAgent(yamlText: string, opts?: ParseAgentOptions): AgentDefinition {
  const source = opts?.source;
  const label = locate(source);

  if (yamlText.length > MAX_SOURCE_CHARS) {
    throw new AgentParseError(
      'agent_syntax',
      `the agent source exceeds the ${MAX_SOURCE_CHARS}-character parse limit${label}`,
    );
  }

  // Hoisted (not inlined) so a YAML fault's byte offset can be resolved to a line/column AFTER the throw.
  const lineCounter = new LineCounter();
  let raw: unknown;
  try {
    raw = decodeHardenedYaml(yamlText, lineCounter);
  } catch (err) {
    throw agentSyntaxErrorFrom(err, source, lineCounter);
  }

  const result = AgentSchema.safeParse(raw);
  if (!result.success) {
    // Field PATHS only (key names / indices) — never an authored value, so the message stays secret-free. For
    // an `unrecognized_keys` issue Zod puts the unknown key NAMES in `issue.keys` (not the path), so name those
    // — prefixed with the parent path for a NESTED `.strict()` object (`retry`, `mcp_servers[i]`, memory) so the
    // context isn't lost, and bare at the root (empty path) — mirroring parser.ts's field locator.
    const fields = [
      ...new Set(
        result.error.issues.flatMap((issue: ZodIssue) => {
          if (issue.code === 'unrecognized_keys') {
            const prefix = issue.path.length > 0 ? `${issue.path.map(String).join('.')}.` : '';
            return issue.keys.map((key) => `${prefix}${key}`);
          }
          return [issue.path.map(String).join('.') || 'agent'];
        }),
      ),
    ];
    throw new AgentParseError(
      'agent_validation',
      `invalid agent${label}: ${fields.join(', ')}`,
      fields,
    );
  }
  return result.data;
}
