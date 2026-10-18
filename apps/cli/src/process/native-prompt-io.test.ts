import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createBoundClackGatePrompter } from '../gate/clack-prompter.js';
import { createBoundConsentPrompter } from '../mcp/consent-prompt.js';
import type { ConsentSubject } from '../engine/mcp-consent-gate.js';
import { captureIo, OwnedTtyInput, OwnedTtyOutput } from '../test-support.js';
import { nativePromptIo } from './native-prompt-io.js';

function fixture() {
  const input = new OwnedTtyInput();
  const output = new OwnedTtyOutput();
  const captured = captureIo();
  const io = {
    ...captured.io,
    stdin: input,
    nativeStdin: input,
    nativeStdout: output,
    stdinIsTty: true,
    stdoutIsTty: true,
    writeOut: (text: string) => {
      output.write(text);
    },
    writeOutAcknowledged: (text: string) =>
      new Promise<void>((resolve, reject) => {
        output.write(text, (error) => (error ? reject(error) : resolve()));
      }),
  };
  return {
    input,
    output,
    captured,
    io,
    close: () => {
      input.destroy();
      output.destroy();
    },
  };
}
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('captured native prompt ports', () => {
  it('refuses missing native output before entering a library prompt', () => {
    const captured = captureIo();
    expect(() => nativePromptIo(captured.io)).toThrow();
    try {
      nativePromptIo(captured.io);
    } catch (cause) {
      expect(cause).toMatchObject({ code: 'cli_internal', exitCode: 9 });
    }
    expect(captured.out()).toBe('');
    expect(captured.err()).toBe('');
  });

  it('retains the captured input and output object identities', () => {
    const f = fixture();
    try {
      expect(nativePromptIo(f.io)).toEqual({ input: f.input, output: f.output });
      const lineInput = Readable.from([]);
      expect(nativePromptIo({ ...f.io, stdin: lineInput }).input).toBe(f.input);
      const { nativeStdin, ...withoutNativeInput } = f.io;
      expect(nativeStdin).toBe(f.input);
      expect(nativePromptIo({ ...withoutNativeInput, stdin: lineInput }).input).toBe(lineInput);
    } finally {
      f.close();
    }
  });

  it.each(['approval', 'input'] as const)(
    'binds installed Clack %s card and acquisition to the owned ports, then joins abort release',
    async (gateType) => {
      const f = fixture();
      const controller = new AbortController();
      const before = f.input.listeners('keypress');
      try {
        const prompter = createBoundClackGatePrompter(f.io);
        const pending = prompter.prompt(
          {
            type: 'human_gate:paused',
            runId: 'offline',
            timestamp: '2026-10-16T00:00:00Z',
            sequenceNumber: 1,
            nodeId: 'gate',
            gateId: 'owned-gate',
            gateType,
            message: 'OWNED_GATE_CARD',
          },
          undefined,
          controller.signal,
        );
        await turn();
        expect(f.output.frames.join('')).toContain('OWNED_GATE_CARD');
        expect(f.input.isRaw).toBe(true);
        expect(f.input.listeners('keypress').length).toBeGreaterThan(before.length);
        controller.abort();
        expect(await pending).toBeNull();
        expect(f.input.isRaw).toBe(false);
        // Node's shared emitKeypressEvents decoder retains an onData helper. Prompt-specific input
        // authority is gone only after its keypress subscription, raw mode and flowing read stop.
        expect(f.input.listeners('keypress')).toEqual(before);
        expect(f.input.readableFlowing).toBe(false);
        expect(f.captured.out()).toBe('');
      } finally {
        controller.abort();
        f.close();
      }
    },
  );

  it('binds installed Clack consent log and confirm to the owned ports and acknowledges cancellation', async () => {
    const f = fixture();
    const controller = new AbortController();
    const subject: ConsentSubject = {
      serverId: 'OWNED_MCP_SERVER',
      provenance: 'inline',
      artifact: undefined,
      authoredCommand: undefined,
      resolvedCommand: '/synthetic/never-spawned',
      args: [],
      env: [],
      cwd: '/synthetic',
      digest: 'v1:offline',
      total: 1,
      index: 1,
      previouslyApprovedIn: undefined,
    };
    try {
      const pending = createBoundConsentPrompter(f.io)(subject, { signal: controller.signal });
      await turn();
      expect(f.output.frames.join('')).toContain('OWNED_MCP_SERVER');
      expect(f.input.isRaw).toBe(true);
      controller.abort();
      expect(await pending).toBe(false);
      expect(f.input.isRaw).toBe(false);
      expect(f.captured.out()).toBe('');
    } finally {
      controller.abort();
      f.close();
    }
  });
});
