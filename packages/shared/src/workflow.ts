import { z } from 'zod';

import {
  findDuplicates,
  interpolationNameSchema,
  kebabIdSchema,
  nonEmptyString,
  nonNegativeInt,
  positiveInt,
} from './common.js';
import { ON_EXCEED_ACTIONS, SCHEMA_VERSION } from './constants.js';
import { AgentSchema } from './agent.js';
import { NodeSchema } from './node.js';
import { EdgeSchema } from './edge.js';

/**
 * Workflow YAML schema v1.0 (workflow-yaml-spec.md). A workflow is a
 * git-committable directed graph of nodes; it is a **public API**, so `WorkflowSchema`
 * is the migration anchor (`schema_version`). Authored objects are `.strict()`: an
 * unknown or mistyped key is a validation error, not a silently stripped field — a typo
 * in a committed YAML fails loudly rather than doing nothing (ADR-0023). Evolution
 * across `schema_version`s is handled by the version literal and a migration path, not by
 * tolerating stray keys.
 */

/** How a run is initiated. */
export const TriggerTypeSchema = z.enum([
  'manual',
  'webhook',
  'schedule',
  'file_change',
  'mcp_call',
]);

// `TriggerTypeSchema` above is the flat enum (used by the run record's `triggerType`).
// `TriggerSchema` is the *authored* form: a discriminated union so each type carries
// exactly its required payload (e.g. `webhook` must include `{ path, secret_env }`,
// `manual`/`mcp_call` carry none).
export const TriggerSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }).strict(),
  z
    .object({
      type: z.literal('webhook'),
      webhook: z.object({ path: nonEmptyString, secret_env: nonEmptyString }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('schedule'), schedule: nonEmptyString }).strict(), // cron expression
  z
    .object({
      type: z.literal('file_change'),
      file_change: z.object({ glob: nonEmptyString, debounce_ms: nonNegativeInt }).strict(),
    })
    .strict(),
  z.object({ type: z.literal('mcp_call') }).strict(),
]);
export type Trigger = z.infer<typeof TriggerSchema>;

/** A typed workflow input declaration. */
export const InputTypeSchema = z.enum([
  'string',
  'number',
  'boolean',
  'file_path',
  'code_diff',
  'secret',
]);

/**
 * An optional pre-run check on a declared input (workflow-yaml-spec.md). The engine validates
 * the resolved value before the run starts; a violation fails fast and the run never begins.
 */
export const InputValidationSchema = z
  .object({
    format: nonEmptyString.optional(), // e.g. 'email'
    pattern: nonEmptyString.optional(), // a regex source
    enum: z.array(z.unknown()).optional(),
    min: z.number().optional(),
    max: z.number().optional(),
    min_length: nonNegativeInt.optional(),
    max_length: nonNegativeInt.optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Reject contradictory bounds at parse (ADR-0023: an authored mistake fails loudly).
    if (v.min !== undefined && v.max !== undefined && v.min > v.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'min must be <= max', path: ['min'] });
    }
    if (v.min_length !== undefined && v.max_length !== undefined && v.min_length > v.max_length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'min_length must be <= max_length',
        path: ['min_length'],
      });
    }
  });
export type InputValidation = z.infer<typeof InputValidationSchema>;

/** Which `validation` keys are legal per input `type` (workflow-yaml-spec.md). Module-level so it is
 * allocated once and stays a single source of truth alongside the spec table and the unit tests. */
const VALIDATION_KEYS_BY_TYPE: Record<
  z.infer<typeof InputTypeSchema>,
  readonly (keyof InputValidation)[]
