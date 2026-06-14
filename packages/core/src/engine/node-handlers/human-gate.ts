/**
 * The `human_in_the_loop` node handler (1.Q) — the one node that suspends the run for an external
 * decision. It fills the `paused`/`GateRequest` arm of {@link NodeOutcome} the seam reserved: it resolves
 * the gate's human-facing `message_template` / `assignee` and returns `{ kind: 'paused', gate }`. The
 * engine owns everything after that — generating the gate id, emitting `human_gate:paused`, arming the
 * `timeout_ms` timer, parking the run, and resuming on a `GateDecision` (engine.ts `#settlePaused` /
 * `resume`). The handler is intentionally thin and clock-free: deadlines (`expiresAt`) are the engine's
 * job (only it holds the host clock).
 *
 * **Secrets — two layers.** A `secret`-typed `inputs.*` / `ctx.*` reference in `message_template` /
 * `assignee` is rejected at PARSE time by the secret-taint analyzer (`node-text` category; analyze.ts).
 * A `{{ run.outputs[…] }}` reference is *not* parse-gated (its content is runtime data), but is protected
 * at RUNTIME: the `input` node masks every `secret`-typed input before it enters `run.outputs` (io.ts
 * `maskSecretInputs`) and an agent prompt can't interpolate a secret (the same parse gate), so a raw
 * secret never reaches `ctx.runOutputs` for this handler to surface. Together that lets the gate text
 * resolve against raw inputs without a secret reaching the `human_gate:paused` payload — mirroring the
 * agent's `prompt_template` (agent-runner.ts).
 */

import { resolveTemplate } from '../../interpolation/resolve.js';
import type { ResolverCapabilities, RunScope } from '../../interpolation/scope.js';
import type { GateRequest, NodeExecContext, NodeExecutor, NodeOutcome } from '../node-executor.js';
import { cancelled, failed } from './scope.js';

export interface HumanGateNodeExecutorDeps {
  /** Resolver capabilities for `{{ … }}` in the gate's `message_template` / `assignee` (e.g. `read_file`). */
  readonly resolverCapabilities?: ResolverCapabilities;
}

async function runHumanGate(
  ctx: NodeExecContext,
  deps: HumanGateNodeExecutorDeps,
): Promise<NodeOutcome> {
  const { config } = ctx.vertex;
  if (config.kind !== 'human_in_the_loop') {
    return failed('internal', `the human-gate handler received a '${config.kind}' node`, false);
  }
  if (ctx.signal.aborted) {
    return cancelled();
  }
  const { node } = config;
  // Resolve the human-facing text against inputs + run.outputs (secrets are parse-gated; see file header).
  const scope: RunScope = {
    inputs: ctx.inputs,
    ctx: {},
    outputs: Object.fromEntries(ctx.runOutputs),
  };
  const caps = deps.resolverCapabilities ?? {};
  let message: string;
  let assignee: string | undefined;
  try {
    message =
      node.message_template === undefined
        ? ''
        : await resolveTemplate(node.message_template, scope, caps, ctx.signal);
    assignee =
      node.assignee === undefined
        ? undefined
        : await resolveTemplate(node.assignee, scope, caps, ctx.signal);
  } catch (err) {
    // An interpolation failure is an authoring/data fault, not a transient one — fatal `validation`,
    // matching the agent handler's prompt-resolution failure mapping (agent-runner.ts).
    return failed(
      'validation',
      err instanceof Error ? err.message : 'gate template interpolation failed',
      false,
    );
  }
  const gate: GateRequest = {
    gateType: node.gate_type,
    message,
    ...(assignee === undefined ? {} : { assignee }),
    // A timeout is acted on by the engine only when timeout_ms is set; the action defaults to the safe
    // `reject` (auto-approve is opt-in — dangerous; workflow-yaml-spec.md). expiresAt is the engine's job.
    ...(node.timeout_ms === undefined
      ? {}
      : { timeoutMs: node.timeout_ms, timeoutAction: node.timeout_action ?? 'reject' }),
  };
  return { kind: 'paused', gate };
}

export function createHumanGateNodeExecutor(deps: HumanGateNodeExecutorDeps = {}): NodeExecutor {
  return { execute: (ctx) => runHumanGate(ctx, deps) };
}
