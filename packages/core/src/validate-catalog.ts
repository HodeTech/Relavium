import type { CapabilityFlags } from '@relavium/llm';

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
 * Is the requested output-modality set a MEMBER of a model's declared `outputCombinations` (ADR-0031
 * decision #3)? Output capability is a per-model **combination** constraint — the requested set must
 * exactly match one declared combination, not merely be a subset of the union of all of them.
 */
function isOutputComboSupported(
  combos: readonly (readonly string[])[],
  requested: readonly string[],
): boolean {
  return combos.some(
    (combo) => combo.length === requested.length && requested.every((m) => combo.includes(m)),
  );
}

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
    if (!isOutputComboSupported(caps.media.outputCombinations, node.output_modalities)) {
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
