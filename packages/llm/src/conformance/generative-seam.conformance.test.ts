import { describe, expect, it } from 'vitest';

import { makeLlmError } from '../llm-error.js';
import { MediaGenResultSchema, MediaJobStatusSchema } from '../types.js';
import type {
  CapabilityFlags,
  LlmProvider,
  MediaGenRequest,
  MediaJobStatus,
} from '../types.js';

/**
 * The GENERATIVE-surface seam-contract conformance suite (1.AG Section E, A5 / [ADR-0045]). The chat
 * conformance suite replays recorded vendor responses through each real adapter; the ASYNC generative arm
 * (a `generateMedia` that returns an opaque `jobId`, then `pollMediaJob` driving pending→done/failed) has
 * NO production adapter yet — the Sora/Veo adapters are deferred to 1.AH. So this suite asserts the SEAM
 * CONTRACT itself against a CONFORMING STUB provider: the exact shape any future async generative adapter
 * must satisfy — the `MediaGenResult` exactly-one-of refine, an opaque non-empty `jobId`, the discriminated
 * `MediaJobStatus` states, and a content-policy refusal classified as the `content_filter` LlmError kind.
 * (The SYNC arm is covered against the real OpenAI adapter by the per-provider suite's `mediaGenerate`
 * scenario; the engine-side poll/checkpoint/resume/cancel loop is covered in `@relavium/core`.)
 */

const KEY = 'generative-seam-test-key';

const GENERATIVE_CAPS: CapabilityFlags = {
  tools: false,
  streaming: false,
  parallelToolCalls: false,
  vision: false,
  promptCache: false,
  reasoning: false,
  media: {
    input: { image: false, audio: false, video: false, document: false },
    outputCombinations: [],
    surface: 'generative',
  },
};

const VIDEO_REQUEST: MediaGenRequest = {
  model: 'conformance-video-model',
  prompt: 'a wave breaking on a beach',
  modality: 'video',
  durationSeconds: 4,
};

/** A stub whose `generateMedia`/`pollMediaJob` are non-optional, so call sites need no narrowing. */
type GenerativeProvider = LlmProvider & {
  generateMedia: NonNullable<LlmProvider['generateMedia']>;
  pollMediaJob: NonNullable<LlmProvider['pollMediaJob']>;
};

/** A conforming async generative provider: `generateMedia` mints an opaque jobId; `pollMediaJob` walks the
 *  scripted status sequence (clamping on the last entry once exhausted). */
function stubAsyncGenerativeProvider(opts: {
  readonly jobId?: string;
  readonly polls: readonly MediaJobStatus[];
}): GenerativeProvider {
  let call = 0;
  return {
    id: 'openai', // any ProviderId — the async seam is provider-agnostic; the adapter holds the vendor↔opaque map
    supports: GENERATIVE_CAPS,
    generate: () => {
      throw new Error('a generative provider exposes no chat generate');
    },
    stream: () => {
      throw new Error('a generative provider exposes no chat stream');
    },
    generateMedia: () => Promise.resolve({ jobId: opts.jobId ?? 'vendor-op-7f3a', raw: {} }),
    pollMediaJob: () => {
      const status = opts.polls[Math.min(call, opts.polls.length - 1)];
      call += 1;
      if (status === undefined) {
        return Promise.reject(new Error('no poll status scripted'));
      }
      return Promise.resolve(status);
    },
  };
}

describe('generative seam — async media job (conformance, A5)', () => {
  it('generateMedia (async): resolves an OPAQUE non-empty jobId and NO media (exactly-one-of)', async () => {
    const provider = stubAsyncGenerativeProvider({ jobId: 'vendor-op-7f3a', polls: [{ state: 'pending' }] });
    const result = await provider.generateMedia(VIDEO_REQUEST, KEY);
    expect(MediaGenResultSchema.safeParse(result).success).toBe(true);
    expect(result.media).toBeUndefined();
    expect(typeof result.jobId).toBe('string');
    expect((result.jobId ?? '').length).toBeGreaterThan(0);
  });

  it('MediaGenResult: rejects carrying BOTH media and jobId, or NEITHER (the refine is the seam guard)', () => {
    const media = { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: 'AAAA' } };
    expect(MediaGenResultSchema.safeParse({ media, jobId: 'x', raw: {} }).success).toBe(false);
    expect(MediaGenResultSchema.safeParse({ raw: {} }).success).toBe(false);
  });

  it('pollMediaJob: pending / done / failed each conform to the discriminated MediaJobStatus', async () => {
    const media: MediaJobStatus = {
      state: 'done',
      media: { type: 'media', mimeType: 'video/mp4', source: { kind: 'base64', data: 'AAAA' } },
    };
    const provider = stubAsyncGenerativeProvider({
      polls: [
        { state: 'pending', progress: 0.5 },
        media,
        {
          state: 'failed',
          error: makeLlmError({ provider: 'openai', kind: 'content_filter', message: 'blocked by policy' }),
        },
      ],
    });
    const first = await provider.pollMediaJob('job', KEY);
    const second = await provider.pollMediaJob('job', KEY);
    const third = await provider.pollMediaJob('job', KEY);
    for (const status of [first, second, third]) {
      expect(MediaJobStatusSchema.safeParse(status).success).toBe(true);
    }
    expect(first.state).toBe('pending');
    expect(second.state).toBe('done');
    expect(third.state).toBe('failed');
    // A content-policy refusal reuses the one failure vocabulary: the classified `content_filter` LlmError
    // (fatal — the engine's codeForLlmError maps it to the fatal `content_filter` ErrorCode, ADR-0045 §6).
    if (third.state === 'failed') {
      expect(third.error.kind).toBe('content_filter');
      expect(third.error.retryable).toBe(false);
    }
  });

  it('pollMediaJob: accepts the additive abort signal (a cancel reaches the in-flight poll, A5)', async () => {
    let observedSignal = false;
    const provider: GenerativeProvider = {
      ...stubAsyncGenerativeProvider({ polls: [{ state: 'pending' }] }),
      pollMediaJob: (_jobId, _key, signal) => {
        observedSignal = signal !== undefined;
        return Promise.resolve<MediaJobStatus>({ state: 'pending' });
      },
    };
    const controller = new AbortController();
    const status = await provider.pollMediaJob('job', KEY, controller.signal);
    expect(MediaJobStatusSchema.safeParse(status).success).toBe(true);
    expect(observedSignal).toBe(true);
  });
});
