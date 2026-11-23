/**
 * The Home's question for a media park
 * ([ADR-0139](../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §3, the 2026-11-23 amendment note): the words
 * of the question, its default, and what a Yes, a No and a refusal do. It runs over the real native prompt channel (the prompt a person
 * answers), with the run host scripted.
 */
import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';

import { flush } from '../render/tui/harness-util.js';
import { createNativePromptChannel } from '../render/tui/native-prompt-channel.js';
import {
  MEDIA_CONTINUE_PROMPT_OPEN,
  mediaContinueQuestion,
  runMediaContinue,
  type MediaContinueDeps,
} from './media-continue.js';
import type { HostedLaunch, HostedMediaResumeRequest, HostedResumeRequest } from './run-host.js';

const none: Key = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  pageDown: false,
  pageUp: false,
  home: false,
  end: false,
  return: false,
  escape: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
  super: false,
  hyper: false,
  capsLock: false,
  numLock: false,
};
const ENTER: Key = { ...none, return: true };
const UP: Key = { ...none, upArrow: true };
const ESC: Key = { ...none, escape: true };

const RUN = '0b8f3a52-9d41-4c6e-8a07-5e2d1c9b7f64';
const STARTED: HostedLaunch = {
  kind: 'started',
  leg: 'resume',
  runId: RUN,
  ended: new Promise(() => undefined),
};

function rig(reply: HostedLaunch | Error = STARTED) {
  const channel = createNativePromptChannel();
  const resume = vi.fn<
    (request: HostedResumeRequest | HostedMediaResumeRequest) => Promise<HostedLaunch>
  >(() => (reply instanceof Error ? Promise.reject(reply) : Promise.resolve(reply)));
  const deps: MediaContinueDeps = {
    host: { resume },
    flow: channel.flow,
  };
  return { channel, resume, deps };
}

/** Wait until the question is on the channel, and return what it shows. */
async function asked(channel: ReturnType<typeof createNativePromptChannel>) {
  await vi.waitFor(() => expect(channel.ui.getSnapshot().active).toBe(true), { timeout: 2000 });
  return channel.ui.getSnapshot();
}

describe('the question', () => {
  it('names the run by its first eight characters, says it waits for media jobs, and asks to continue it here', () => {
    expect(mediaContinueQuestion(RUN)).toBe(
      'Run 0b8f3a52 is waiting for media jobs. Continue it here?',
    );
  });

  it('cuts a forged id before it cleans it, so a hostile id costs a bound and carries no control sequence', () => {
    const forged = `\u001b[31mred\u001b[0m\nforged row${'x'.repeat(10_000)}`;
    const text = mediaContinueQuestion(forged);
    expect(text).not.toContain('\u001b');
    expect(text).not.toContain('\n');
    expect(text.length).toBeLessThan(80);
  });

  it('is asked on the channel with the answer No selected: the default is No', async () => {
    const { channel, deps } = rig();
    const answer = runMediaContinue(deps, RUN);
    const snapshot = await asked(channel);
    expect(snapshot.message).toBe(mediaContinueQuestion(RUN));
    expect(snapshot.options.map((option) => option.label)).toEqual(['Yes', 'No']);
    expect(snapshot.options[snapshot.selected]?.label).toBe('No');
    channel.ui.input('', ESC);
    await answer;
  });
});

describe('what an answer does', () => {
  it('a Yes asks the host for the media resume of THAT run, with a secrets port and no gate and no decision, and says the leg started', async () => {
    const { channel, resume, deps } = rig();
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input('', UP); // No → Yes
    channel.ui.input('', ENTER);
    const notice = await answer;
    expect(resume).toHaveBeenCalledTimes(1);
    const request = resume.mock.calls[0]?.[0];
    if (request?.kind !== 'media') throw new Error('the host was not asked for a media resume');
    expect(request.runId).toBe(RUN);
    expect(typeof request.secrets).toBe('function');
    expect(Object.keys(request).sort(), 'no gate, no decision').toEqual([
      'kind',
      'runId',
      'secrets',
    ]);
    expect(notice).toBe(`Continuing run ${RUN}. It runs in the background.`);
    expect(channel.ui.getSnapshot().active, 'the flow is closed again').toBe(false);
  });

  it('an Enter typed ahead lands on the default and continues nothing', async () => {
    const { channel, resume, deps } = rig();
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input('', ENTER);
    expect(await answer).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect(channel.ui.getSnapshot().active).toBe(false);
  });

  it.each([
    ['Esc', '', ESC],
    ['Ctrl+C', 'c', { ...none, ctrl: true }],
  ] as const)('%s continues nothing and says nothing', async (_name, input, key) => {
    const { channel, resume, deps } = rig();
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input(input, key);
    expect(await answer).toBeUndefined();
    expect(resume).not.toHaveBeenCalled();
    expect(channel.ui.getSnapshot().active).toBe(false);
  });

  it('the host`s refusal is the notice, in the host`s own words and through the sanitize floor', async () => {
    const refusal: HostedLaunch = {
      kind: 'refused',
      reason: 'busy',
      message: 'A run is already executing: other-run.\u001b[31m',
    };
    const { channel, deps } = rig(refusal);
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input('', UP);
    channel.ui.input('', ENTER);
    const notice = await answer;
    expect(notice).toContain('A run is already executing: other-run.');
    expect(notice).not.toContain('\u001b');
  });

  it('a run that ended meanwhile is the host`s settled sentence', async () => {
    const { channel, deps } = rig({ kind: 'settled', message: 'run completed; nothing to resume' });
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input('', UP);
    channel.ui.input('', ENTER);
    expect(await answer).toBe('run completed; nothing to resume');
  });

  it('closes the flow whatever the host does, and a fault of the host is not swallowed', async () => {
    const { channel, deps } = rig(new Error('host fault'));
    const answer = runMediaContinue(deps, RUN);
    await asked(channel);
    channel.ui.input('', UP);
    channel.ui.input('', ENTER);
    await expect(answer).rejects.toThrow('host fault');
    expect(channel.ui.getSnapshot().active, 'the flow is closed again').toBe(false);
  });
});

describe('before anything is asked', () => {
  it('another open prompt is a refusal, not a queue: nothing is asked and the host is not touched', async () => {
    const { channel, resume, deps } = rig();
    channel.flow.begin(); // a prompt of another flow is open
    const notice = await runMediaContinue(deps, RUN);
    expect(notice).toBe(MEDIA_CONTINUE_PROMPT_OPEN);
    expect(resume).not.toHaveBeenCalled();
    await flush();
  });

  it('a Home that is closing asks nothing', async () => {
    const { channel, resume, deps } = rig();
    const closing = new Error('the Home is closing');
    await expect(
      runMediaContinue(
        {
          ...deps,
          assertAdmitting: () => {
            throw closing;
          },
        },
        RUN,
      ),
    ).rejects.toBe(closing);
    expect(channel.ui.getSnapshot().active).toBe(false);
    expect(resume).not.toHaveBeenCalled();
  });
});
