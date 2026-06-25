import { isOutputCombinationSupported, type CapabilityFlags } from '@relavium/llm';
import {
  MEDIA_BILLED_MODALITIES,
  type MediaBilledModality,
  type OutputModality,
} from '@relavium/shared';

import { WorkflowValidationError, type WorkflowIssue } from './errors.js';
import type { WorkflowDefinition } from './parser.js';

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

/**
 * Load-check one node against the catalog, returning a {@link WorkflowIssue} or `undefined` when it is fine. A
 * non-agent / model-unspecified node and an unresolvable model both DEFER (no error — see
 * {@link WorkflowModelCatalog}); a generative model delegates to {@link generativeModalityIssue}; otherwise the
 * authored `output_modalities` must be a member of the model's `media.outputCombinations`.
 */
function nodeCatalogIssue(
  node: WorkflowNode,
  catalog: WorkflowModelCatalog,
): WorkflowIssue | undefined {
  if (node.type !== 'agent' || node.model === undefined) {
    return undefined; // not an agent, or model-unspecified — nothing to load-check
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
): void {
  const issues = workflow.workflow.nodes
    .map((node) => nodeCatalogIssue(node, catalog))
    .filter((issue): issue is WorkflowIssue => issue !== undefined);
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}
