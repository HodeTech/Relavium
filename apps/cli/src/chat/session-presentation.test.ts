import { describe, expect, it, vi } from 'vitest';
import type { SessionStreamHandleEvent } from '@relavium/core';

import { CliError } from '../process/errors.js';
import { invocationFixture } from '../process/invocation.test-support.js';
import { captureIo } from '../test-support.js';
import {
  ownSessionNotification,
  ownSessionOutput,
  ownSessionSubscriber,
} from './session-presentation.js';
import { SessionWorkOwner } from './session-work-owner.js';

const event: SessionStreamHandleEvent = {
  type: 'session:started',
  sessionId: 'presentation',
  agentRef: 'fixture',
  model: 'offline',
  context: { workingDir: '/synthetic', fsScopeTier: 'sandboxed' },
  timestamp: '2026-10-17T00:00:00.000Z',
  sequenceNumber: 1,
};

describe('owned passive session presentation', () => {
  it('observes the notification failure before advisory recovery and reentrant cancellation', async () => {
    const f = invocationFixture();
    let notify: (value: string) => void = () => {};
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => notify('cancel notification'),
      cleanup: () => Promise.resolve(),
    });
    const cause = new TypeError('PRIVATE_NOTIFICATION_FAILURE');
    const consume = vi.fn(() => {
      throw cause;
    });
    notify = ownSessionNotification(owner, consume);
    try {
      expect(() => notify('warning')).not.toThrow();
      notify('late warning');
      expect(consume).toHaveBeenCalledOnce();
      expect(owner.firstFailure?.cause).toBe(cause);
      expect(f.registry.observations.exitCode()).toBe(9);
    } finally {
      await owner.close();
    }
    expect(f.registry.activeOwners).toBe(0);
  });

  it('reports an existing passive error successfully without classifying that argument as a fatal fault', async () => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => {},
      cleanup: () => Promise.resolve(),
    });
    const notes: unknown[] = [];
    const report = ownSessionNotification(owner, (error: unknown) => {
      notes.push(error);
    });
    const reported = new TypeError('existing passive error');
    try {
      report(reported);
      expect(notes).toEqual([reported]);
      expect(owner.firstFailure).toBeUndefined();
      expect(f.registry.termination).toBeUndefined();
      owner.stop();
      report(new Error('late callback must not enter'));
      expect(notes).toEqual([reported]);
    } finally {
      await owner.close();
    }
    expect(f.registry.activeOwners).toBe(0);
  });

  it('preserves ownerless notification identity and the original thrown cause', () => {
    const cause = new Error('ownerless advisory');
    const consume = () => {
      throw cause;
    };
    expect(ownSessionNotification(undefined, consume)).toBe(consume);
    expect(() => ownSessionNotification(undefined, consume)('warning')).toThrow(cause);
  });

  it('seals before failure cancellation reenters the passive callback', async () => {
    const f = invocationFixture();
    let subscriber: (event: SessionStreamHandleEvent) => void = () => {};
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => subscriber(event),
      cleanup: () => Promise.resolve(),
    });
    const cause = new TypeError('PRIVATE_VIEW_FAULT');
    const consume = vi.fn(() => {
      throw cause;
    });
    subscriber = ownSessionSubscriber(owner, consume);
    try {
      subscriber(event);
      subscriber(event);
      expect(consume).toHaveBeenCalledOnce();
      expect(owner.firstFailure?.cause).toBe(cause);
      expect(f.registry.observations.exitCode()).toBe(9);
      expect(f.registry.termination).toBeDefined();
    } finally {
      await owner.close();
    }
    expect(f.registry.activeOwners).toBe(0);
  });

  it('preserves ownerless callback identity and thrown-cause compatibility', () => {
    const cause = new Error('legacy callback');
    const consume = () => {
      throw cause;
    };
    expect(ownSessionSubscriber(undefined, consume)).toBe(consume);
    expect(() => ownSessionSubscriber(undefined, consume)(event)).toThrow(cause);
    const { io } = captureIo();
    expect(ownSessionOutput(io, undefined)).toBe(io);
  });

  it('keeps a classified inline callback refusal from inventing fatal health', async () => {
    const f = invocationFixture();
    const owner = new SessionWorkOwner(f.invocation, 'chat', {
      cancel: () => {},
      cleanup: () => Promise.resolve(),
    });
    const consume = vi.fn(() => {
      throw new CliError('invalid_invocation', 'known refusal');
    });
    try {
      const subscribe = ownSessionSubscriber(owner, consume);
      subscribe(event);
      subscribe(event);
      expect(consume).toHaveBeenCalledOnce();
      expect(f.registry.termination).toBeUndefined();
      expect(owner.firstFailure).toBeUndefined();
    } finally {
      await owner.close();
    }
  });

  it('retains actual acknowledged output after fatal stop and never uses business admission for restoration', async () => {
    const f = invocationFixture();
    const cleanup = vi.fn(() => Promise.resolve());
    const owner = new SessionWorkOwner(f.invocation, 'chat', { cancel: () => {}, cleanup });
    const captured = captureIo();
    let reject: (cause: unknown) => void = () => {};
    const raw = new Promise<void>((_yes, no) => {
      reject = no;
    });
    const output = ownSessionOutput({ ...captured.io, writeOutAcknowledged: () => raw }, owner);
    const delivered = output.writeOutAcknowledged('PRIVATE_OUTPUT').then(
      () => undefined,
      (cause: unknown) => cause,
    );
    owner.failure(new TypeError('separate failure'));
    const closing = owner.close();
    await Promise.resolve();
    expect(cleanup).not.toHaveBeenCalled();
    captured.io.writeOut('RESTORE');
    expect(captured.out()).toBe('RESTORE');
    expect(() => output.writeOut('LATE_BUSINESS')).toThrow();
    reject(new Error('PRIVATE_WRITE_FAULT'));
    const failure = await delivered;
    expect(failure).toMatchObject({ code: 'output_unavailable', exitCode: 9 });
    await closing;
    expect(cleanup).toHaveBeenCalledOnce();
    expect(f.registry.activeOwners).toBe(0);
  });
});
