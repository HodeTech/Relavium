import { isOutputCombinationSupported, modelAccepts, type CapabilityFlags } from '@relavium/llm';
import {
  MEDIA_BILLED_MODALITIES,
  type MediaBilledModality,
  type OutputModality,
} from '@relavium/shared';

import { WorkflowValidationError, type WorkflowIssue } from './errors.js';
import type { WorkflowDefinition } from './parser.js';
import { BUILTIN_TOOLS } from './tools/builtins.js';
import type { ToolDef } from './tools/types.js';

/** Type guard: a media-billed output modality (image | audio | video) — no `text`. Avoids an `as` cast when
 *  narrowing a node's `output_modalities` to the billed subset (the generative one-modality load-check). */
function isBilledModality(modality: OutputModality): modality is MediaBilledModality {
  return MEDIA_BILLED_MODALITIES.some((billed) => billed === modality);
}

/**
 * A host-provided model → {@link CapabilityFlags} lookup (1.AF/D15, ADR-0044 §2) — sourced from the DB
 * `model_catalog`. Returns `undefined` for a model the host cannot resolve, in which case the load-check
 * **defers** (no error): the model is unresolvable at load time, so the binding gate is the runtime
 * per-modality `FallbackChain` pre-skip — never a silent runtime drop.
 */
export type WorkflowModelCatalog = (modelId: string) => CapabilityFlags | undefined;

/**
 * Host-supplied facts the load-check cannot derive from the workflow alone.
 *
 * `customEndpoint` answers "is this node's provider configured with a non-official `base_url`?" — the one
 * thing that decides whether the shipped catalog's per-model verdicts apply at all. Absent ⇒ official, which
 * is every host that configures none, so the behaviour is unchanged for them.
 */
export interface CatalogValidateOptions {
  readonly customEndpoint?: (node: WorkflowDefinition['workflow']['nodes'][number]) => boolean;
}

type WorkflowNode = WorkflowDefinition['workflow']['nodes'][number];

/**
 * The generative-surface one-media-modality rule (1.AG Section C, ADR-0045 §1): a `media_surface: 'generative'`
 * model (gpt-image-1, Imagen, TTS) routes to `generateMedia`, whose producible output is the generateMedia
 * modality — NOT the inline `outputCombinations` (empty / chat-surface only). So the inline membership check does
 * not apply, but the SAME `singleBilledModality` rule the runtime dispatch enforces (exactly one of
 * image|audio|video, no text) IS checked here. A generative model ALWAYS produces exactly one media modality, so
 * an OMITTED `output_modalities` is as invalid as a malformed one — both fail fast at load. Returns `undefined`
 * when valid. Secret-free message (a node id + the modality set).
 */
function generativeModalityIssue(
  nodeId: string,
  outputModalities: readonly OutputModality[] | undefined,
): WorkflowIssue | undefined {
  const declared = outputModalities ?? [];
  const billed = declared.filter(isBilledModality);
  if (declared.length === 1 && billed.length === 1) {
    return undefined;
  }
  return {
    field: `node \`${nodeId}\`.output_modalities`,
    message:
      outputModalities === undefined
        ? `a media_surface 'generative' model requires output_modalities to declare exactly one media modality (image | audio | video), but none were authored`
        : `a media_surface 'generative' model requires output_modalities to declare exactly one media modality (image | audio | video) with no text, got [${outputModalities.join(', ')}]`,
  };
}

/** The inline agent a node binds, or `undefined` for a `$ref`'d one this document cannot settle. */
function inlineAgent(node: WorkflowNode, workflow: WorkflowDefinition) {
  if (node.type !== 'agent') return undefined;
  const agent = workflow.workflow.agents?.find(
    (candidate) => !('$ref' in candidate) && candidate.id === node.agent_ref,
  );
  return agent !== undefined && !('$ref' in agent) ? agent : undefined;
}

/**
 * Every model this node could actually dispatch on: the effective primary, then the agent's `fallback_chain`
 * entries in order.
 *
 * **The primary is `node.model ?? agent.model`, not `node.model`.** `node.model` is an OPTIONAL override and
 * `agent.model` is the required one, so the overwhelmingly common authored shape declares the model on the
 * agent and nothing on the node. Keying the load-check on `node.model` alone made it silently inert for that
 * shape — the check appeared to pass because it never ran.
 *
 * **The fallback entries are included because a chain that can serve the request IS a valid workflow.** The
 * runtime pre-skip exists precisely so an incapable primary advances to a capable alternate; refusing such a
 * plan at load would reject a workflow the engine would have run correctly, and would contradict the promise
 * the seam doc makes about that skip.
 */
