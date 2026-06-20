import { isOutputCombinationSupported, type CapabilityFlags } from '@relavium/llm';
import { MEDIA_BILLED_MODALITIES } from '@relavium/shared';

import { WorkflowValidationError, type WorkflowIssue } from './errors.js';
import type { WorkflowDefinition } from './parser.js';

/**
 * A host-provided model → {@link CapabilityFlags} lookup (1.AF/D15, ADR-0044 §2) — sourced from the DB
 * `model_catalog`. Returns `undefined` for a model the host cannot resolve, in which case the load-check
 * **defers** (no error): the model is unresolvable at load time, so the binding gate is the runtime
 * per-modality `FallbackChain` pre-skip — never a silent runtime drop.
 */
export type WorkflowModelCatalog = (modelId: string) => CapabilityFlags | undefined;

/**
 * Engine-loader pass (1.AF/D15, ADR-0044 §2): validate every agent node's authored `output_modalities`
 * against its resolved model's `media.outputCombinations` membership, using the host-provided `catalog`.
 * Runs as a separate pass because `WorkflowSchema.superRefine` has no model catalog (this is the
 * `packages/core` → `packages/llm` parse-time dependency — not circular, `core` already depends on the
 * seam). A model absent from the catalog is **deferred** (no error — see {@link WorkflowModelCatalog});
 * an incapable model throws a field-named {@link WorkflowValidationError} listing every offending node.
 * Secret-free messages (a model id + the modality set, never a payload).
 */
export function validateWorkflowWithCatalog(
  workflow: WorkflowDefinition,
  catalog: WorkflowModelCatalog,
): void {
  const issues: WorkflowIssue[] = [];
  for (const node of workflow.workflow.nodes) {
    if (node.type !== 'agent' || node.model === undefined || node.output_modalities === undefined) {
      continue; // not an agent, or text-only / model-unspecified — nothing to load-check
    }
    const caps = catalog(node.model);
    if (caps === undefined) {
      continue; // unresolvable model — defer to the runtime FallbackChain pre-skip (never a silent drop)
    }
    if (caps.media.surface === 'generative') {
      // A `media_surface: 'generative'` model (gpt-image-1, Imagen, TTS) routes to `generateMedia` (1.AG
      // Section C, ADR-0045 §1); its producible output is defined by the generateMedia modality, NOT by the
      // inline `outputCombinations` (which is empty / chat-surface only). The inline membership check does not
      // apply — but the SAME one-media-modality rule the runtime dispatch enforces (`singleBilledModality`:
      // exactly one of image|audio|video, no text) IS checked here, so a malformed generative node fails fast
      // at load rather than only at runtime.
      const billed = node.output_modalities.filter((m) =>
        (MEDIA_BILLED_MODALITIES as readonly string[]).includes(m),
      );
      if (node.output_modalities.length !== 1 || billed.length !== 1) {
        issues.push({
          field: `node \`${node.id}\`.output_modalities`,
          message: `a media_surface 'generative' model requires output_modalities to declare exactly one media modality (image | audio | video) with no text, got [${node.output_modalities.join(', ')}]`,
        });
      }
      continue; // the inline outputCombinations load-check does not apply to a generative model
    }
    if (!isOutputCombinationSupported(caps.media.outputCombinations, node.output_modalities)) {
      issues.push({
        field: `node \`${node.id}\`.output_modalities`,
        message: `model '${node.model}' does not support the output-modality combination [${node.output_modalities.join(', ')}]`,
      });
    }
  }
  if (issues.length > 0) {
    throw new WorkflowValidationError(issues);
  }
}