> = {
  number: ['min', 'max', 'enum'],
  string: ['format', 'pattern', 'enum', 'min_length', 'max_length'],
  file_path: ['format', 'pattern', 'enum', 'min_length', 'max_length'],
  code_diff: ['format', 'pattern', 'enum', 'min_length', 'max_length'],
  // A `secret` deliberately loses `enum` (ADR-0083 §6). The ban on a `secret` `default` exists because such
  // a value is written verbatim into `runs.workflow_definition_snapshot`; an `enum` of allowed secret values
  // writes it into the same unmasked column through a neighbouring key, and "the credential is one of these
  // three" is not a contract worth expressing. `pattern` survives because a SHAPE is not a value — the spec
  // says so, and an author who writes a literal there has written the secret down either way.
  secret: ['format', 'pattern', 'min_length', 'max_length'],
  boolean: [],
};

/**
 * The closed `format` vocabulary
 * ([ADR-0083](../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md) §4).
 *
 * Closed, because an open one means each surface inventing its own semantics for `email` — which is the
 * "one engine, every surface" failure this whole item is about. An unrecognised format is an authored error.
 */
export const INPUT_FORMATS = ['email', 'uri', 'uuid', 'date-time'] as const;
export type InputFormat = (typeof INPUT_FORMATS)[number];

/**
 * The ceiling on an authored `pattern`'s SOURCE length (ADR-0083 §4).
 *
 * Not a ReDoS defence on its own — that is `max_length` bounding the input a catastrophic pattern can chew
 * on — but a bound on how baroque an authored regex can get before someone notices they are writing a
 * parser in a validation field.
 */
const PATTERN_MAX_SOURCE = 512;

/**
 * `{{ … }}` — mirroring `packages/core`'s lexer, which `packages/shared` cannot import (the dependency runs
 * the other way).
 *
 * **A terminated pair, not a bare `{{`.** Core treats an unterminated `{{` as ordinary literal text, and a
 * first version of this rule used `includes('{{')` — which rejected `default: 'use {{ to open a mustache'`,
 * a string core would never read a reference in, with no escape available anywhere to express it.
 */
const INTERPOLATION_PAIR = /\{\{[\s\S]*?\}\}/;

/**
 * Does any string ANYWHERE in this value carry an interpolation pair?
 *
 * Recursive, because a `default` is `unknown`: `{ token: '{{secrets.token}}' }` and
 * `['{{secrets.token}}']` are both legal shapes, and a string-only check never looked inside them. Not
 * reachable today — nothing applies a default — but §1's admission gate will, and a parse gate that never
 * looked inside the value it admits is the wrong thing to build under.
 */
function containsInterpolation(value: unknown, seen: WeakSet<object> = new WeakSet<object>()): boolean {
  if (typeof value === 'string') return INTERPOLATION_PAIR.test(value);
  if (typeof value !== 'object' || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => containsInterpolation(item, seen));
  return Object.values(value).some((item) => containsInterpolation(item, seen));
}

/**
 * An authored `pattern` in the EXACT form validation runs it: anchored, flagless.
 *
 * A full match, not a search — "does this value match" is the only question the field can honestly answer
 * across surfaces. Wrapped in a non-capturing group so an alternation cannot escape the anchors: `a|b`
 * becomes `^(?:a|b)$`, not `^a|b$`.
 */
export function anchoredPattern(source: string): RegExp {
  return new RegExp(`^(?:${source})$`);
}

/**
 * Pragmatic `format` checks (ADR-0083 §4).
 *
 * **Pragmatic, and saying so is the point.** These are not RFC-complete — a complete `email` grammar is a
 * parser, and one that disagrees with the mail server's is worse than a shape check. They reject what is
 * obviously not the thing, which is what an authored contract can honestly promise.
 */
const FORMAT_CHECKS: Readonly<Record<InputFormat, RegExp>> = {
  email: /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/,
  uri: /^[a-z][\w+.-]*:\/\/[^\s]+$/i,
  uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  'date-time': /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/,
};

/**
 * Why a VALUE fails its declared input contract, or `undefined` if it passes (ADR-0083 §4).
 *
 * **The single source of truth for both halves.** Parse uses it on a declared `default`; §1's admission gate
 * uses it on a caller-supplied value. Two implementations of one contract is the failure this whole item is
 * about, so there is one — and it is pure, which is what lets admission stay synchronous.
 *
 * Reasons are structural and value-free: they cross into a `WorkflowValidationError` whose messages the CLI
 * re-throws.
 */