function candidateModels(node: WorkflowNode, workflow: WorkflowDefinition): readonly string[] {
  if (node.type !== 'agent') return [];
  const agent = inlineAgent(node, workflow);
  const primary = node.model ?? agent?.model;
  if (primary === undefined) return []; // a `$ref`'d agent with no node override — defer to runtime
  return [primary, ...(agent?.fallback_chain?.map((fallback) => fallback.model) ?? [])];
}

/**
 * The AUTHORED tool grant a node would dispatch with — the agent's `tools`, narrowed by the node's own
 * `tools:` when present (ADR-0029: a node narrows, never widens).
 *
 * Returned as a count because the load-check only needs "does this node use tools at all".
 */
function grantedToolCount(node: WorkflowNode, workflow: WorkflowDefinition): number {
  return grantedTools(node, workflow).length;
}

/** The authored tool names a node would dispatch with: the node's `tools:` when present, else its inline agent's. */
function grantedTools(node: WorkflowNode, workflow: WorkflowDefinition): readonly string[] {
  if (node.type !== 'agent') return [];
  return node.tools ?? inlineAgent(node, workflow)?.tools ?? [];
}

/**
 * The per-model TOOL capability load-check (`CR-51`, resolving
 * [ADR-0071](../../../docs/decisions/0071-models-dev-as-the-model-metadata-source.md) §12's deferral).
 *
 * §12 carried the `tool_call` catalog data but deferred GATING it to "a **louder** signal (config-time
 * validation, or a gate-level notice), not a silent drop". This is the first of the two it named. A runtime
 * pre-skip alone would have been the quietest possible signal — it emits no event, and on a single-entry plan
 * it surfaces partway through a run, after upstream nodes have already spent real money.
 *
 * **It refuses only when NO candidate can serve the grant.** A tool-incapable primary with a tool-capable
 * fallback is a working workflow — the pre-skip is what makes it work — so refusing it here would reject a
 * plan the engine runs correctly.
 *
 * Deliberately TOOL-only. There is no authored counterpart for `attachment`: media inputs are runtime values,
 * so nothing at load time can know whether a turn will carry one. That half stays the runtime gate's, and the
 * asymmetry is the honest one rather than a forgotten case.
 */
function toolCapabilityIssue(
  node: WorkflowNode,
  workflow: WorkflowDefinition,
  opts: CatalogValidateOptions | undefined,
): WorkflowIssue | undefined {
  if (grantedToolCount(node, workflow) === 0) return undefined;
  const candidates = candidateModels(node, workflow);
  if (candidates.length === 0) return undefined; // unresolvable — defer to the runtime pre-skip
  // The catalog governs a model id only on the OFFICIAL endpoint. A host that has configured a custom
  // `base_url` for this provider tells us so, and the check DEFERS — the shipped metadata describes a
  // different service that merely shares the id, and refusing on its strength broke the custom-endpoint
  // feature outright. Absent ⇒ official, which is every host that does not configure one.
  if (opts?.customEndpoint?.(node) === true) return undefined;
  if (candidates.some((model) => modelAccepts(model, 'toolCall'))) return undefined;
  // Two phrasings, because "model 'x' does not accept…" is wrong for a multi-entry plan (each entry was
  // checked) and "no model in this node's plan…" is needlessly indirect when there is only one.
  const subject =
    candidates.length === 1
      ? `model '${candidates[0]}' does not accept tool definitions`
      : `no model in this node's plan (${candidates.join(', ')}) accepts tool definitions`;
  return {
    field: `node \`${node.id}\`.model`,
    message: `${subject}, but this node grants tools — pick a tool-capable model, add a tool-capable fallback_chain entry, or remove the grant`,
  };
}

/**
 * Load-check one node against the catalog, returning a {@link WorkflowIssue} or `undefined` when it is fine. A
 * non-agent / model-unspecified node and an unresolvable model both DEFER (no error — see
 * {@link WorkflowModelCatalog}); a generative model delegates to {@link generativeModalityIssue}; otherwise the
 * authored `output_modalities` must be a member of the model's `media.outputCombinations`.
 */
