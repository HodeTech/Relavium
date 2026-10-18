import { describe, expect, it, vi } from 'vitest';
import { acquireNativeResource } from './acquire-native-resource.js';

describe('native resource handoff to an existing owner', () => {
  it('preserves the original owner cancellation identity before any resource is acquired', () => {
    const cancelled = new Error('synthetic original cancellation');
    const cleanupUncertain = vi.fn();
    expect(() =>
      acquireNativeResource(
        () => {
          throw cancelled;
        },
        {
          assertAdmitting: () => undefined,
          captureClose: vi.fn(),
          cleanupUncertain,
          isStoppedFailure: (cause) => cause === cancelled,
        },
      ),
    ).toThrow(cancelled);
    expect(cleanupUncertain).not.toHaveBeenCalled();
  });

  it('retains an early native capability instead of a returned replacement wrapper', () => {
    const nativeClose = vi.fn();
    const replacement = vi.fn();
    const retained: (() => void)[] = [];
    const resource = acquireNativeResource(
      (capture) => {
        capture(nativeClose);
        capture(nativeClose);
        return { close: replacement };
      },
      {
        assertAdmitting: () => undefined,
        captureClose: (close) => {
          retained.push(close);
        },
        cleanupUncertain: vi.fn(),
      },
    );
    Object.defineProperty(resource, 'close', { value: () => undefined });
    expect(retained).toEqual([nativeClose]);
    retained[0]?.();
    expect(nativeClose).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
  });

  it('does not certify an unknown partial acquisition without a native capability', () => {
    const cause = new Error('synthetic construction refusal');
    const cleanupUncertain = vi.fn();
    const captureClose = vi.fn();
    expect(() =>
      acquireNativeResource(
        () => {
          throw cause;
        },
        {
          assertAdmitting: () => undefined,
          captureClose,
          cleanupUncertain,
        },
      ),
    ).toThrow(cause);
    expect(cleanupUncertain).toHaveBeenCalledExactlyOnceWith(cause);
    expect(captureClose).not.toHaveBeenCalled();
  });

  it('a failed setup with a captured connection leaves retirement to its actual native release', () => {
    const cause = new Error('synthetic setup refusal');
    const close = vi.fn();
    const cleanupUncertain = vi.fn();
    const captureClose = vi.fn();
    expect(() =>
      acquireNativeResource(
        (capture) => {
          capture(close);
          throw cause;
        },
        { assertAdmitting: () => undefined, captureClose, cleanupUncertain },
      ),
    ).toThrow(cause);
    expect(captureClose).toHaveBeenCalledExactlyOnceWith(close);
    expect(cleanupUncertain).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
  });
});
