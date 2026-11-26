import { createSessionHandle, RunEventBus } from '@relavium/core';
import { describe, expect, it, vi } from 'vitest';

import { SessionWorkOwner } from '../../chat/session-work-owner.js';
import type { BoundAgentView } from '../../chat/bound-agent-view.js';
import type { CliIo } from '../../process/io.js';
import { invocationFixture } from '../../process/invocation.test-support.js';
import { OwnedTtyInput, OwnedTtyOutput } from '../../test-support.js';
import { createSuspendPort } from '../suspend.js';
import { driveInk } from './chat-ink.js';
import { createChatStore } from './chat-store.js';
import { WORDMARK } from './home-layout.js';
import { INLINE_TRANSCRIPT_BOUND } from './session-view-model.js';

/**
 * What the stand-alone chat's driver gives its chat on top of the chat view ([ADR-0146](../../../../../docs/decisions/0146-the-home-and-the-chat-share-one-calm-layout-and-the-first-run-has-no-dead-end.md)
 * §2 and §4, MVP-11 step 7a): the real `driveInk` over an installed Ink, inline (`--no-alt-screen`). The header is written ONCE, before the live
 * region, into the terminal's own scrollback, and a `/clear` or a reseat (which re-drives a new chat over the same `io`) does not write it
 * again; and the status line starts with the provider of the agent the session is bound to, read from the same view `/agent` reads.
 */
const BOUND_AGENT: BoundAgentView = {
  id: 'relavium-chat',
  name: undefined,
  builtIn: true,
  detail: {
    model: 'claude-sonnet-4-6',
    provider: 'anthropic',
    tools: [],
    toolsMore: 0,
    promptHead: '',
  },
  sessionEffort: undefined,
  toolOffer: undefined,
  sourceLabel: undefined,
};

function ioOver(input: OwnedTtyInput, output: OwnedTtyOutput, stderr: OwnedTtyOutput): CliIo {
  return {
    env: {},
    stdoutIsTty: true,
    stdinIsTty: true,
    stdin: input,
    nativeStdin: input,
    nativeStdout: output,
    nativeStderr: stderr,
    writeOut: (text) => {
      output.write(text);
    },
    writeErr: (text) => {
      stderr.write(text);
    },
    writeOutAcknowledged: (text) =>
      new Promise<void>((resolve, reject) => {
        output.write(text, (cause) =>
          cause === null || cause === undefined ? resolve() : reject(cause),
        );
      }),
    writeErrAcknowledged: (text) =>
      new Promise<void>((resolve, reject) => {
        stderr.write(text, (cause) =>
          cause === null || cause === undefined ? resolve() : reject(cause),
        );
      }),
  };
}

/** Drive one chat over `io` until it is asked to end, and return what the terminal was written. */
async function driveOnce(io: CliIo, output: OwnedTtyOutput, input: OwnedTtyInput): Promise<string> {
  const f = invocationFixture();
  const owner = new SessionWorkOwner(f.invocation, 'chat', {
    cancel: () => undefined,
    cleanup: () => Promise.resolve(),
  });
  const store = createChatStore(false, undefined, INLINE_TRANSCRIPT_BOUND);
  const bus = new RunEventBus({ now: () => new Date(0).toISOString() });
  const handle = createSessionHandle(bus, 'drive-header', () => undefined, 16, 'subscribe-only');
  const lines: string[] = [];
  let requestedExit = false;
  let activated = false;
  const driving = driveInk({
    workOwner: owner,
    handle,
    store,
    suspendPort: createSuspendPort(),
    subscribeInterrupt: () => () => undefined,
    startSession: () => undefined,
    onActivated: () => {
      activated = true;
    },
    boundAgent: () => BOUND_AGENT,
    processLine: (line) => {
      lines.push(line);
      if (line === '/exit') requestedExit = true;
      return Promise.resolve();
    },
    shouldStop: () => requestedExit,
    stopReason: () => 'exit',
    io,
    global: {
      configPath: undefined,
      cwd: process.cwd(),
      json: false,
      color: false,
      verbosity: 'normal',
      noAltScreen: true,
    },
  });
  const settled = driving.then(
    () => undefined,
    () => undefined,
  );
  try {
    await vi.waitFor(() => expect(activated).toBe(true));
    // The cursor is the inverse cell on the placeholder's first letter, so the invitation is read from its second.
    await vi.waitFor(() => expect(output.frames.join('')).toContain('ype a message'));
    const seen = output.frames.join('');
    input.push('/exit');
    await new Promise<void>((resolve) => setImmediate(resolve));
    input.push('\r');
    await vi.waitFor(() => expect(lines).toEqual(['/exit']));
    await driving;
    return seen;
  } finally {
    requestedExit = true;
    await settled;
  }
}

describe('driveInk, inline: the header and the provider', () => {
  it('writes the header once, before the live region, and a second chat over the same io writes none; the status line starts with the bound agent’s provider', async () => {
    const input = new OwnedTtyInput();
    const output = new OwnedTtyOutput();
    const stderr = new OwnedTtyOutput();
    const io = ioOver(input, output, stderr);

    const first = await driveOnce(io, output, input);
    const header = first.indexOf(WORDMARK);
    expect(header, 'the header was written').toBeGreaterThanOrEqual(0);
    expect(header, 'before the live region: its first frame is after the wordmark').toBeLessThan(
      first.indexOf('ype a message'),
    );
    expect(
      first.slice(0, header),
      'in bold: the pair is written by the one emphasis rule',
    ).toContain('\u001b[1m');
    expect(first, 'the provider of the bound agent starts the status line').toContain(
      'anthropic · ask mode',
    );

    const written = output.frames.join('').split(WORDMARK).length - 1;
    expect(written).toBe(1);
    const before = output.frames.join('').length;
    await driveOnce(io, output, input);
    const second = output.frames.join('').slice(before);
    expect(second, 'a /clear or a reseat mounts the next chat over the same io').not.toContain(
      WORDMARK,
    );
    expect(second).toContain('anthropic · ask mode');
  }, 20_000);
});
