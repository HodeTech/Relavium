import {
  type EffectTier,
  type ToolDef,
  type ToolDispatchContext,
  type ToolHost,
  type ToolPolicyClass,
} from '@relavium/core';

import { stripTerminalControls } from '@relavium/shared';

import type { DiscoveredTool } from './connection.js';
import { McpHostUnavailableError } from './errors.js';
import {
  DiscoveryBudget,
  INGRESS_BOUNDS,
  overSizedDescription,
  toolDefinitionBytes,
} from './ingress-bounds.js';
import { compileJsonSchemaToZod } from './schema-compiler.js';

/**
 * Shape discovered MCP tools into namespaced Relavium `ToolDef`s
 * ([ADR-0052](../../../docs/decisions/0052-inbound-mcp-client-package-lifecycle-registration.md) §3/§4).
 *
 * Each tool becomes a `ToolDef` whose:
 * - **id** is the LLM-visible namespaced name `mcp_{server}_{tool}` (the tool name sanitized to the LLM
 *   tool-name charset; routing never parses the name back — the `dispatch` closure carries the ORIGINAL
 *   `(serverId, toolName)`, so a name containing `_` is never ambiguous);
 * - **parseArgs** is the executable validator the in-house compiler builds from the server's `inputSchema`
 *   (the dispatch gate — the SDK does not validate args); an `inputSchema` outside the supported subset
 *   **drops the tool at discovery** (fail closed), never admits it unvalidated;
 * - **policy** is the shared `egress: 'mcp'` class (mirrors the `mcp_call` built-in);
 * - **dispatch** routes through the host's `McpCapability` (`host.mcp.call`) — the engine never touches the SDK.
 *
 * A per-server `tools_allowlist` narrows which tools are admitted, and a post-sanitization id collision across
 * tools **fails closed** (the colliding tool is skipped, never silently shadowing another). Skipped tools are
 * returned so the host can surface them.
 */

const MCP_TOOL_POLICY: ToolPolicyClass = {
  fsScoped: false,
  spawnsProcess: false,
  egress: 'mcp',
  requiresGateApproval: false,
};

/** The LLM tool-name charset (Anthropic/OpenAI) — the namespaced id must match this exactly. */
const LLM_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const MAX_TOOL_NAME_LENGTH = 128;

export interface SkippedTool {
  /** The server's tool name, TERMINAL-SANITIZED — see {@link buildServerToolDefs}'s `skip`. */
  readonly name: string;
  /** Why it was dropped, TERMINAL-SANITIZED — a reason can quote the server's own schema text. */
  readonly reason: string;
}
export interface ServerToolDefs {
  readonly defs: readonly ToolDef[];
  readonly skipped: readonly SkippedTool[];
}

/**
 * Build the `ToolDef`s for one server's discovered tools. `serverId` is the routing key the host's
 * `McpCapability` resolves to a connection AND the namespace segment — the caller passes a namespace-safe id
 * (an agent ref's kebab id, or a sanitized registration name). `allowlist` (the per-server `tools_allowlist`)
 * is the original tool names to admit; omitted ⇒ all discovered tools.
 */
