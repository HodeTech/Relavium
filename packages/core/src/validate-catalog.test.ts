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

describe('per-model TOOL capability at load time (CR-51, ADR-0071 §12)', () => {
  /** A workflow whose inline agent grants tools, on the given model. */
  function toolGrantingWorkflow(model: string, agentTools = "['read_file']"): WorkflowDefinition {
    return parseWorkflow(
      `schema_version: '1.0'\nworkflow:\n  id: wf\n  agents:\n    - { id: writer, model: ${model}, provider: openai, system_prompt: hi, tools: ${agentTools} }\n  nodes:\n    - { id: n, type: agent, agent_ref: writer, model: ${model} }\n  edges: []`,
    );
  }
  const noCatalog: WorkflowModelCatalog = () => undefined;

  it('REFUSES at load when the model rejects tools and the node grants them', () => {
    // ADR-0071 §12 carried this catalog data but deferred gating it to "a louder signal (config-time
    // validation, or a gate-level notice), not a silent drop". This is that config-time validation. Without
    // it the only signal is a runtime pre-skip that emits no event — the quietest possible one — and on a
    // single-entry plan it surfaces partway through a run, after upstream nodes have spent real money.
    expect(() => validateWorkflowWithCatalog(toolGrantingWorkflow('gpt-3.5-turbo'), noCatalog)).toThrow(
      WorkflowValidationError,
    );
    expect(() => validateWorkflowWithCatalog(toolGrantingWorkflow('gpt-3.5-turbo'), noCatalog)).toThrow(
      /does not accept tool definitions/,
    );
  });

  it('names the NODE and the remedy, before any run id exists', () => {
    try {
      validateWorkflowWithCatalog(toolGrantingWorkflow('gpt-3.5-turbo'), noCatalog);
      expect.unreachable('a tool grant on a tool-incapable model must be refused at load');
    } catch (err) {
      if (err instanceof WorkflowValidationError) {
        expect(err.issues[0]?.field).toBe('node `n`.model');
        expect(err.issues[0]?.message).toMatch(/pick a tool-capable model, or remove the grant/);
      }
    }
  });

  it('allows the same model when the node grants NO tools', () => {
    // The check is about what the node USES, not about the model in the abstract — refusing a text-only node
    // would reject a perfectly valid workflow.
    expect(() =>
      validateWorkflowWithCatalog(toolGrantingWorkflow('gpt-3.5-turbo', '[]'), noCatalog),
    ).not.toThrow();
  });

  it('allows a tool grant on a tool-capable model', () => {
    expect(() =>
      validateWorkflowWithCatalog(toolGrantingWorkflow('claude-opus-4-8'), noCatalog),
    ).not.toThrow();
  });

  it('DEFERS for a model the catalog cannot describe', () => {
    // Same degrade-to-accepted rule the runtime gate uses: a custom `base_url` or a brand-new id must not be
    // denied a capability it has on the strength of missing metadata.
    expect(() =>
      validateWorkflowWithCatalog(toolGrantingWorkflow('totally-unknown-2099'), noCatalog),
    ).not.toThrow();
  });

  it('runs WITHOUT a host catalog — it reads the shipped snapshot directly', () => {
    // Asserted explicitly because the sibling output-modality check defers entirely when the host cannot
    // resolve a model; this one must not, or the louder signal would be absent exactly where it matters most.
    let asked = 0;
    const counting: WorkflowModelCatalog = () => {
      asked += 1;
      return undefined;
    };
    expect(() => validateWorkflowWithCatalog(toolGrantingWorkflow('gpt-3.5-turbo'), counting)).toThrow();
    expect(asked).toBe(0); // refused before the host lookup was needed
  });
});

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

  it('THROWS for a generative-surface model with an invalid output_modalities shape (text mixed / two media) — 1.AG Section C', () => {
    // A generative model produces pure SINGLE-modality media (the runtime singleBilledModality rule): text
    // mixed in, or two media modalities, must fail fast at LOAD — not only at runtime dispatch.
    const generativeCaps: CapabilityFlags = {
      ...caps([]),
      media: { ...caps([]).media, surface: 'generative' },
    };
    const catalog: WorkflowModelCatalog = () => generativeCaps;
    const textMixed = agentWorkflow(", model: gpt-image-1, output_modalities: ['text', 'image']");
    expect(() => validateWorkflowWithCatalog(textMixed, catalog)).toThrow(WorkflowValidationError);
    const twoMedia = agentWorkflow(", model: gpt-image-1, output_modalities: ['image', 'audio']");
    expect(() => validateWorkflowWithCatalog(twoMedia, catalog)).toThrow(WorkflowValidationError);
  });

  it('THROWS for a generative-surface model with NO authored output_modalities (it always produces one media modality) — 1.AG Section C', () => {
    // The output_modalities===undefined short-circuit must NOT pre-empt the generative-surface check: a
    // generative model with no declaration would route to generateMedia and fail the runtime
    // singleBilledModality guard — so it must fail fast at LOAD instead.
    const generativeCaps: CapabilityFlags = {
      ...caps([]),
      media: { ...caps([]).media, surface: 'generative' },
    };
    const noModalities = agentWorkflow(', model: gpt-image-1'); // generative model, output_modalities omitted
    try {
      validateWorkflowWithCatalog(noModalities, () => generativeCaps);
      throw new Error('expected a WorkflowValidationError');
    } catch (error) {
      expect(error).toBeInstanceOf(WorkflowValidationError);
      if (error instanceof WorkflowValidationError) {
        expect(error.issues[0]?.field).toBe('node `gen`.output_modalities');
        expect(error.issues[0]?.message).toContain('none were authored');
      }
    }
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
