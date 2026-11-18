import { describe, expect, it, vi } from 'vitest';
import {
  BUILTIN_TOOLS,
  createInMemoryEffectJournal,
  createToolRegistry,
  ToolDispatchError,
  type FsCapability,
  type ToolDispatchContext,
} from '@relavium/core';
import { errorRecoveryHint } from '../../render/tui/chat-projection.js';
import type { NativeMetadataWriteAdapter } from './fs-native-metadata.js';
import { nativeWriteFailureFacts, runNativeStage } from './fs-native-write.js';

const PRIVATE = 'private-native-path-and-policy';
function fixture() {
  const stage = {};
  const adapter = {
    protocolVersion: () => 1,
    requiresCreationMaskProbe: () => false,
    createWriteCancellation: vi.fn(() => ({})),
    cancelWrite: vi.fn(),
    recoverMetadataStaging: vi.fn(() => Promise.resolve(undefined)),
    prepareExistingMetadata: vi.fn(() => Promise.resolve({})),
    existingMetadataIdentity: vi.fn(() => Promise.resolve({})),
    releaseExistingMetadata: vi.fn(() => Promise.resolve(undefined)),
    prepareNewMetadata: vi.fn(() => Promise.resolve({})),
    recheckNewMetadata: vi.fn(() => Promise.resolve(undefined)),
    releaseNewMetadata: vi.fn(() => Promise.resolve(undefined)),
    stageExistingMetadata: vi.fn(() => Promise.resolve(stage)),
    stageNewMetadata: vi.fn(() => Promise.resolve(stage)),
    publishMetadata: vi.fn(() => Promise.resolve(undefined)),
    releaseMetadataStage: vi.fn(() => Promise.resolve(undefined)),
  } satisfies NativeMetadataWriteAdapter;
  const input = {
    adapter,
    prepared: {},
    before: null,
    after: Buffer.from('new\n'),
    home: '/unused',
    nonce: 'fixed',
    stageMask: undefined,
    creationMask: () => Promise.resolve(undefined),
  };
  return { adapter, input, stage };
}

describe('joined native stage failure presentation', () => {
  it.each(['stage', 'publish', 'release'] as const)(
    'keeps %s failure fatal, secret-free and outside policy-denial remedies',
    async (cut) => {
      const f = fixture();
      if (cut === 'stage') f.adapter.stageNewMetadata.mockRejectedValue(new Error(PRIVATE));
      if (cut === 'publish') f.adapter.publishMetadata.mockRejectedValue(new Error(PRIVATE));
      if (cut === 'release') f.adapter.releaseMetadataStage.mockRejectedValue(new Error(PRIVATE));
      const cause: unknown = await runNativeStage(f.input).catch((error: unknown) => error);
      expect(cause).toBeInstanceOf(ToolDispatchError);
      if (!(cause instanceof ToolDispatchError)) throw new Error('missing native failure');
      expect(cause).toMatchObject({
        runErrorCode: 'effect_needs_attention',
        retryable: false,
        recoverable: false,
      });
      expect(cause.message).not.toContain(PRIVATE);
      expect(cause.cause).toBeUndefined();
      expect(errorRecoveryHint(cause.runErrorCode)).toContain('check the target');
      expect(errorRecoveryHint(cause.runErrorCode)).not.toContain('/mode');
      expect(f.adapter.releaseMetadataStage).toHaveBeenCalledTimes(cut === 'stage' ? 0 : 1);
      expect(f.adapter.publishMetadata).toHaveBeenCalledTimes(cut === 'stage' ? 0 : 1);
    },
  );

  it('joins cleanup after cancellation and removes its abort listener', async () => {
    const f = fixture(),
      controller = new AbortController();
    let finishRelease = () => {};
    const release = new Promise<void>((resolve) => {
      finishRelease = resolve;
    });
    f.adapter.publishMetadata.mockImplementation(() => {
      controller.abort();
      return Promise.reject(new Error(PRIVATE));
    });
    f.adapter.releaseMetadataStage.mockImplementation(async () => {
      await release;
      return undefined;
    });
    let settled = false;
    const result = runNativeStage({ ...f.input, signal: controller.signal }).catch(
      (cause: unknown) => {
        settled = true;
        return cause;
      },
    );
    await vi.waitFor(() => expect(f.adapter.releaseMetadataStage).toHaveBeenCalledOnce());
    expect(settled).toBe(false);
    expect(f.adapter.cancelWrite).toHaveBeenCalledOnce();
    finishRelease();
    expect(await result).toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
    });
  });

  it('keeps cancellation allocation failure in the fatal post-claim attention category', async () => {
    const f = fixture();
    f.adapter.createWriteCancellation.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    await expect(runNativeStage(f.input)).rejects.toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
      recoverable: false,
    });
    expect(f.adapter.stageNewMetadata).not.toHaveBeenCalled();
  });

  it('refuses before starting a stage when immediate native cancellation throws', async () => {
    const f = fixture(),
      controller = new AbortController();
    controller.abort();
    f.adapter.cancelWrite.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    const cause: unknown = await runNativeStage({ ...f.input, signal: controller.signal }).catch(
      (error: unknown) => error,
    );
    expect(cause).toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
      recoverable: false,
    });
    expect(f.adapter.stageNewMetadata).not.toHaveBeenCalled();
    expect(f.adapter.publishMetadata).not.toHaveBeenCalled();
    expect(f.adapter.releaseMetadataStage).not.toHaveBeenCalled();
  });

  it('contains a throwing abort callback and joins its pending stage before cleanup and failure', async () => {
    const f = fixture(),
      controller = new AbortController();
    let resolveStage: (stage: typeof f.stage) => void = () => {};
    const pendingStage = new Promise<typeof f.stage>((resolve) => {
      resolveStage = resolve;
    });
    f.adapter.stageNewMetadata.mockImplementation(() => pendingStage);
    f.adapter.cancelWrite.mockImplementation(() => {
      throw new Error(PRIVATE);
    });
    let settled = false;
    const result = runNativeStage({ ...f.input, signal: controller.signal }).catch(
      (cause: unknown) => {
        settled = true;
        return cause;
      },
    );
    await vi.waitFor(() => expect(f.adapter.stageNewMetadata).toHaveBeenCalledOnce());
    expect(() => controller.abort()).not.toThrow();
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.adapter.releaseMetadataStage).not.toHaveBeenCalled();
    resolveStage(f.stage);
    const cause = await result;
    expect(cause).toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
      recoverable: false,
    });
    expect(cause).toBeInstanceOf(ToolDispatchError);
    if (!(cause instanceof ToolDispatchError)) throw new Error('missing cancellation failure');
    expect(cause.message).not.toContain(PRIVATE);
    expect(cause.cause).toBeUndefined();
    expect(f.adapter.publishMetadata).not.toHaveBeenCalled();
    expect(f.adapter.releaseMetadataStage).toHaveBeenCalledExactlyOnceWith(f.stage);
  });

  it('records a possibly published cleanup failure as ambiguous and gives no retry authority', async () => {
    const f = fixture();
    f.adapter.releaseMetadataStage.mockRejectedValue(new Error(PRIVATE));
    const fs: FsCapability = {
      readFile: () =>
        Promise.resolve({
          content: '',
          mimeType: 'text/plain',
          sizeBytes: 0,
          lastModified: '',
        }),
      listDirectory: () => Promise.resolve({ entries: [] }),
      writeFile: () => Promise.reject(new Error('blind writes forbidden')),
      prepareWrite: () =>
        Promise.resolve({
          path: 'a',
          before: null,
          after: 'new\n',
          release: () => {},
          execute: async () => {
            await runNativeStage(f.input);
            return { path: 'a', bytesWritten: 4 };
          },
        }),
    };
    const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs } });
    const effects = createInMemoryEffectJournal({
      kind: 'run',
      runId: 'r',
      nodeId: 'n',
      attempt: 1,
    });
    const settle = vi.spyOn(effects, 'settle');
    const context: ToolDispatchContext = {
      nodeId: 'n',
      grantedToolIds: new Set(['write_file']),
      config: {},
      toolPolicy: {},
      fsScope: 'sandboxed',
      gateApproved: false,
      effectSlot: 0,
      effectAttempt: { providerAttempt: 1, toolCallId: 'call' },
      effects,
    };
    await expect(
      registry.dispatch(
        {
          type: 'tool_call',
          id: 'call',
          name: 'write_file',
          args: { path: 'a', content: 'new\n' },
        },
        context,
      ),
    ).rejects.toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
      recoverable: false,
    });
    expect(settle).toHaveBeenCalledWith(0, 'write_file', 'ambiguous');
    expect(f.adapter.publishMetadata).toHaveBeenCalledOnce();
  });
});