export function buildServerToolDefs(
  serverId: string,
  tools: readonly DiscoveredTool[],
  allowlist?: readonly string[],
  /**
   * A collision set the caller may SHARE across servers (the manager does), so a namespaced id that collides
   * with a tool from ANOTHER server also fails closed — never two `ToolDef`s with one id reaching the registry.
   * Omitted ⇒ a fresh per-call set (intra-server dedup only).
   */
  seenToolIds: Set<string> = new Set<string>(),
): ServerToolDefs {
  const defs: ToolDef[] = [];
  const skipped: SkippedTool[] = [];
  /**
   * The ONE place a refused tool is recorded — sanitized here rather than at whichever surface renders it
   * ([ADR-0088](../../../docs/decisions/0088-the-mcp-boundary-is-hostile.md) §7.1).
   *
   * §7.1 already required this of an ADMITTED tool's `description`, and gave the reason: a poisoned string
   * otherwise reaches a log, an approval prompt and the provider before anyone strips it. The SKIPPED entries
   * are the same bytes from the same hostile source, down the path a hostile server actually takes, and they
   * were carried raw.
   *
   * **The `name` is the live one; the `reason` arm is deliberate defence in depth, and saying so is the
   * point.** No reason string can carry server bytes TODAY — the compiler's refusals do interpolate a key
   * (`unsupported JSON-Schema construct: "<key>"`), but `semanticControlByte` drops such a schema before the
   * compiler sees it, and a test pins that ordering. Sanitizing both anyway is what keeps this a boundary
   * rather than a coincidence of which refusal happens to fire first.
   *
   * This does NOT cross §7.1's presentation/semantic line. A skipped tool has no wire contract left to
   * desynchronise — it was dropped — so its name is pure presentation here, unlike the admitted name that
   * `namespacedId` must round-trip.
   *
   * The CLI's own render sanitizes again (`mcpSkippedLines`), so this closes no live injection there. It
   * closes the SHAPE: `drive-home.tsx` and `doctor-deep.ts` both interpolate these fields directly, and each
   * is one render-site refactor away from being the hole. A boundary every consumer must remember is the
   * boundary that gets forgotten.
   */
  const skip = (name: string, reason: string): void => {
    skipped.push({ name: stripTerminalControls(name), reason: stripTerminalControls(reason) });
  };
  const allow = allowlist === undefined ? undefined : new Set(allowlist);
  // The aggregate half of `CR-42`. Per-item bounds alone do not bound the total: 256 tools at 8 KiB each is
  // 2 MiB before a single schema is counted, and the measured hostile catalogue was 50 000 tools / 52 GB.
  const budget = new DiscoveryBudget();

  // **The DIAGNOSTIC is capped; the TRAVERSAL is not — and conflating the two was a capability-denial bug.**
  // Bounding what is admitted while recording one entry per refused tool just moves the flood: the measured
  // 50 000-tool catalogue produced 50 000 skip entries, each rendered to stderr. But the first version stopped
  // the LOOP at that cap, before the allowlist was even consulted, so a hostile server could hide an
  // explicitly allowlisted tool behind 257 decoys and it was silently never admitted — measured: `defs` came
  // back empty for a catalogue whose allowlisted tool was present. A cap on how much we SAY must never change
  // what we ADMIT.
  let suppressedDiagnostics = 0;
  const noteSkip = (name: string, reason: string): void => {
    if (skipped.length >= INGRESS_BOUNDS.toolsPerServer) {
      suppressedDiagnostics += 1;
      return;
    }
    skip(name, reason);
  };

  for (const [index, tool] of tools.entries()) {
    const outcome = admitTool(tool, index, { serverId, tools, allow, budget, seenToolIds });
    if (outcome.kind === 'exhausted') {
      // The budget is order-stable and refuses everything after it is spent, so this entry is NOT capped —
      // it names the remainder and is the whole diagnostic for every tool behind it.
      skip(tool.name, outcome.reason);
      break;
    }
    if (outcome.kind === 'skip') {
      noteSkip(tool.name, outcome.reason);
      continue;
    }
    seenToolIds.add(outcome.def.id);
    defs.push(outcome.def);
  }

  // One line for everything the cap swallowed, so a host still learns the catalogue was beyond the bounds
  // rather than seeing a diagnostic that simply stops.
  if (suppressedDiagnostics > 0) {
    skipped.push({
      name: '',
      reason: `and ${suppressedDiagnostics} further tool(s) refused — the server's catalogue is beyond the ingress bounds`,
    });
  }
  return { defs, skipped };
}

/**
 * Whether any SEMANTIC field of a discovered tool carries a terminal-control or bidi byte — the fields that
 * cannot be sanitized because rewriting them would desynchronise the model-visible schema, the compiled
 * validator and the wire contract (ADR-0088 §7.1).
 *
 * A legitimate server has no reason to put a control character in a tool name, a property name, or a `const`
 * value. Checked against the serialized schema rather than by walking it, because the serialization is what
 * reaches the provider — and because a walker would have to know every place a string can hide.
 */
function semanticControlByte(tool: DiscoveredTool): string | undefined {
  if (hasControlByte(tool.name)) {
    return 'tool name contains a terminal-control or bidi character';
  }
  return undefined;
}