export function violatesInputContract(
  value: unknown,
  type: z.infer<typeof InputTypeSchema>,
  validation: InputValidation | undefined,
): string | undefined {
  if (!matchesDeclaredType(value, type)) {
    return `expected a ${type === 'number' ? 'finite number' : type === 'boolean' ? 'boolean' : 'string'}`;
  }
  const v = validation;
  if (v === undefined) return undefined;

  if (v.enum !== undefined && !v.enum.some((member) => Object.is(member, value))) {
    // `Object.is`, decided: `===` makes `NaN` unmatchable and conflates `0` with `-0`; deep equality would
    // promise structural comparison for a field whose members must be primitives anyway.
    return 'value is not one of the allowed enum members';
  }
  if (typeof value === 'number') {
    if (v.min !== undefined && value < v.min) return 'value is below the declared minimum';
    if (v.max !== undefined && value > v.max) return 'value is above the declared maximum';
    return undefined;
  }
  if (typeof value !== 'string') return undefined;

  // Length BEFORE pattern — this ordering is what bounds the input a catastrophic authored regex can chew
  // on, and it is the only ReDoS mitigation this contract honestly offers.
  if (v.min_length !== undefined && value.length < v.min_length) return 'value is shorter than min_length';
  if (v.max_length !== undefined && value.length > v.max_length) return 'value is longer than max_length';
  if (v.format !== undefined) {
    const check = FORMAT_CHECKS[v.format as InputFormat];
    if (check !== undefined && !check.test(value)) return `value is not a valid ${v.format}`;
  }
  if (v.pattern !== undefined && !anchoredPattern(v.pattern).test(value)) {
    return 'value does not match the declared pattern';
  }
  return undefined;
}

/**
 * The `validation` block's own authored semantics (ADR-0083 §4).
 *
 * Separate from `InputValidationSchema`'s bound-ordering refine because these need the declared `type`, and
 * separate from the per-type KEY table because that says which keys are legal, not whether their VALUES are.
 */
function validateValidationBlock(
  input: {
    readonly type: z.infer<typeof InputTypeSchema>;
    readonly validation?: InputValidation | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const v = input.validation;
  if (v === undefined) return;

  if (v.format !== undefined && !(INPUT_FORMATS as readonly string[]).includes(v.format)) {
    // **Value-free.** `parser.ts`'s own comment says every shared `superRefine` emits a structural-only
    // message, and `errors.ts` calls these errors "field-named and secret-free" — the CLI re-throws the
    // first one as a `CliError` message, and YAML double-quoted escapes decode control characters, so an
    // echoed authored value is a terminal-escape path into stdout and every log sink. The issue `path`
    // already names the offending field.
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `unknown format — the vocabulary is ${INPUT_FORMATS.join(', ')}`,
      path: ['validation', 'format'],
    });
  }

  if (v.pattern !== undefined) {
    if (v.pattern.length > PATTERN_MAX_SOURCE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `pattern is longer than ${String(PATTERN_MAX_SOURCE)} characters`,
        path: ['validation', 'pattern'],
      });
    } else {
      // COMPILED at parse in the EXACT form admission will run, so this proves the anchored semantics and
      // not merely bare well-formedness. Compiling `a|b` bare succeeds while `^a|b$` means "starts with a OR
      // ends with b" — a silent change of meaning the author would never see; and `\p{L}+` compiles bare but
      // means the literal `p{L}` without the `u` flag.
      try {
        anchoredPattern(v.pattern);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `pattern is not a valid regular expression`,
          path: ['validation', 'pattern'],
        });
      }
    }
  }

  if (v.enum !== undefined) {
    // An `enum` member of the wrong type can never match, so it is an authored mistake rather than a value
    // that simply never occurs — and catching it at parse is what stops a silently unsatisfiable input.
    v.enum.forEach((member, index) => {
      if (!matchesDeclaredType(member, input.type)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `enum member does not match the declared type '${input.type}'`,
          path: ['validation', 'enum', index],
        });
      }
    });
  }
}