function nodeCatalogIssue(
  node: WorkflowNode,
  catalog: WorkflowModelCatalog,
  workflow: WorkflowDefinition,
  opts: CatalogValidateOptions | undefined,
): WorkflowIssue | undefined {
  if (node.type !== 'agent') {
    return undefined; // not an agent — nothing to load-check
  }
  // FIRST, and before the `node.model` guard below: the tool check resolves its own effective model
  // (`node.model ?? agent.model`) because the common authored shape declares the model on the AGENT and
  // leaves the node's override absent. It is also independent of the host catalog — `modelAccepts` reads the
  // shipped snapshot directly — so the verdict is available even when the host cannot resolve capabilities.
  const toolIssue = toolCapabilityIssue(node, workflow, opts);
  if (toolIssue !== undefined) return toolIssue;
  if (node.model === undefined) {
    return undefined; // the modality checks below need an explicit node model
  }
  const caps = catalog(node.model);
  if (caps === undefined) {
    return undefined; // unresolvable model — defer to the runtime FallbackChain pre-skip (never a silent drop)
  }
  if (caps.media.surface === 'generative') {
    return generativeModalityIssue(node.id, node.output_modalities);
  }
  if (node.output_modalities === undefined) {
    return undefined; // non-generative model, text-only node — nothing to load-check
  }
  if (isOutputCombinationSupported(caps.media.outputCombinations, node.output_modalities)) {
    return undefined;
  }
  return {
    field: `node \`${node.id}\`.output_modalities`,
    message: `model '${node.model}' does not support the output-modality combination [${node.output_modalities.join(', ')}]`,
  };
}

/**
 * Engine-loader pass (1.AF/D15, ADR-0044 §2): validate every agent node's authored `output_modalities`
 * against its resolved model's `media.outputCombinations` membership, using the host-provided `catalog`.
 * Runs as a separate pass because `WorkflowSchema.superRefine` has no model catalog (this is the
 * `packages/core` → `packages/llm` parse-time dependency — not circular, `core` already depends on the
 * seam). A model absent from the catalog is **deferred** (no error — see {@link WorkflowModelCatalog});
 * an incapable model — including a generative-surface model whose `output_modalities` is omitted or is not
 * exactly one media modality — throws a field-named {@link WorkflowValidationError} listing every offending
 * node. Secret-free messages (a model id + the modality set, never a payload). Per-node logic lives in
 * {@link nodeCatalogIssue} so this stays a thin collect-and-throw.
 */
export function validateWorkflowWithCatalog(
  workflow: WorkflowDefinition,
  catalog: WorkflowModelCatalog,
  opts?: CatalogValidateOptions,
): void {
  const issues = workflow.workflow.nodes
    .map((node) => nodeCatalogIssue(node, catalog, workflow, opts))
    .filter((issue): issue is WorkflowIssue => issue !== undefined);
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}

/** A host capability a built-in tool reaches through, which a surface may leave unwired on one path. */
export type ToolHostArm = 'egress' | 'os';

/** The host arm a built-in needs: `os` for the clipboard and notifications, `egress` for HTTP and search. */
function toolHostArm(tool: ToolDef): ToolHostArm | undefined {
  if (tool.policy.os === true) return 'os';
  // MCP reaches through its own host arm, which a run path wires (`host.mcp`), so it needs neither.
  if (tool.policy.egress === 'http' || tool.policy.egress === 'search') return 'egress';
  return undefined;
}

const TOOL_HOST_ARMS: ReadonlyMap<string, ToolHostArm> = new Map(
  BUILTIN_TOOLS.flatMap((tool): [string, ToolHostArm][] => {
    const arm = toolHostArm(tool);
    return arm === undefined ? [] : [[tool.id, arm]];
  }),
);

/**
 * The run-path tool pre-flight (2.6.A, MVP-1): refuse a workflow whose agent node grants a built-in that needs a
 * host arm this path does not wire. The CLI's `relavium run` wires neither egress nor os, so `web_search`,
 * `http_request`, `read_clipboard` or `notify` there is a certain `tool_unavailable` at its first call, partway
 * through a run that may already have spent money; refusing before the run starts is the louder signal. A `$ref`'d
 * agent with no node `tools:` is deferred, as the catalog checks defer it. Throws a {@link WorkflowValidationError}
 * listing every offending node, naming the tool, never a payload.
 */
export function validateWorkflowToolArms(
  workflow: WorkflowDefinition,
  opts: { readonly unwired: readonly ToolHostArm[] },
): void {
  const issues = workflow.workflow.nodes.flatMap((node): WorkflowIssue[] => {
    const tools = grantedTools(node, workflow).filter((tool) => {
      const arm = TOOL_HOST_ARMS.get(tool);
      return arm !== undefined && opts.unwired.includes(arm);
    });
    return tools.length === 0
      ? []
      : [
          {
            field: `node \`${node.id}\`.tools`,
            message: `${tools.join(', ')} ${tools.length === 1 ? 'needs' : 'need'} a host capability this run path does not provide (available in chat) — remove the grant to run this workflow here`,
          },
        ];
  });
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}