/**
 * Does this SEMANTIC string carry a control or bidi character?
 *
 * **Not the display sanitizer, and using it here was a real hole.** `stripTerminalControls` is a PRESENTATION
 * primitive: it deliberately preserves TAB and LINE FEED, because stripping them from a description would
 * mangle legitimate text. So `hasControlByte` — defined as "stripping changes the string" — answered `false`
 * for `read\nINJECT`, and both a tool NAME and a schema PROPERTY NAME carrying a newline were admitted.
 * Measured on HEAD before this change.
 *
 * A semantic field has no legitimate use for ANY C0/C1 byte (§7.1's "a legitimate server has no reason to put
 * a control character in a property name"), so this is the strict predicate: the whole C0 range including TAB,
 * LF and CR, DEL, the C1 range, and the Trojan-Source bidi set.
 */
/* eslint-disable no-control-regex */
const SEMANTIC_UNSAFE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
/* eslint-enable no-control-regex */

function hasControlByte(text: string): boolean {
  return SEMANTIC_UNSAFE.test(text);
}

/**
 * The keys whose VALUE is presentation text inside a JSON Schema — sanitized, never a reason to drop a tool.
 *
 * §7.1 draws the line at what a rewrite would break: a `description` or `title` is shown to a model or a
 * human and stripping it changes nothing else, while a property NAME, a `const`/`enum` value or a `required`
 * entry is simultaneously the model-visible schema, the validator's expectation and the wire contract.
 */
const PRESENTATION_KEYS: ReadonlySet<string> = new Set(['description', 'title']);

/** Why a schema was refused, or the cleaned copy to hand the provider. */
type SchemaScan =
  | { readonly ok: true; readonly schema: unknown }
  | { readonly ok: false; readonly reason: string };

/**
 * Walk a JSON Schema, SANITIZING presentation text and failing closed on a semantic field.
 *
 * **The classification was inverted in both directions, and §7.1 spells out both.** The previous walker
 * returned a single boolean for "any string anywhere carries a control byte", which meant a poisoned nested
 * `description` — presentation, per the ADR — dropped the whole tool instead of being cleaned, while a
 * newline in a property NAME sailed through because the predicate it used preserves LF. A server whose
 * descriptions contain a stray escape lost a working tool; a server that put a newline in a key kept one.
 *
 * **A walker rather than a check on the serialized form, and the difference is a hole shipped first.**
 * `JSON.stringify` escapes C0 controls into six-character TEXT (`\u001b`), so the byte being hunted is not in
 * the serialization at all — a property name of `bad\u001b[31m` sailed straight through. It does NOT escape
 * DEL, C1, or the bidi controls, so the serialized check caught some cases and missed others, which is worse
 * than catching none: it reads as a working guard.
 *
 * **Bounded by NODES VISITED, not by depth — and a review proved why that distinction matters.** A first
 * version used a depth ceiling of 16, "mirroring the compiler's `MAX_DEPTH`". It does not mirror it: the
 * compiler counts one level per schema-semantic transition, while a JS walk also descends through each
 * `properties` container, so the walk's depth grows about twice as fast.
 *
 * **Exhausting that budget is its OWN reason**, and reporting it as a control byte was a lie a review caught:
 * a clean 400-property schema the compiler ACCEPTS was dropped with "inputSchema contains a terminal-control
 * or bidi character". The refusal is still correct — a schema this walk cannot finish is one we cannot
 * certify — but the diagnostic has to say what actually happened.
 */
function scanSchema(value: unknown, budget: { visited: number }, depth = 0): SchemaScan {
  const spent = chargeWalk(budget, depth);
  if (spent !== undefined) return spent;
  if (typeof value === 'string') {
    return hasControlByte(value) ? UNSAFE_SCHEMA : { ok: true, schema: value };
  }
  if (Array.isArray(value)) return scanArray(value, budget, depth);
  if (typeof value === 'object' && value !== null) return scanObject(value, budget, depth);
  return { ok: true, schema: value }; // a number, boolean or null carries no text to inspect
}

/** The one refusal for a control byte, so every arm answers with the SAME sentence. */
const UNSAFE_SCHEMA: SchemaScan = {
  ok: false,
  reason: 'inputSchema contains a terminal-control or bidi character',
};

/** Charge one node against the walk budget; `undefined` when there is room left. */
function chargeWalk(budget: { visited: number }, depth: number): SchemaScan | undefined {
  if (depth > MAX_SCHEMA_WALK_DEPTH) {
    return { ok: false, reason: 'inputSchema nests deeper than this boundary will walk' };
  }
  if ((budget.visited += 1) > MAX_SCHEMA_WALK_NODES) {
    return {
      ok: false,
      reason: `inputSchema exceeds the maximum of ${MAX_SCHEMA_WALK_NODES} nodes this boundary will scan`,
    };
  }
  return undefined;
}