/**
 * Does a value satisfy a declared input `type`? The one place the mapping lives, so parse-time enum checking
 * and run-time admission cannot disagree about what a `number` is.
 *
 * A `number` must be FINITE: `min`/`max` cannot express `NaN` or `±Infinity`, so admitting them would mean
 * a bound that silently does not apply.
 */
export function matchesDeclaredType(
  value: unknown,
  type: z.infer<typeof InputTypeSchema>,
): boolean {
  switch (type) {
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'string':
    case 'file_path':
    case 'code_diff':
    case 'secret':
      return typeof value === 'string';
  }
}

export const WorkflowInputSchema = z
  .object({
    name: interpolationNameSchema, // must be referenceable as `{{inputs.<name>}}`
    type: InputTypeSchema,
    required: z.boolean().optional(),
    default: z.unknown().optional(),
    description: z.string().optional(),
    validation: InputValidationSchema.optional(),
  })
  .strict()
  // ADR-0083 §3/§6 — the three parse-time tightenings, each an authored mistake failing loudly (ADR-0023).
  .superRefine((input, ctx) => {
    // 1. **No interpolation in a `default`.** At admission — which must precede run creation — none of the
    //    three referenceable scopes exists: `{{inputs.*}}` is what admission is resolving, `{{ctx.*}}` is
    //    resolved at run start, and `{{secrets.*}}` may never enter a default at all. It breaks nothing that
    //    works: the engine applied no defaults, so a templated one was already dead.
    if (containsInterpolation(input.default)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'an input `default` may not use `{{ }}` interpolation — it is resolved before any run exists, ' +
          'so `inputs`, `ctx` and `secrets` are all unavailable to it',
        path: ['default'],
      });
    }
    // 2. **No `default` on a `secret`.** Such a value is written verbatim into the durable
    //    `workflow_definition_snapshot` — a plaintext credential at rest.
    if (input.type === 'secret' && input.default !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          'a `secret` input may not declare a `default` — it would be persisted verbatim in the workflow ' +
          'snapshot; supply the value at run time instead',
        path: ['default'],
      });
    }
    // 3. The `validation` block's own semantics (§4), checked here because they need the declared `type`.
    validateValidationBlock(input, ctx);
    // 4. **A declared `default` must satisfy its own declared contract.** The ADR and the spec both said so
    //    and the first implementation did not do it — a review measured a `number` input defaulting to
    //    `'not a number'`, and a `string` default outside its own `enum`, both accepted. That default is the
    //    value §1's admission will hand to a run, and it is unsatisfiable in exactly the way a mistyped
    //    `enum` member is, which this same refine already rejects.
    if (input.default !== undefined) {
      const reason = violatesInputContract(input.default, input.type, input.validation);
      if (reason !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `the declared default violates this input's own contract: ${reason}`,
          path: ['default'],
        });
      }
    }
  })
  // Per-type validation-key compatibility (workflow-yaml-spec.md): a numeric bound on a string, or a
  // *_length on a number, is an authored mistake — reject it. (Bound-ordering is on InputValidationSchema.)
  .superRefine((input, ctx) => {
    if (!input.validation) {
      return;
    }
    const allowedKeys = VALIDATION_KEYS_BY_TYPE[input.type];
    // Defensive: if `type` itself failed enum validation, Zod still runs this refine — bail rather
    // than crash (the type error is already reported on the `type` field).
    if (allowedKeys === undefined) {
      return;
    }
    const allowed = new Set<string>(allowedKeys);
    for (const key of Object.keys(input.validation)) {
      if (!allowed.has(key)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `validation key '${key}' is not allowed for input type '${input.type}'`,
          path: ['validation', key],
        });
      }
    }
  });
