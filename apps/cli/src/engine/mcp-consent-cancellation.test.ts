import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { captureIo } from '../test-support.js';
import { createConsentGate, mcpConsentPath, type ConsentSubject } from './mcp-consent-gate.js';
import { createConsentPrompter } from '../mcp/consent-prompt.js';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (cause: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const subject: ConsentSubject = {
  serverId: 'offline',
  provenance: 'inline',
  artifact: undefined,
  resolvedCommand: process.execPath,
  authoredCommand: undefined,
  args: [],
  env: [],
  cwd: process.cwd(),
  digest: 'v1:synthetic',
  total: 1,
  index: 1,
  previouslyApprovedIn: undefined,
};

describe('workflow-native consent cancellation and late decisions', () => {
  it.each([false, true])('a late %s after cancellation never appends a grant', async (approved) => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-consent-cancel-'));
    const controller = new AbortController();
    const stopped = new Error('Owned command stopped.');
    const entered = deferred<void>();
    const answer = deferred<boolean>();
    const captured = captureIo();
    const gate = createConsentGate({
      io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
      global: { json: false, color: false, cwd: home, configPath: undefined, verbosity: 'normal' },
      homeDir: home,
      signal: controller.signal,
      prompt: (_subject, options) => {
        expect(options?.signal).toBe(controller.signal);
        entered.resolve();
        return answer.promise;
      },
    });
    try {
      const pending = gate(
        [{ id: 'native', transport: 'stdio', command: process.execPath }],
        home,
        undefined,
      );
      const refusal = expect(pending).rejects.toBe(stopped);
      await entered.promise;
      controller.abort(stopped);
      answer.resolve(approved);
      await refusal;
      expect(existsSync(mcpConsentPath(home))).toBe(false);
    } finally {
      answer.resolve(false);
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('a genuine prompt error after abort is preserved rather than relabelled as cooperative cancellation', async () => {
    const home = mkdtempSync(join(tmpdir(), 'relavium-consent-fault-'));
    const controller = new AbortController();
    const answer = deferred<boolean>();
    const entered = deferred<void>();
    const cause = new Error('PRIVATE_PROMPT_FAILURE');
    const captured = captureIo();
    const gate = createConsentGate({
      io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
      global: { json: false, color: false, cwd: home, configPath: undefined, verbosity: 'normal' },
      homeDir: home,
      signal: controller.signal,
      prompt: () => {
        entered.resolve();
        return answer.promise;
      },
    });
    try {
      const pending = gate(
        [{ id: 'native', transport: 'stdio', command: process.execPath }],
        home,
        undefined,
      );
      const refusal = expect(pending).rejects.toBe(cause);
      await entered.promise;
      controller.abort();
      answer.reject(cause);
      await refusal;
      expect(existsSync(mcpConsentPath(home))).toBe(false);
    } finally {
      answer.resolve(false);
      rmSync(home, { recursive: true, force: true });
    }
  });
  it('passes the exact native signal to Clack and refuses pre-aborted entry without acquiring a prompt', async () => {
    const controller = new AbortController();
    const answer = deferred<boolean | symbol>();
    const confirm = vi.fn(() => answer.promise);
    const message = vi.fn();
    const prompter = createConsentPrompter({
      confirm,
      log: { message },
      isCancel: (value): value is symbol => typeof value === 'symbol',
    });
    const pending = prompter(subject, { signal: controller.signal });
    expect(confirm).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ signal: controller.signal, initialValue: false }),
    );
    controller.abort();
    answer.resolve(Symbol('cancelled'));
    expect(await pending).toBe(false);
    expect(await prompter(subject, { signal: controller.signal })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(message).toHaveBeenCalledOnce();
  });
});
