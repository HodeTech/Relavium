import { describe, expect, it } from 'vitest';

import { assertMediaCapabilities } from './adapters/shared.js';
import {
  assertStreamable,
  assertSupported,
  isOutputCombinationSupported,
  requestSupportReason,
  requiredCapabilities,
  supportsRequest,
} from './capabilities.js';
import { modelAccepts } from './catalog/lookup.js';
import { UnsupportedCapabilityError } from './errors.js';
import type { CapabilityFlags, LlmRequest } from './types.js';

const ALL: CapabilityFlags = {
  tools: true,
  streaming: true,
  parallelToolCalls: true,
  vision: true,
  promptCache: true,
  reasoning: true,
  // vision === media.input.image (the ADR-0031 derived-alias refine).
  media: {
    input: { image: true, audio: true, video: true, document: true },
    outputCombinations: [['text'], ['text', 'image']],
  },
};
const NONE: CapabilityFlags = {
  tools: false,
  streaming: false,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
  },
};

const TEXT_REQ: LlmRequest = {
  model: 'm',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
};
const TOOL_REQ: LlmRequest = {
  ...TEXT_REQ,
  tools: [{ name: 'f', parameters: { type: 'object' } }],
};

describe('per-MODEL capability gating (CR-51)', () => {
  // The provider-wide flags say what ANTHROPIC or OPENAI can do; `requestCapabilities` says what THIS MODEL
  // does, and the two disagree constantly within one provider. Before this, a request carrying tools for
  // `gpt-3.5-turbo` — which the catalog records as rejecting tool definitions — passed the pre-skip as
  // "supported", so the chain spent a real call to earn a 400 instead of skipping to a model that works.
  //
  // These ids come from the shipped snapshot, so the tests fail loudly rather than vacuously if upstream ever
  // changes what they support (asserted below).
  const TOOL_INCAPABLE = 'gpt-3.5-turbo'; // requestCapabilities: { toolCall: false, … }
  const ATTACHMENT_INCAPABLE = 'deepseek-v4-pro'; // requestCapabilities: { attachment: false }

  const mediaReq = (model: string): LlmRequest => ({
    model,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'media',
            mimeType: 'image/png',
            source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
          },
        ],
      },
    ],
  });

  it('the premise: the catalog really records these models as incapable', () => {
    expect(modelAccepts(TOOL_INCAPABLE, 'toolCall')).toBe(false);
    expect(modelAccepts(ATTACHMENT_INCAPABLE, 'attachment')).toBe(false);
  });

  it('SKIPS a tool request on a model the catalog says rejects tool definitions', () => {
    // The provider flags are fully capable — this is precisely the case a provider-wide boolean cannot express.
    expect(supportsRequest(ALL, { ...TOOL_REQ, model: TOOL_INCAPABLE })).toBe(false);
    expect(supportsRequest(ALL, { ...TOOL_REQ, model: 'claude-opus-4-8' })).toBe(true);
  });

  it('SKIPS a media request on a model the catalog says rejects attachments', () => {
    expect(supportsRequest(ALL, mediaReq(ATTACHMENT_INCAPABLE))).toBe(false);
    expect(supportsRequest(ALL, mediaReq('claude-opus-4-8'))).toBe(true);
  });

  it('does not gate a TEXT request on either flag — only a request that depends on the capability', () => {
    // The gate must be about what the REQUEST needs. A text turn on a tool-incapable model is perfectly fine,
    // and skipping it would strand the chain on a model that could have answered.
    expect(supportsRequest(ALL, { ...TEXT_REQ, model: TOOL_INCAPABLE })).toBe(true);
    expect(supportsRequest(ALL, { ...TEXT_REQ, model: ATTACHMENT_INCAPABLE })).toBe(true);
  });

  it('an EMPTY tools array is not a tool request', () => {
    expect(supportsRequest(ALL, { ...TEXT_REQ, model: TOOL_INCAPABLE, tools: [] })).toBe(true);
  });

  it('degrades to SUPPORTED for a model the catalog cannot describe', () => {
    // A custom `base_url` or a brand-new id has no metadata, and withholding a capability on the strength of
    // missing data would break every self-hosted model. Absent ⇒ accepted, like the rest of the catalog.
    expect(supportsRequest(ALL, { ...TOOL_REQ, model: 'totally-unknown-model-2099' })).toBe(true);
    expect(supportsRequest(ALL, mediaReq('totally-unknown-model-2099'))).toBe(true);
  });

  it('scans BOTH media-bearing positions, not just the top-level part', () => {
    // `tool_result.media` is the other position a media input can occupy, and the sibling provider-side
    // predicate already walks it. Scanning only `part.type === 'media'` left the two disagreeing about the
    // same request — the model gate admitting what the provider gate would refuse — which is a paid 400 on
    // exactly the shape this gate exists to skip for free.
    const inToolResult: LlmRequest = {
      model: ATTACHMENT_INCAPABLE,
      messages: [
        {
          role: 'tool',
          content: [
            {
              type: 'tool_result',
              toolCallId: 'c1',
              result: 'done',
              media: [
                {
                  type: 'media',
                  mimeType: 'image/png',
                  source: { kind: 'handle', ref: `media://sha256-${'a'.repeat(64)}` },
                },
              ],
            },
          ],
        },
      ],
    };
    expect(supportsRequest(ALL, inToolResult)).toBe(false);
    // …and an EMPTY media array is not an attachment, so it must not gate.
    expect(
      supportsRequest(ALL, {
        ...inToolResult,
        messages: [
          {
            role: 'tool',
            content: [{ type: 'tool_result', toolCallId: 'c1', result: 'done', media: [] }],
          },
        ],
      }),
    ).toBe(true);
  });

  it('the two seams agree on EVERY input — the property the whole design rests on', () => {
    // The headline claim is that the pre-skip and the adapter entry "cannot disagree". Asserting each side
    // separately does not pin that: a change to one alone leaves both suites green while the chain admits what
    // the adapter refuses (admit-then-hard-fail), or skips what the adapter would have served. One shared
    // table, both seams, so any divergence is a failure here rather than a surprise in production.
    const cases: { readonly label: string; readonly req: LlmRequest }[] = [
      { label: 'tools on an incapable model', req: { ...TOOL_REQ, model: TOOL_INCAPABLE } },
      { label: 'tools on a capable model', req: { ...TOOL_REQ, model: 'claude-opus-4-8' } },
      {
        label: 'empty tools on an incapable model',
        req: { ...TEXT_REQ, model: TOOL_INCAPABLE, tools: [] },
      },
      { label: 'text on an incapable model', req: { ...TEXT_REQ, model: TOOL_INCAPABLE } },
      { label: 'media on an incapable model', req: mediaReq(ATTACHMENT_INCAPABLE) },
      { label: 'media on a capable model', req: mediaReq('claude-opus-4-8') },
      {
        label: 'unknown model with tools',
        req: { ...TOOL_REQ, model: 'totally-unknown-model-2099' },
      },
    ];
    for (const { label, req } of cases) {
      const skipped = !supportsRequest(ALL, req);
      // The adapter entry is TWO calls, split so the media half runs after the seam schema parse — together
      // they must reproduce the pre-skip's verdict exactly.
      let refused = false;
      try {
        assertSupported('openai', ALL, req);
        assertMediaCapabilities('openai', ALL, req);
      } catch (err) {
        refused = err instanceof UnsupportedCapabilityError;
      }
      expect(refused, label).toBe(skipped);
    }
  });

  it('the refusal names the MODEL as a field, and does not blame the provider', () => {
    // `provider 'openai' does not support 'tools'` would be false twice for `gpt-3.5-turbo`: OpenAI does
    // support tools, and the remedy is to change the model. The id is a field as well as being in the
    // message, per error-handling.md's structured-context rule.
    try {
      assertSupported('openai', ALL, { ...TOOL_REQ, model: TOOL_INCAPABLE });
      expect.unreachable('the incapable model must be refused');
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      if (err instanceof UnsupportedCapabilityError) {
        expect(err.modelId).toBe(TOOL_INCAPABLE);
        expect(err.capability).toBe('tools');
        expect(err.message).not.toMatch(/^provider 'openai' does not support/);
      }
    }
  });

  it('labels an ATTACHMENT refusal as media, even when the request also carries tools', () => {
    // `o3-mini` accepts tools and rejects attachments. Choosing the label from `req.tools` named the one
    // capability that was fine — and `capability` is a typed discriminant callers narrow on.
    // Captured, then asserted OUTSIDE any guard — `expect.unreachable` throws, and an `if (err instanceof
    // X)` inside the catch swallows it, so the test passed even when nothing was refused.
    let thrown: unknown;
    try {
      assertMediaCapabilities('openai', ALL, { ...mediaReq('o3-mini'), tools: TOOL_REQ.tools });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(UnsupportedCapabilityError);
    if (thrown instanceof UnsupportedCapabilityError) {
      expect(thrown.capability).toBe('media');
      expect(thrown.detail).toMatch(/attachments/);
    }
  });
});