describe('closed native failure facts', () => {
  it.each([
    'none',
    'unsupported',
    'access_denied',
    'changed',
    'cancelled',
    'possibly_published',
    'legacy_recovery_required',
    'unknown',
  ] as const)(
    'preserves %s independently of cleanup failure without exposing it',
    async (primary) => {
      const f = fixture();
      f.adapter.publishMetadata.mockRejectedValue(
        new Error(`RELAVIUM_NATIVE_WRITE:${primary}:proven`),
      );
      f.adapter.releaseMetadataStage.mockRejectedValue(
        new Error('RELAVIUM_NATIVE_WRITE:unknown:uncertain'),
      );
      const error: unknown = await runNativeStage(f.input).catch((cause: unknown) => cause);
      expect(nativeWriteFailureFacts(error)).toEqual({ primary, cleanup: 'uncertain' });
      expect(JSON.stringify(error)).not.toContain('RELAVIUM_NATIVE_WRITE');
      expect(error).toMatchObject({ runErrorCode: 'effect_needs_attention' });
    },
  );

  it.each([
    'RELAVIUM_NATIVE_WRITE:changed:proven extra',
    'RELAVIUM_NATIVE_WRITE:changed:bad',
    'RELAVIUM_NATIVE_WRITE:bad:proven',
    `RELAVIUM_NATIVE_WRITE:changed:proven${'x'.repeat(96)}`,
    'EACCES /private/path',
  ])('refuses an unknown token without parsing OS text', async (message) => {
    const f = fixture();
    f.adapter.stageNewMetadata.mockRejectedValue(new Error(message));
    const error: unknown = await runNativeStage(f.input).catch((cause: unknown) => cause);
    expect(nativeWriteFailureFacts(error)).toEqual({ primary: 'unknown', cleanup: 'uncertain' });
  });

  it('never invokes a message getter or accepts an inherited message', async () => {
    const getter = vi.fn(() => {
      throw new Error('getter must not run');
    });
    for (const error of [
      Object.create({ message: 'RELAVIUM_NATIVE_WRITE:changed:proven' }),
      Object.defineProperty({}, 'message', { get: getter }),
    ]) {
      const f = fixture();
      f.adapter.stageNewMetadata.mockRejectedValue(error);
      const result: unknown = await runNativeStage(f.input).catch((cause: unknown) => cause);
      expect(nativeWriteFailureFacts(result)).toEqual({ primary: 'unknown', cleanup: 'uncertain' });
    }
    expect(getter).not.toHaveBeenCalled();
  });
});
