/**
 * The engine-side `ToolRegistry` + dispatch (1.T). Pure: it owns tool POLICY + DISPATCH and performs
 * every side effect through the injected {@link ToolHost} (ADR-0037). The dispatch lifecycle's order is
 * security-load-bearing — the effective argument set is assembled and validated BEFORE the guardrail
 * checks, so a `tool` node (whose args come entirely from `input_mapping`, no model args) cannot bypass
 * the allowlist by being checked before its args exist. The canonical contract is
 * [tool-registry.md](../../../../docs/reference/shared-core/tool-registry.md).
 */

import { extractHttpsHost, type ToolActionClass } from '@relavium/shared';

import { boundForModel, redactInlineMedia, redactSecretShapedValue } from './bounding.js';
import {
  ToolArgsInvalidError,
  ToolCancelledError,
  ToolDeniedByUserError,
  ToolDispatchError,
  ToolExecutionError,
  ToolPolicyError,
  UnknownToolError,
} from './errors.js';
import { markUntrusted } from './untrusted.js';
import {
  DEFAULT_TOOL_RESULT_LIMITS,
  type CreateToolRegistryOptions,
  type PolicyTarget,
  type ToolActionPreview,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
  type ToolCallPart,
  type ToolDef,
  type ToolDispatchContext,
  type ToolDispatchOutcome,
  type ToolHost,
  type ToolId,
  type ToolResultPart,
} from './types.js';

/** Build the engine-side tool registry. Performs no I/O and reads no ambient state (engine purity). */
export function createToolRegistry(options: CreateToolRegistryOptions): {
  dispatch(toolCall: ToolCallPart, ctx: ToolDispatchContext): Promise<ToolDispatchOutcome>;
  has(id: ToolId): boolean;
  list(): readonly ToolId[];
} {
  const tools = new Map<ToolId, ToolDef>();
  for (const def of options.tools) {
    if (tools.has(def.id)) {
      throw new Error(`duplicate tool id \`${def.id}\` registered`);
    }
    tools.set(def.id, def);
  }
  const host = options.host;

  return {
    has: (id) => tools.has(id),
    list: () => [...tools.keys()].sort((a, b) => a.localeCompare(b)),
    dispatch: (toolCall, ctx) => dispatch(tools, host, toolCall, ctx),
  };
}