describe('capability gating', () => {
  it('derives the required capabilities from the request', () => {
    expect(requiredCapabilities(TEXT_REQ)).toEqual([]);
    expect(requiredCapabilities(TOOL_REQ)).toEqual(['tools']);
  });

  it('gates media PER-MODALITY for the FallbackChain pre-skip (1.AF — not coarse vision)', () => {
    const audioReq: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'audio/wav', source: { kind: 'base64', data: 'aGVsbG8=' } },
          ],
        },
      ],
    };
    // Media is no longer a flat `Capability`: `requiredCapabilities` covers only flat flags (tools).
    expect(requiredCapabilities(audioReq)).toEqual([]);
    const audioOnly: CapabilityFlags = {
      ...NONE,
      tools: true,
      media: {
        input: { image: false, audio: true, video: false, document: false },
        outputCombinations: [],
      },
    };
    // THE FLIP: an audio-capable provider now SERVES an audio request (was coarsely skipped pre-1.AF).
    expect(supportsRequest(audioOnly, audioReq)).toBe(true);
    // An image-incapable provider is skipped for an IMAGE request; a fully-capable one serves it.
    const imageReq: LlmRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'media', mimeType: 'image/png', source: { kind: 'base64', data: 'aQ==' } },
          ],
        },
      ],
    };
    expect(supportsRequest(audioOnly, imageReq)).toBe(false);
    expect(supportsRequest(ALL, imageReq)).toBe(true);
    // Output-combination MEMBERSHIP is part of the pre-skip too.
    const imageOutReq: LlmRequest = { ...TEXT_REQ, outputModalities: ['text', 'image'] };
    expect(supportsRequest(ALL, imageOutReq)).toBe(true); // ALL has ['text','image']
    expect(supportsRequest(audioOnly, imageOutReq)).toBe(false); // outputCombinations []
  });

  it('isOutputCombinationSupported is the ONE exact-membership predicate shared by both gates (1.AF H2)', () => {
    const gemini = [['text'], ['text', 'image'], ['text', 'audio']]; // image+audio never together
    // Exact membership of a declared combination → supported.
    expect(isOutputCombinationSupported(gemini, ['text', 'image'])).toBe(true);
    expect(isOutputCombinationSupported(gemini, ['text', 'audio'])).toBe(true);
    // A wire-INVALID combination the closed set exists to reject (image+audio together) → unsupported.
    expect(isOutputCombinationSupported(gemini, ['text', 'image', 'audio'])).toBe(false);
    // A STRICT SUBSET of a single combo is NOT a member — the old runtime subset gate wrongly ADMITTED
    // this (the H2 divergence: load-check rejected, runtime accepted). Now both reject it.
    expect(isOutputCombinationSupported([['text', 'image', 'audio']], ['text', 'image'])).toBe(
      false,
    );
    // text-only is always emittable, even against a no-media `[]`-combo model (Anthropic/DeepSeek) — so a
    // text request is never wrongly skipped/rejected (the one case pure exact-match would have regressed).
    expect(isOutputCombinationSupported([], ['text'])).toBe(true);
    expect(isOutputCombinationSupported(gemini, ['text'])).toBe(true);
    // A DUPLICATE modality is not a member of a clean equal-length combo (exact-set, no dupes): without the
    // reverse-inclusion check, ['image','image'] (len 2) would falsely match ['text','image'] (len 2).
    expect(isOutputCombinationSupported([['text', 'image']], ['image', 'image'])).toBe(false);
  });

  it('supportsRequest reflects whether the provider can serve the request', () => {
    expect(supportsRequest(ALL, TOOL_REQ)).toBe(true);
    expect(supportsRequest(NONE, TOOL_REQ)).toBe(false);
    expect(supportsRequest(NONE, TEXT_REQ)).toBe(true); // a plain text request needs nothing
  });

  it('assertSupported throws a typed error on an unsupported feature, else passes', () => {
    expect(() => assertSupported('openai', NONE, TOOL_REQ)).toThrowError(
      UnsupportedCapabilityError,
    );
    try {
      assertSupported('openai', NONE, TOOL_REQ);
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedCapabilityError);
      if (err instanceof UnsupportedCapabilityError) {
        expect(err.code).toBe('unsupported_capability');
        expect(err.capability).toBe('tools');
        expect(err.provider).toBe('openai');
      }
    }
    expect(() => assertSupported('anthropic', ALL, TOOL_REQ)).not.toThrow();
    expect(() => assertSupported('anthropic', NONE, TEXT_REQ)).not.toThrow(); // nothing required
  });

  it('assertStreamable throws when the provider cannot stream', () => {
    expect(() => assertStreamable('gemini', NONE)).toThrowError(UnsupportedCapabilityError);
    expect(() => assertStreamable('anthropic', ALL)).not.toThrow();
  });
});

describe('a CUSTOM endpoint is not governed by the shipped catalog (`CR-51` review)', () => {
  // The shipped snapshot is keyed by model id ALONE. An OpenAI-compatible service that serves a
  // tool-capable model under a well-known id inherited that id's OpenAI verdicts — refused at load and
  // skipped in the chain — which breaks the custom-`base_url` feature outright.
  const toolReq: LlmRequest = {
    model: 'gpt-3.5-turbo', // a shipped id the snapshot describes as tool-INCAPABLE
    messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }],
    tools: [{ name: 'read_file', parameters: { type: 'object' } }],
  };

  it('refuses a tool request on the OFFICIAL endpoint (the catalog governs)', () => {
    expect(requestSupportReason(ALL, toolReq)).toMatch(/does not accept tool definitions/);
  });

  it('…and ADMITS the same request when the endpoint is custom', () => {
    // Degrades to accepted — the same default an un-described model already gets, because missing (or
    // foreign) metadata must never withhold a capability a model actually has.
    expect(requestSupportReason(ALL, toolReq, { catalogAuthoritative: false })).toBeNull();
  });
});