export type WorkflowInput = z.infer<typeof WorkflowInputSchema>;

/** A shared variable exposed as `{{ctx.key}}`. */
export const ContextEntrySchema = z
  .object({
    key: interpolationNameSchema, // must be referenceable as `{{ctx.<key>}}`
    value: z.string(),
  })
  .strict();
export type ContextEntry = z.infer<typeof ContextEntrySchema>;

/**
 * Workflow-wide tool guardrails (the canonical home for the command allowlist). `allowedCommands`
 * is exact-match; `allowedCommandGlobs` is the opt-in pattern form (riskier); `allowedDomains` is
 * exact-FQDN for `http_request`. Each empty/absent ⇒ that tool is disabled (ADR-0029).
 */
export const ToolPolicySchema = z
  .object({
    allowedCommands: z.array(nonEmptyString).optional(),
    allowedCommandGlobs: z.array(nonEmptyString).optional(),
    allowedDomains: z.array(nonEmptyString).optional(),
  })
  .strict();
export type ToolPolicy = z.infer<typeof ToolPolicySchema>;

/**
 * Optional resource-governance guardrails (ADR-0028). The cost cap is **pre-egress**: before each
 * LLM call the engine checks `cumulative + worstCaseNextEstimate` against `max_cost_microcents`
 * (integer micro-cents) and applies `on_exceed`. The whole-run `timeout_ms` and the concurrency
 * cap `max_parallel` live alongside `budget` on the workflow spec.
 */
export const BudgetSchema = z
  .object({
    // A declared budget caps at a positive value; omit the `budget` block for no cap. (This
    // differs from `[chat].max_cost_microcents`, an always-present default where 0 = unbounded.)
    max_cost_microcents: positiveInt,
    on_exceed: z.enum(ON_EXCEED_ACTIONS),
    /**
     * Refuse a turn on a model we cannot PRICE (ADR-0071 §K7). **Default `false`.**
     *
     * The cost cap is a safety control, and a model with no price is a hole in it: the governor cannot know what a
     * turn will cost, so it degrades to `allow` and the cap silently does not apply. For most users that is the
     * right trade — a self-hosted model has ~no metered cost, and refusing to run it would be worse than the small
     * risk. But a user who set a cap SPECIFICALLY to bound spend on an untrusted model may want the opposite: if
     * you cannot price it, do not run it. `true` turns the silent degrade into a hard pre-egress refusal.
     */
    strict_cost_cap: z.boolean().optional(),
  })
  .strict();
export type Budget = z.infer<typeof BudgetSchema>;

/**
 * A reference to an external `.agent.yaml` (`{ $ref: './reviewers/security.agent.yaml' }`,
 * workflow-yaml-spec.md). The contract validates only the *shape* here; the **engine** resolves the
 * path against the workspace agent registry (the pure/sync shared schema never reads files) and is
 * where path-traversal/SSRF hardening lives. Keeping the door open lets a workflow bind external
 * agents without inlining them.
 */
export const AgentRefSchema = z.object({ $ref: nonEmptyString }).strict();
export type AgentRef = z.infer<typeof AgentRefSchema>;

/** An `agents:` entry: an inline agent definition, or a `$ref` to an external `.agent.yaml`. */
export const WorkflowAgentSchema = z.union([AgentSchema, AgentRefSchema]);

/** The body under the top-level `workflow:` key. */
export const WorkflowSpecSchema = z
  .object({
    id: kebabIdSchema,
    version: z.string().optional(),
    name: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).optional(),
    // Free-form provenance map — a real schema field, so it survives parse → serialize
    // round-trips (unlike YAML comments). Carries an exported session's transcript (ADR-0026).
    metadata: z.record(z.string(), z.unknown()).optional(),
    trigger: TriggerSchema.optional(),
    inputs: z.array(WorkflowInputSchema).optional(),
    context: z.array(ContextEntrySchema).optional(),
    agents: z.array(WorkflowAgentSchema).optional(), // inline agents or { $ref } to .agent.yaml
    tools: ToolPolicySchema.optional(),
    budget: BudgetSchema.optional(), // pre-egress cost cap (ADR-0028)
    timeout_ms: positiveInt.optional(), // whole-run wall-clock cap
    max_parallel: positiveInt.optional(), // cap on concurrent in-flight LLM calls
    nodes: z.array(NodeSchema).min(1, 'a workflow must declare at least one node'),
    edges: z.array(EdgeSchema),
  })
  .strict();
