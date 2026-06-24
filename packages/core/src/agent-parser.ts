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

import { LineCounter } from 'yaml';

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
 */
export class AgentParseError extends Error {
  readonly code: 'agent_syntax' | 'agent_validation';
  readonly fields: readonly string[];
  constructor(
    code: 'agent_syntax' | 'agent_validation',
    message: string,
    fields: readonly string[] = [],
    opts?: { readonly cause?: unknown },
  ) {
    super(message, opts?.cause === undefined ? undefined : { cause: opts.cause });
    this.name = 'AgentParseError';
    this.code = code;
    this.fields = fields;
  }
}

/**
 * Parse + validate an agent YAML string. Throws {@link AgentParseError} (`agent_syntax` on a YAML fault,
 * `agent_validation` on a schema failure) — an invalid file never yields an `AgentDefinition`.
 */
export function parseAgent(yamlText: string, opts?: ParseAgentOptions): AgentDefinition {
  const source = opts?.source;
  const label = source === undefined ? '' : ` (${source})`;

  if (yamlText.length > MAX_SOURCE_CHARS) {
    throw new AgentParseError(
      'agent_syntax',
      `the agent source exceeds the ${MAX_SOURCE_CHARS}-character parse limit${label}`,
    );
  }

  let raw: unknown;
  try {
    raw = decodeHardenedYaml(yamlText, new LineCounter());
  } catch (err) {
    throw new AgentParseError('agent_syntax', `the agent file is not valid YAML${label}`, [], {
      cause: err,
    });
  }

  const result = AgentSchema.safeParse(raw);
  if (!result.success) {
    // Field PATHS only (key names / indices) — never an authored value, so the message stays secret-free. For
    // an `unrecognized_keys` issue Zod puts the unknown key NAMES in `issue.keys` (not the path), so name those
    // — prefixed with the parent path for a NESTED `.strict()` object (`retry`, `mcp_servers[i]`, memory) so the
    // context isn't lost, and bare at the root (empty path) — mirroring parser.ts's field locator.
    const fields = [
      ...new Set(
        result.error.issues.flatMap((issue) => {
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