function scanArray(
  value: readonly unknown[],
  budget: { visited: number },
  depth: number,
): SchemaScan {
  const out: unknown[] = [];
  for (const item of value) {
    const scanned = scanSchema(item, budget, depth + 1);
    if (!scanned.ok) return scanned;
    out.push(scanned.schema);
  }
  return { ok: true, schema: out };
}

function scanObject(value: object, budget: { visited: number }, depth: number): SchemaScan {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    // A KEY is always semantic — it is a property name, which is the wire contract.
    if (hasControlByte(key)) return UNSAFE_SCHEMA;
    if (PRESENTATION_KEYS.has(key) && typeof item === 'string') {
      out[key] = stripTerminalControls(item);
      continue;
    }
    const scanned = scanSchema(item, budget, depth + 1);
    if (!scanned.ok) return scanned;
    out[key] = scanned.schema;
  }
  return { ok: true, schema: out };
}

/**
 * The scan's total-work ceiling — a DoS backstop, deliberately set so the COMPILER refuses first.
 *
 * **It was `MAX_NODES` (2000), and matching the compiler's number is not the same as matching its budget.**
 * The compiler counts SEMANTIC nodes; this walk also descends through every `properties` container, every key
 * and every array element, so it reaches a given schema's ceiling sooner. Measured at the boundary: the
 * widest schema the compiler ACCEPTS — 500 properties, each a one-member enum — is 2003 raw nodes, so it was
 * refused here while compiling cleanly. A legitimate server lost the tool.
 *
 * Four times the compiler's ceiling makes this a backstop rather than the binding constraint, and the real
 * outer bound is elsewhere anyway: one server's whole discovery payload is capped at 1 MiB
 * ({@link INGRESS_BOUNDS.discoveryBytesPerServer}), which no schema can out-nest.
 */
const MAX_SCHEMA_WALK_NODES = 8000;
/** A stack guard only, deliberately far above any real schema — the NODE budget is the real bound. */
const MAX_SCHEMA_WALK_DEPTH = 128;

/**
 * The LLM-visible namespaced id `mcp_{server}_{tool}` — the tool name's non-charset bytes are mapped to `_`
 * (display only; routing uses the closure, not a name split). Returns `undefined` if the resulting id is not a
 * valid LLM tool id (e.g. an unsafe `serverId`, or an over-length id) so the caller drops the tool.
 */