export type WorkflowSpec = z.infer<typeof WorkflowSpecSchema>;

/** The complete workflow document: `schema_version` + `workflow`. */
export const WorkflowSchema = z
  .object({
    schema_version: z.literal(SCHEMA_VERSION),
    workflow: WorkflowSpecSchema,
  })
  .strict()
  .superRefine((doc, ctx) => {
    const { nodes } = doc.workflow;

    // `merge_fn` is required when `merge_strategy` is `custom`.
    nodes.forEach((node, i) => {
      if (node.type === 'merge' && node.merge_strategy === 'custom' && !node.merge_fn) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: 'merge_fn is required when merge_strategy is "custom"',
          path: ['workflow', 'nodes', i, 'merge_fn'],
        });
      }
    });

    // Referenced identifiers must be unique within a workflow — node ids, input names,
    // context keys, and agent ids are each addressed by reference (edges, `{{inputs.*}}`,
    // `{{ctx.*}}`, `agent_ref`), so a duplicate is an ambiguity, not a forward-compat field.
    const reportDuplicates = (values: string[], label: string, path: (string | number)[]) => {
      const duplicates = findDuplicates(values);
      if (duplicates.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate ${label}: ${duplicates.join(', ')}`,
          path,
        });
      }
    };
    reportDuplicates(
      nodes.map((n) => n.id),
      'node id(s)',
      ['workflow', 'nodes'],
    );
    reportDuplicates(
      (doc.workflow.inputs ?? []).map((i) => i.name),
      'input name(s)',
      ['workflow', 'inputs'],
    );
    reportDuplicates(
      (doc.workflow.context ?? []).map((c) => c.key),
      'context key(s)',
      ['workflow', 'context'],
    );
    reportDuplicates(
      // Only inline agents carry an `id`; a `{ $ref }` entry is resolved (and id-checked) by the engine.
      (doc.workflow.agents ?? []).flatMap((a) => ('id' in a ? [a.id] : [])),
      'agent id(s)',
      ['workflow', 'agents'],
    );

    // `parallel_of` is authoritative for branch membership: an explicit edge out of a
    // `parallel` node must target a node listed in that node's `parallel_of`
    // (workflow-yaml-spec.md). Explicit fan-out edges are redundant with `parallel_of`,
    // but if present they must not contradict it.
    const branchesByParallelId = new Map<string, readonly string[]>();
    for (const node of nodes) {
      if (node.type === 'parallel') branchesByParallelId.set(node.id, node.parallel_of);
    }
    doc.workflow.edges.forEach((edge, i) => {
      // Strip an optional `:handle` to the base node id. `split` always yields >= 1
      // element at runtime; the `?? edge.from` satisfies `noUncheckedIndexedAccess`
      // (which types `[0]` as `string | undefined`) so `fromId` is a plain `string`.
      const fromId = edge.from.split(':')[0] ?? edge.from;
      const branches = branchesByParallelId.get(fromId);
      if (branches && !branches.includes(edge.to)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `edge from parallel node '${fromId}' targets '${edge.to}', which is not in its parallel_of`,
          path: ['workflow', 'edges', i, 'to'],
        });
      }
    });

    // Note: `agent_ref` → agent resolution and `agents` presence are NOT validated here.
    // An agent node's agent may be declared inline, in a sibling `.agent.yaml`, or in the
    // workspace agent registry — only the engine, with the full registry, can resolve it.
  });
export type Workflow = z.infer<typeof WorkflowSchema>;
