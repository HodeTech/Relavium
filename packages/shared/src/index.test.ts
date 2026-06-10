import { describe, expect, it } from 'vitest';

import * as shared from './index.js';

describe('@relavium/shared public surface', () => {
  it('exports the canonical constants', () => {
    expect(shared.SCHEMA_VERSION).toBe('1.0');
    expect(shared.RUN_EVENT_TYPES).toContain('cost:updated');
    expect(shared.WORKFLOW_NODE_TYPES).toContain('human_gate');
    expect(shared.LLM_PROVIDERS).toEqual(['anthropic', 'openai', 'gemini', 'deepseek']);
    expect(shared.EXECUTION_MODES).toEqual(['local', 'cloud', 'managed']);
    // ADR-0031 modality vocabularies (document is input-only; mediaUnits bills image/audio/video).
    expect(shared.MEDIA_MODALITIES).toEqual(['image', 'audio', 'video', 'document']);
    expect(shared.OUTPUT_MODALITIES).toEqual(['text', 'image', 'audio', 'video']);
    expect(shared.MEDIA_BILLED_MODALITIES).toEqual(['image', 'audio', 'video']);
  });

  it('exports the full canonical schema set', () => {
    const names = [
      'WorkflowSchema',
      'AgentSchema',
      'NodeSchema',
      'EdgeSchema',
      'RunEventSchema',
      'CostUpdatedEventSchema',
      'GateDecisionSchema',
      'RunSchema',
      'GlobalConfigSchema',
      'ProjectConfigSchema',
      // ADR-0031 (1.AD) — the multimodal seam shapes owned by @relavium/shared.
      'ContentPartSchema',
      'DurableContentPartSchema',
      'MediaPartSchema',
      'DurableMediaPartSchema',
      'MediaSourceSchema',
      'DurableMediaSourceSchema',
      'INLINE_MEDIA_CEILING',
      'MEDIA_MESSAGE_CAPS',
      'MEDIA_URL_SOURCE_ENABLED',
      'MEDIA_HANDLE_PATTERN',
      'MediaMimeTypeSchema',
      'mediaModalityOf',
      'decodedBase64ByteLength',
      'containsInlineMediaBytes',
      'refineInFlightMediaPart',
      'persistableMediaRefine',
    ] as const;
    for (const name of names) {
      expect(shared[name]).toBeDefined();
    }
  });

  it('does not leak internal primitives from common.ts', () => {
    const exported = Object.keys(shared);
    for (const internal of [
      'kebabIdSchema',
      'nonEmptyString',
      'positiveInt',
      'nonNegativeInt',
      'findDuplicates',
      'jsonSchemaMetadataSchema',
    ]) {
      expect(exported).not.toContain(internal);
    }
  });
});