async function dispatch(
  tools: ReadonlyMap<ToolId, ToolDef>,
  host: ToolHost,
  toolCall: ToolCallPart,
  ctx: ToolDispatchContext,
): Promise<ToolDispatchOutcome> {
  throwIfAborted(ctx, undefined);

  // A provider-executed tool_call is NOT dispatched by the engine (content.ts; ADR-0030/0029) — the
  // engine never runs it or applies its allowlist. Surfacing it here is a caller bug.
  if (toolCall.providerExecuted === true) {
    throw new ToolPolicyError(
      toolCall.name,
      'provider_executed',
      `tool \`${toolCall.name}\` is provider-executed and is not dispatched by the engine`,
    );
  }

  // 1. Resolve by exact id, then check the node grant (registered ≠ authorized).
  const def = tools.get(toolCall.name);
  if (def === undefined) {
    throw new UnknownToolError(toolCall.name, [...tools.keys()]);
  }
  if (!ctx.grantedToolIds.has(def.id)) {
    throw new ToolPolicyError(
      def.id,
      'not_granted',
      `tool \`${def.id}\` is not granted to node \`${ctx.nodeId}\``,
    );
  }

  // 2. Assemble the effective argument set (model args + input_mapping + config-only, config wins).
  const effective = assembleArgs(def, toolCall.args, ctx);

  // 3. Validate the COMPLETE effective set: secret-taint first (ADR-0029(c)), then the tool's validator.
  assertNoTaintedArgs(def.id, effective, ctx.secretArgKeys);
  let args: unknown;
  try {
    args = def.parseArgs(effective);
  } catch (cause) {
    throw toArgsInvalid(def.id, cause);
  }

  // 4. Enforce the guardrail policy on the EFFECTIVE args (the resolved command/URL is now real). The
  //    policy target is resolved once here and reused by the per-tool approval step (4b) below.
  const target = def.policyTarget?.(args) ?? {};
  enforcePolicy(def, target, ctx);

  // 4b-7. The per-tool approval gate + the single side effect + output_mapping (FULL result) + model-facing
  // bounding — all under one classification ladder so a spill-time (or prompt-time) abort surfaces as
  // `cancelled` (ADR-0036 precedence) and any other tail failure is a classified tool error, never a raw
  // escape. A `ToolDeniedByUserError` from 4b is a `ToolDispatchError` and passes through the ladder verbatim
  // — UNLESS the signal is concurrently aborted, in which case the `isAbort` check below takes precedence
  // (cancel-wins-all, ADR-0036) and the denial becomes `ToolCancelledError`.
  let outputMapped: unknown;
  let bounded: Awaited<ReturnType<typeof boundForModel>>;
  try {
    throwIfAborted(ctx, def.id);
    // 4b. Per-tool approval (ADR-0057 EA3): under the interactive-approval regime (chat), a governed-class
    //     dispatch REQUIRES a confirmAction decision before the side effect; the workflow author-trust path
    //     (no `ctx.approval`) skips it. A denial is a fatal `tool_denied`; an abort while prompting is cancelled.
    await confirmDispatch(def, target, ctx);
    const output = await def.dispatch(args, host, ctx);
    // Abort that lands AFTER the host resolved must still classify as cancelled, not a success.
    throwIfAborted(ctx, def.id);
    // 6. output_mapping runs on the FULL result → workflow state keeps the real value.
    outputMapped = applyOutputMapping(output, ctx.config.outputMapping);
    // 7. Bound the MODEL-FACING result (the full result is untouched above).
    bounded = await boundForModel(
      output,
      ctx.limits ?? DEFAULT_TOOL_RESULT_LIMITS,
      host,
      ctx.signal,
    );
    // An abort that lands during bounding (its async fast path yields a microtask) must still classify
    // as cancelled, not a success — the symmetric guard to line 109 after the dispatch await.
    throwIfAborted(ctx, def.id);
  } catch (cause) {
    if (cause instanceof ToolCancelledError) {
      throw cause; // already classified (e.g. throwIfAborted) — never double-wrap
    }
    // Cancel-wins-all (ADR-0036 cancel precedence): once the run's signal is aborted, any failure on
    // this path closes the step as `cancelled`, even a typed ToolDispatchError (e.g. a capability gap).
    // The deterministic error re-surfaces on the next, non-cancelled run; a torn-down run stays cancelled.
    if (isAbort(cause, ctx)) {
      throw new ToolCancelledError(def.id, cause);
    }
    if (cause instanceof ToolDispatchError) {
      throw cause; // a typed error from dispatch (e.g. ToolUnavailableError) passes through
    }
    // Stamp whether the failure is safe to feed back to the model for a within-turn retry (ADR-0057): ONLY an
    // IDEMPOTENT tool — one `governedAction` does not classify as a side-effecting fs_write/process/egress/os
    // action (a read: read_file / list_directory / git_status / invoke_agent / read_media). A governed tool's
    // failure is non-idempotent (a half-run command, a POST that may have landed), so it is NOT recoverable.
    throw new ToolExecutionError(def.id, `tool \`${def.id}\` failed`, cause, {
      recoverable: governedAction(def, target) === undefined,
    });
  }

  // 8. Brand the model-facing result untrusted + shape the sanitized event payloads.
  const toolResult: ToolResultPart = {
    type: 'tool_result',
    toolCallId: toolCall.id,
    result: bounded.value,
  };
  return {
    output: outputMapped,
    toolResult: markUntrusted(toolResult),
    truncated: bounded.truncated,
    events: {
      call: { toolId: def.id, toolInput: sanitizeInput(def, effective, ctx.secretArgKeys) },
      result: { toolId: def.id, success: true, outputSummary: bounded.summary },
    },
  };
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 2 — effective args. Precedence: model args (base) < input_mapping (author-wired) < config-only.
 * A config-only param's value comes ONLY from `ctx.config.parameters` — neither a model argument nor an
 * `input_mapping` value may supply one (ADR-0037: "a model argument can never override one", enforced by
 * the engine, not by convention). Prototype-polluting keys are dropped from every source.
 * ------------------------------------------------------------------------------------------------ */

/** Keys that would walk/poison the prototype chain — never a legitimate tool argument name. */
const UNSAFE_ARG_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function assembleArgs(
  def: ToolDef,
  modelArgs: unknown,
  ctx: ToolDispatchContext,
): Record<string, unknown> {
  const configOnly = new Set(def.configOnlyParams ?? []);
  const effective: Record<string, unknown> = {};
  // 1. Model-supplied args are the base — but a config-only key from the model is dropped (config is its
  //    only source) and a prototype-polluting key is never copied.
  copyArgs(effective, modelArgs, configOnly);
  // 2. Author-wired input_mapping — same exclusions, so a config-only value cannot enter via state either.
  copyArgs(effective, ctx.config.inputMapping, configOnly);
  // 3. Config-only params — the ONE source for these (config wins; absent ⇒ the tool's own default).
  const params = ctx.config.parameters;
  if (params !== undefined) {
    for (const key of configOnly) {
      if (UNSAFE_ARG_KEYS.has(key)) {
        continue;
      }
      if (Object.hasOwn(params, key)) {
        effective[key] = params[key];
      }
    }
  }
  return effective;
}

/** Copy own keys from `source` into `target`, skipping the `exclude` set and prototype-polluting names. */
function copyArgs(
  target: Record<string, unknown>,
  source: unknown,
  exclude: ReadonlySet<string>,
): void {
  if (!isRecord(source)) {
    return;
  }
  for (const key of Object.keys(source)) {
    if (UNSAFE_ARG_KEYS.has(key) || exclude.has(key)) {
      continue;
    }
    target[key] = source[key];
  }
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 3 — secret taint (ADR-0029(c), re-applied on the effective set) + arg validation.
 * ------------------------------------------------------------------------------------------------ */

function assertNoTaintedArgs(
  toolId: ToolId,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): void {
  if (secretArgKeys === undefined || secretArgKeys.size === 0) {
    return;
  }
  const tainted = Object.keys(effective).filter((key) => secretArgKeys.has(key));
  if (tainted.length > 0) {
    const sorted = tainted.toSorted((a, b) => a.localeCompare(b));
    throw new ToolArgsInvalidError(
      toolId,
      sorted,
      `tool \`${toolId}\`: a secret-typed value cannot flow into tool arguments (${sorted.join(
        ', ',
      )}) — use a credential reference (ADR-0029)`,
    );
  }
}

function toArgsInvalid(toolId: ToolId, cause: unknown): ToolArgsInvalidError {
  const fields = zodIssuePaths(cause);
  const where = fields.length > 0 ? ` (${fields.join(', ')})` : '';
  return new ToolArgsInvalidError(
    toolId,
    fields,
    `tool \`${toolId}\`: invalid arguments${where}`,
    cause,
  );
}

/** Extract field paths from a ZodError-shaped cause — names only, never the received value. */
function zodIssuePaths(cause: unknown): readonly string[] {
  if (!isRecord(cause)) {
    return [];
  }
  const issues = cause['issues'];
  if (!Array.isArray(issues)) {
    return [];
  }
  const paths = new Set<string>();
  for (const issue of issues) {
    if (isRecord(issue)) {
      const path = issue['path'];
      if (Array.isArray(path)) {
        paths.add(path.map(String).join('.') || '(root)');
      }
    }
  }
  return [...paths].sort((a, b) => a.localeCompare(b));
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 4 — guardrail policy on the effective args.
 * ------------------------------------------------------------------------------------------------ */

function enforcePolicy(def: ToolDef, target: PolicyTarget, ctx: ToolDispatchContext): void {
  if (def.policy.requiresGateApproval && !ctx.gateApproved) {
    throw new ToolPolicyError(
      def.id,
      'gate_required',
      `tool \`${def.id}\` requires a human-gate approval in an automated workflow`,
    );
  }

  if (def.policy.spawnsProcess && target.command !== undefined) {
    if (!commandAllowed(target.command, ctx.toolPolicy)) {
      throw new ToolPolicyError(
        def.id,
        'command_not_allowed',
        `tool \`${def.id}\`: command not in the allowedCommands allowlist`,
      );
    }
  }

  if (def.policy.egress === 'http' && target.url !== undefined) {
    enforceHttpEgress(def.id, target.url, ctx);
  }
  // egress 'search' / 'mcp' reach a CONFIGURED provider/server (not an allowedDomains allowlist); the
  // SSRF range-block runs inside the host egress capability. No engine allowlist check here.
}

function commandAllowed(command: string, policy: import('@relavium/shared').ToolPolicy): boolean {
  const exact = policy.allowedCommands ?? [];
  if (exact.includes(command)) {
    return true; // exact match (ADR-0029(a)) — `git` never authorizes `git push --force`
  }
  for (const glob of policy.allowedCommandGlobs ?? []) {
    if (globMatch(glob, command)) {
      return true; // opt-in glob
    }
  }
  return false; // empty/absent ⇒ deny-all (symmetry with allowedDomains)
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 4b — per-tool approval (ADR-0057 EA3). Fail-closed under an active interactive-approval regime;
 * a no-op on the workflow author-trust path (no `ctx.approval`) so the workflow path is unchanged.
 * ------------------------------------------------------------------------------------------------ */

async function confirmDispatch(
  def: ToolDef,
  target: PolicyTarget,
  ctx: ToolDispatchContext,
): Promise<void> {
  const approval = ctx.approval;
  if (approval === undefined) {
    return; // the workflow author-trust path — governed tools proceed under the enforcePolicy floor above
  }
  const action = governedAction(def, target);
  if (action === undefined) {
    return; // a read-only / pre-approved tool (fs read, git_status, invoke_agent) is never gated
  }
  // Fail-closed: an active approval regime with no confirm hook DENIES a governed dispatch — so a wiring bug
  // (the chat host wired a write arm but not the hook) can never let `ask` mode write. The floor is the hook,
  // not the advertise-filter.
  if (approval.confirm === undefined) {
    throw new ToolDeniedByUserError(
      def.id,
      'no_approval_hook',
      `tool \`${def.id}\` requires interactive approval, but no approval hook is wired`,
    );
  }
  throwIfAborted(ctx, def.id); // do not prompt for a turn that is already aborting

  const request: ToolApprovalRequest = {
    toolId: def.id,
    action,
    preview: previewFor(action, target),
  };
  // EA5: emit the observability event for EVERY governed dispatch that reaches this gate, just before the host
  // decides — a durable "a governed action was gated" trace on the session / `--json` stream (the session
  // stamps the envelope + nodeId), whether the host then prompts a human or auto-decides. Side-effect only — a
  // throwing or absent emitter must NOT change the fail-closed floor, so it is best-effort (swallow any fault;
  // a schema-invalid drift would throw inside the sink's parse and is dropped here rather than breaking the turn).
  try {
    approval.emitApprovalRequested?.(request);
  } catch {
    /* an observability emit must never break the approval decision */
  }

  let decision: ToolApprovalDecision;
  try {
    decision = await approval.confirm(request, ctx.signal);
  } catch (cause) {
    // An abort raised WHILE prompting is a cancellation (cancel precedence) — rethrow so the dispatch
    // ladder classifies it as `cancelled`, never a denial. Any OTHER throw is a fault in the consent layer
    // itself; the approval can't be obtained, so fail-closed: DENY (the side effect must not run on a broken
    // gate — never the retryable `tool_failed` a host-capability throw gets).
    if (isAbort(cause, ctx)) {
      throw cause;
    }
    throw new ToolDeniedByUserError(
      def.id,
      'approval_error',
      `tool \`${def.id}\` denied: the approval could not be obtained`,
    );
  }
  if (decision.outcome !== 'approve') {
    // `decision.reason` is a host-supplied, secret-free label (e.g. "writes are not allowed in ask mode").
    const why =
      decision.reason !== undefined && decision.reason.length > 0
        ? `: ${decision.reason}`
        : ' by the user';
    throw new ToolDeniedByUserError(def.id, 'user_rejected', `tool \`${def.id}\` denied${why}`);
  }
  // An abort that landed WHILE the prompt was pending — the hook approved anyway / ignored the signal —
  // must still cancel: the governed side effect must not run. Mirrors the post-dispatch guard in dispatch()
  // (cancel precedence). Without this, an `approve` that resolves after the signal aborted would proceed.
  throwIfAborted(ctx, def.id);
}

/**
 * Classify a dispatch's governed ACTION class — the authoritative confirmAction floor — or `undefined` for an
 * un-gated tool. A model-controlled `run_command` (a resolved `command` target) is `process`; the pre-approved
 * `git_status` (no command target) is NOT governed — matching `enforcePolicy`, which runs the command allowlist
 * only when a command target is present. An fs READ and `invoke_agent` are not governed
 * ([ADR-0041](../../../../docs/decisions/0041-external-action-governance-seam.md) §ActionClass); every egress
 * IS, even a read-only `web_search` (an exfiltration sink); and an `os` action (`read_clipboard` / `notify`)
 * IS — the clipboard is ambient, un-jailed OS state that routinely holds a freshly-copied secret (ADR-0057).
 * Exported (from this module, NOT the package index) so a drift-lock test can pin the exact engine-governed
 * set, distinct from the CLI advertise-filter's superset.
 */
export function governedAction(def: ToolDef, target: PolicyTarget): ToolActionClass | undefined {
  if (def.policy.fsWrite === true) {
    return 'fs_write';
  }
  if (def.policy.egress !== undefined) {
    return 'egress';
  }
  if (def.policy.spawnsProcess && target.command !== undefined) {
    return 'process';
  }
  if (def.policy.os === true) {
    return 'os';
  }
  return undefined;
}

/** A secret-free preview for the approval prompt: the resolved path / command / host (never a full URL). */
function previewFor(action: ToolActionClass, target: PolicyTarget): ToolActionPreview {
  switch (action) {
    case 'fs_write':
      return target.path === undefined ? {} : { path: target.path };
    case 'process':
      return target.command === undefined ? {} : { command: target.command };
    case 'egress': {
      if (target.url === undefined) {
        return {}; // web_search / mcp_call expose no pre-dispatch URL target — the action class is enough
      }
      const parsed = extractHttpsHost(target.url);
      return parsed === null ? {} : { host: parsed.host };
    }
    case 'os':
      // read_clipboard / notify carry no path/command/host target — the action class + the tool id (on the
      // approval request) are the whole preview (the prompt reads "Approve read_clipboard?").
      return {};
    default: {
      // Exhaustiveness guard — a future ToolActionClass member fails loud HERE at compile time (the `never`
      // assignment) with a precise error, not a generic "not all paths return".
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

function enforceHttpEgress(toolId: ToolId, url: string, ctx: ToolDispatchContext): void {
  const parsed = extractHttpsHost(url);
  if (parsed === null || parsed.hasCredentials) {
    throw new ToolPolicyError(
      toolId,
      'insecure_url',
      `tool \`${toolId}\`: outbound URL must be HTTPS without embedded credentials`,
    );
  }
  const allowed = ctx.toolPolicy.allowedDomains ?? [];
  if (!allowed.includes(parsed.host)) {
    throw new ToolPolicyError(
      toolId,
      'domain_not_allowed',
      `tool \`${toolId}\`: host not in the allowedDomains allowlist`,
    );
  }
  // The SSRF range-block (private/loopback/link-local/metadata) + connect-pinning is the host egress
  // capability's job (the one shared primitive, 1.AE) — never re-implemented in the pure engine.
}

/**
 * A minimal glob: `*` (any run, incl. empty) and `?` (exactly one char); everything else is literal;
 * full-string match. Implemented as a **linear-time** iterative matcher with a single backtrack point
 * for the last `*` — NOT a compiled RegExp. A RegExp translation (`a*a*a*…`) backtracks catastrophically
 * (ReDoS) on an author-supplied pathological glob; this matcher is O(len(value) × len(glob)) worst case,
 * with no exponential blowup. (`allowedCommandGlobs` is opt-in and author-controlled, but a community /
 * imported workflow is a real threat surface — see ADR-0029.)
 */
function globMatch(glob: string, value: string): boolean {
  let g = 0; // index into glob
  let v = 0; // index into value
  let star = -1; // glob index just past the last `*` seen, or -1
  let mark = 0; // value index to resume from when backtracking the last `*`
  while (v < value.length) {
    const gc = glob[g];
    if (gc === '?' || (gc !== undefined && gc !== '*' && gc === value[v])) {
      g++;
      v++;
    } else if (gc === '*') {
      star = ++g; // `*` matches zero chars first; remember where to extend it
      mark = v;
    } else if (star >= 0) {
      g = star; // mismatch — let the last `*` swallow one more char of value
      v = ++mark;
    } else {
      return false;
    }
  }
  while (glob[g] === '*') {
    g++; // trailing `*`s match the empty remainder
  }
  return g === glob.length;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 6 — output_mapping (full result → workflow-state projection).
 * ------------------------------------------------------------------------------------------------ */

function applyOutputMapping(
  full: unknown,
  mapping: Readonly<Record<string, string>> | undefined,
): unknown {
  if (mapping === undefined) {
    return full;
  }
  const out: Record<string, unknown> = {};
  for (const [stateKey, path] of Object.entries(mapping)) {
    if (UNSAFE_ARG_KEYS.has(stateKey)) {
      continue; // a `__proto__` stateKey would mutate `out`'s prototype, not add an own property
    }
    out[stateKey] = readPath(full, path);
  }
  return out;
}

/**
 * Read a simple dot-path (`a.b.c`) from a value; undefined when any segment is absent. Walks ONLY own
 * data properties (`Object.hasOwn`) — a segment naming an inherited member (`__proto__`, `constructor`,
 * `toString`) returns undefined, never the prototype/constructor function. Mirrors the hardened
 * `interpolation/path.ts` reader; do not regress to a bare `cursor[segment]`.
 */
function readPath(value: unknown, path: string): unknown {
  if (path === '') {
    return value;
  }
  let cursor = value;
  for (const segment of path.split('.')) {
    if (!isRecord(cursor) || !Object.hasOwn(cursor, segment)) {
      return undefined;
    }
    cursor = cursor[segment];
  }
  return cursor;
}

/* ------------------------------------------------------------------------------------------------ *
 * Step 8 — event-input sanitization (config-only + secret-tainted keys removed). The bus does final
 * generic masking (ADR-0036); this strips the tool-aware sensitive fields only the registry knows.
 * ------------------------------------------------------------------------------------------------ */

function sanitizeInput(
  def: ToolDef,
  effective: Record<string, unknown>,
  secretArgKeys: ReadonlySet<string> | undefined,
): Readonly<Record<string, unknown>> {
  const out: Record<string, unknown> = { ...effective };
  for (const key of def.configOnlyParams ?? []) {
    delete out[key];
  }
  if (secretArgKeys !== undefined) {
    for (const key of secretArgKeys) {
      delete out[key];
    }
  }
  // Redact inline media bytes AND secret-shaped values from every surviving arg before it becomes
  // `agent:tool_call.toolInput`: that field rides the event/IPC/log/`--json` stream (an I3 boundary). The
  // `secretArgKeys` deletion above only covers KNOWN top-level key names, so a model-set credential in an
  // arbitrary place (an `http_request` `Authorization` header value, a token in the body or url query) would
  // otherwise pass through — `redactSecretShapedValue` scrubs it by shape, keeping the object keys (header
  // names) intact. Symmetric to the `outputSummary` scrub on the result side — display-only, the dispatch
  // already ran on the real args.
  for (const key of Object.keys(out)) {
    out[key] = redactSecretShapedValue(redactInlineMedia(out[key]));
  }
  return out;
}

/* ------------------------------------------------------------------------------------------------ *
 * Cancellation + small guards.
 * ------------------------------------------------------------------------------------------------ */

function throwIfAborted(ctx: ToolDispatchContext, toolId: ToolId | undefined): void {
  if (ctx.signal?.aborted === true) {
    throw new ToolCancelledError(toolId);
  }
}

function isAbort(cause: unknown, ctx: ToolDispatchContext): boolean {
  if (ctx.signal?.aborted === true) {
    return true;
  }
  return cause instanceof Error && cause.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