function namespacedId(serverId: string, toolName: string): string | undefined {
  const id = `mcp_${serverId}_${toolName.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  if (id.length > MAX_TOOL_NAME_LENGTH || !LLM_TOOL_NAME.test(id)) {
    return undefined;
  }
  return id;
}

/** A JSON object, narrowed for  — an array or a scalar is not a usable tool spec. */
function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What one tool's gate sequence decided. `exhausted` stops the walk; `skip` drops just this tool. */
type AdmitOutcome =
  | { readonly kind: 'admit'; readonly def: ToolDef }
  | { readonly kind: 'skip'; readonly reason: string }
  | { readonly kind: 'exhausted'; readonly reason: string };

const skipWith = (reason: string): AdmitOutcome => ({ kind: 'skip', reason });

interface AdmitContext {
  readonly serverId: string;
  readonly tools: readonly DiscoveredTool[];
  readonly allow: ReadonlySet<string> | undefined;
  readonly budget: DiscoveryBudget;
  readonly seenToolIds: ReadonlySet<string>;
}

/**
 * Run one tool through the admission gates, in ORDER.
 *
 * Extracted from `buildServerToolDefs`'s loop body without reordering a single gate — the sequence IS the
 * contract here, and two of its steps are pinned by tests: the description bound runs before the schema is
 * compiled (so a hostile server does not get the expensive part for free), and `semanticControlByte` runs
 * before the compiler (so the compiler's own refusals, which quote server text, cannot reach a diagnostic).
 */
function admitTool(
  tool: DiscoveredTool,
  index: number,
  { serverId, tools, allow, budget, seenToolIds }: AdmitContext,
): AdmitOutcome {
  if (allow !== undefined && !allow.has(tool.name)) {
    return skipWith('not in the server tools_allowlist');
  }
  // **Bounded BEFORE the schema is compiled**, because compiling is the expensive part and a hostile server
  // should not get it for free. The description bound refuses one tool; the budget refuses the rest of the
  // catalogue too, deliberately — see `DiscoveryBudget.admit`.
  const oversized = overSizedDescription(tool.description);
  if (oversized !== undefined) {
    return skipWith(oversized);
  }
  const exhausted = budget.admit(toolDefinitionBytes(tool));
  if (exhausted !== undefined) {
    // `index` rather than `tools.indexOf(tool)` — the old form was an O(n) scan inside the loop over the very
    // catalogue this bound exists to survive, and a duplicate entry would have found the wrong one.
    const remaining = tools.length - index;
    const reason =
      remaining > 1 ? `${exhausted} (and ${remaining - 1} further tool(s))` : exhausted;
    return { kind: 'exhausted', reason };
  }
  if (tool.name.trim() === '') {
    return skipWith('empty tool name');
  }
  const id = namespacedId(serverId, tool.name);
  if (id === undefined) {
    return skipWith('tool name is not a valid LLM tool id after namespacing');
  }
  if (seenToolIds.has(id)) {
    return skipWith(`namespaced id collides with another tool ("${id}")`);
  }
  // **Presentation text is sanitized; a SEMANTIC field is never rewritten** (ADR-0088 §7.1, `#202`).
  //
  // The distinction is load-bearing rather than tidy. A `description` is text shown to a model or a human,
  // and stripping terminal-control bytes from it changes nothing else. A property NAME, a `const`/`enum`
  // value and a `required` entry are simultaneously the model-visible schema, the compiled validator's
  // expectation, and the wire contract with the server — rewriting one desynchronises all three and
  // produces a tool that is broken rather than safe. So a semantic field carrying a control byte drops the
  // TOOL, fail-closed, through the same path an unsupported schema takes.
  const unsafeField = semanticControlByte(tool);
  if (unsafeField !== undefined) {
    return skipWith(unsafeField);
  }

  // Semantic fields fail closed here; presentation text INSIDE the schema is cleaned into a copy (§7.1).
  // The copy is what `llmVisibleParams` carries, so a poisoned nested `description` reaches neither the
  // provider nor a render — and does not cost the server a working tool, which is what dropping it did.
  const scanned = scanSchema(tool.inputSchema, { visited: 0 });
  if (!scanned.ok) {
    return skipWith(scanned.reason);
  }
  // The scan returns `unknown`; `llmVisibleParams` wants a record. A schema that is not an object is not a
  // usable tool spec anyway, and the compiler above would refuse it — check here rather than assert, so the
  // narrowing is a real one.
  const safeSchema = scanned.schema;
  if (!isPlainRecord(safeSchema)) {
    return skipWith('inputSchema must be a JSON object');
  }
  const compiled = compileJsonSchemaToZod(safeSchema);
  if (!compiled.ok) {
    return skipWith(`unsupported inputSchema: ${compiled.reason}`);
  }
  const validator = compiled.schema;
  const originalName = tool.name;
  const def: ToolDef = {
    id,
    source: 'mcp',
    // Sanitized at DISCOVERY, not at whichever surface happens to render it: a poisoned description
    // otherwise reaches a log, an approval prompt and the provider before anyone strips it (§7.1).
    description: stripTerminalControls(tool.description ?? ''),
    parseArgs: (raw: unknown): unknown => validator.parse(raw) as unknown,
    llmVisibleParams: safeSchema,
    policy: MCP_TOOL_POLICY,
    // **Every discovered MCP tool is tier 3, unconditionally** (ADR-0080 §5). Not a placeholder pending
    // richer metadata: an MCP server's own annotations (`readOnlyHint` / `idempotentHint` / …) are
    // attacker-controlled bytes from the very party the hostile-MCP class defends against, so they may
    // never RAISE trust. A server cannot talk its way out of being journaled, and it cannot declare its
    // effects benign either — `duplicationBenign` is first-party-only and is deliberately not set here.
    effect: (): EffectTier => 3,
    dispatch: (args: unknown, host: ToolHost, ctx: ToolDispatchContext): Promise<unknown> => {
      const mcp = host.mcp;
      if (mcp === undefined) {
        throw new McpHostUnavailableError(id);
      }
      return mcp.call({ server: serverId, tool: originalName, args }, ctx.signal);
    },
  };
  return { kind: 'admit', def };
}
