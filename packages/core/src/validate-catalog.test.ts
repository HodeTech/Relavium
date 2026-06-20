import type { CapabilityFlags } from '@relavium/llm';
import type { OutputModality } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { WorkflowValidationError } from './errors.js';
import { parseWorkflow, type WorkflowDefinition } from './parser.js';
import { validateWorkflowWithCatalog, type WorkflowModelCatalog } from './validate-catalog.js';

/** Capabilities with the given output combinations (input flags off; vision=input.image per the refine). */
function caps(outputCombinations: readonly (readonly OutputModality[])[]): CapabilityFlags {
  return {
    tools: true,
    streaming: true,
    parallelToolCalls: false,
    vision: false,
    promptCache: false,
    reasoning: false,
    media: {
      input: { image: false, audio: false, video: false, document: false },
      outputCombinations: outputCombinations.map((c) => [...c]),
    },
  };
}

/** A one-agent-node workflow with the given model + output_modalities YAML fragment. */
function agentWorkflow(fields: string): WorkflowDefinition {
  return parseWorkflow(
    `schema_version: '1.0'\nworkflow:\n  id: wf\n  nodes:\n    - { id: gen, type: agent, agent_ref: writer${fields} }\n  edges: []`,
  );
}

describe('validateWorkflowWithCatalog (1.AF/D15 — output_modalities load-check)', () => {
  it('passes when the requested output combination is a member of the model outputCombinations', () => {
    const wf = agentWorkflow(", model: m1, output_modalities: ['text', 'image']");
    const catalog: WorkflowModelCatalog = () => caps([['text'], ['text', 'image']]);
    expect(() => validateWorkflowWithCatalog(wf, catalog)).not.toThrow();
  });

  it('SKIPS the load-check for a generative-surface model (output is the generateMedia modality, not outputCombinations) — 1.AG Section C', () => {
    // A generative model's outputCombinations is empty (chat-surface only); without the surface skip this
    // would WRONGLY reject a valid generative node (output_modalities: [image]) once D15 is host-wired.
    const wf = agentWorkflow(", model: gpt-image-1, output_modalities: ['image']");
    const generativeCaps: CapabilityFlags = {
      ...caps([]),
      media: { ...caps([]).media, surface: 'generative' },
    };
    const catalog: WorkflowModelCatalog = () => generativeCaps;
    expect(() => validateWorkflowWithCatalog(wf, catalog)).not.toThrow();
  });

  it('throws a field-named WorkflowValidationError when the model cannot output the combination', () => {
    const wf = agentWorkflow(", model: m1, output_modalities: ['text', 'image']");
    const catalog: WorkflowModelCatalog = () => caps([['text']]); // text-only model
    try {
      validateWorkflowWithCatalog(wf, catalog);
      throw new Error('expected a WorkflowValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      if (error instanceof WorkflowValidationError) {
        expect(error.issues[0]?.field).toBe('node `gen`.output_modalities');
        expect(error.issues[0]?.message).toContain('m1');
      }
    }
  });

  it('DEFERS (no throw) when the model is unresolvable in the catalog', () => {
    const wf = agentWorkflow(", model: unknown-model, output_modalities: ['image']");
    const catalog: WorkflowModelCatalog = () => undefined; // not in the catalog
    expect(() => validateWorkflowWithCatalog(wf, catalog)).not.toThrow();
  });

  it('skips agent nodes with no output_modalities (text-only) or no model', () => {
    const noModalities = agentWorkflow(', model: m1');
    const noModel = agentWorkflow(", output_modalities: ['image']");
    const catalog: WorkflowModelCatalog = () => caps([['text']]); // would reject ['image'] if checked
    expect(() => validateWorkflowWithCatalog(noModalities, catalog)).not.toThrow();
    expect(() => validateWorkflowWithCatalog(noModel, catalog)).not.toThrow();
  });

  it('requires an EXACT combination match (a subset of the union is not a member)', () => {
    const wf = agentWorkflow(", model: m1, output_modalities: ['text', 'image']");
    // The union {text, image} is covered, but no single declared combination is exactly {text, image}.
    const catalog: WorkflowModelCatalog = () => caps([['text'], ['image']]);
    expect(() => validateWorkflowWithCatalog(wf, catalog)).toThrow(WorkflowValidationError);
  });

  it('shares the runtime predicate so the load-time and runtime verdicts cannot diverge (1.AF H2)', () => {
    // The load-check now calls @relavium/llm's isOutputCombinationSupported — the SAME predicate the runtime
    // FallbackChain pre-skip uses. (a) text-only against a no-media `[]`-combo model is always emittable, so
    // an explicit ['text'] must NOT throw (the one case a pure exact-match load-check would have regressed).
    const textOnly = agentWorkflow(", model: m1, output_modalities: ['text']");
    expect(() => validateWorkflowWithCatalog(textOnly, () => caps([]))).not.toThrow();
    // (b) a strict subset of a single declared combination is NOT a member — the divergence the old runtime
    // subset gate admitted (and the load-check rejected). Both gates now reject it identically.
    const subset = agentWorkflow(", model: m1, output_modalities: ['text', 'image']");
    expect(() =>
      validateWorkflowWithCatalog(subset, () => caps([['text', 'image', 'audio']])),
    ).toThrow(WorkflowValidationError);
  });
});
