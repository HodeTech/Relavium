/**
 * `framedFlow` (ADR-0148 §1, §3, §6; MVP-11 unit 6, 6.1): the one helper a flow calls to be drawn as a popup. It sets the channel's descriptor
 * before every prompt (the step advancing with each one, or named by `step`), keeps the flow's own prompts and answers, and ends a flow that
 * wrote in a persistent Done step. Driven on the real channel, its acknowledgement played by hand.
 */
import type { Key } from 'ink';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../popups/opening-guard.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_CANCEL,
  type NativePromptFlow,
  type NativePromptSnapshot,
} from '../render/tui/native-prompt-channel.js';
import { FRAMED_DONE_LABEL, FRAMED_DONE_VALUE, framedFlow } from './framed-flow.js';

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
const ESC: Key = { ...none, escape: true };

const OPTIONS = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Bravo' },
] as const;

function rig() {
  let clock = 1000;
  const channel = createNativePromptChannel({ now: () => clock });
  channel.ui.bindVisibility(() => true);
  const flow = framedFlow(channel.flow, {
    title: '/providers',
    origin: 'home',
    stepNames: ['Provider', 'Key', 'Done'],
  });
  const published: NativePromptSnapshot[] = [];
  channel.ui.subscribe(() => published.push(channel.ui.getSnapshot()));
  return {
    channel,
    flow,
    published,
    snapshot: (): NativePromptSnapshot => channel.ui.getSnapshot(),
    /** The frame on screen now was measured and flushed, and the flow's opening settle has passed. */
    settle: (): void => {
      channel.ui.shown(channel.ui.getSnapshot());
      clock += POPUP_SELECT_SETTLE_MS;
    },
    key: (key: Key): boolean => channel.ui.input('', key),
  };
}

describe('the descriptor a framed flow draws', () => {
  it('is set at `begin`, on the first step, with the title, the origin, the names, `close` and depth one', () => {
    const r = rig();
    r.flow.begin();
    expect(r.snapshot().popup).toEqual({
      title: '/providers',
      origin: 'home',
      stepIndex: 0,
      stepCount: 3,
      stepNames: ['Provider', 'Key', 'Done'],
      exitLabel: 'close',
      depth: 1,
    });
  });

  it('says the flow’s own words for the way back where given (`skip for now`)', () => {
    const channel = createNativePromptChannel({ now: () => 0 });
    const flow = framedFlow(channel.flow, {
      title: 'Connect a provider',
      origin: 'home',
      stepNames: ['Provider', 'Key', 'Done'],
      exitLabel: 'skip for now',
    });
    flow.begin();
    expect(channel.ui.getSnapshot().popup?.exitLabel).toBe('skip for now');
  });

  it('each prompt is on the next step, clamped to the last; a note and a wait are on the step the flow is on', async () => {
    const r = rig();
    r.flow.begin();
    const first = r.flow.select({ message: 'Which provider?', options: OPTIONS });
    expect(r.snapshot().popup?.stepIndex).toBe(0);
    expect(r.snapshot().kind).toBe('select');
    r.settle();
    r.key(ENTER);
    expect(await first).toBe('a');
    r.flow.note('a note');
    r.flow.busy('Checking');
    expect(r.snapshot().popup?.stepIndex).toBe(0);
    const second = r.flow.password({ message: 'Key' });
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.flow.cancel();
    expect(await second).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('clamps at the last step however many prompts the flow asks', async () => {
    const r = rig();
    r.flow.begin();
    for (let index = 0; index < 5; index += 1) {
      const answer = r.flow.select({ message: `Q${String(index)}`, options: OPTIONS });
      expect(r.snapshot().popup?.stepIndex).toBe(Math.min(index, 2));
      r.settle();
      r.key(ENTER);
      expect(await answer).toBe('a');
    }
  });

  it('`step(i)` names the next prompt’s step (a flow that steps back says where it goes), clamped; a wait after it is drawn there', async () => {
    const r = rig();
    r.flow.begin();
    const first = r.flow.select({ message: 'Which provider?', options: OPTIONS });
    r.settle();
    r.key(ENTER);
    await first;
    const key = r.flow.password({ message: 'Key' });
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.flow.cancel();
    await key;
    await r.flow.end();
    r.flow.begin();
    r.flow.step(1);
    r.flow.busy('Checking');
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    const again = r.flow.text({ message: 'Again' });
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.flow.cancel();
    await again;
    await r.flow.end();
    r.flow.begin();
    r.flow.step(99);
    void r.flow.text({ message: 'Last' });
    expect(r.snapshot().popup?.stepIndex).toBe(2);
    r.flow.step(-3);
    r.flow.cancel();
    await r.flow.end();
    r.flow.begin();
    r.flow.step(Number.NaN);
    void r.flow.text({ message: 'First' });
    expect(r.snapshot().popup?.stepIndex).toBe(0);
  });

  it('publishes the descriptor once per step: a prompt on the same step adds no frame of its own', async () => {
    const r = rig();
    r.flow.begin();
    const before = r.published.length;
    r.flow.step(0);
    const answer = r.flow.select({ message: 'Q', options: OPTIONS });
    // the prompt's own publication only: the step did not change
    expect(r.published.length).toBe(before + 1);
    r.settle();
    r.key(ENTER);
    await answer;
  });

  it('`end` clears the descriptor, and the next flow starts on the first step again', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({ message: 'Q', options: OPTIONS });
    r.settle();
    r.key(ENTER);
    await answer;
    void r.flow.text({ message: 'Next' });
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.flow.cancel();
    await r.flow.end();
    expect(r.snapshot().popup).toBeUndefined();
    expect(r.snapshot().active).toBe(false);
    r.flow.begin();
    void r.flow.text({ message: 'Again' });
    expect(r.snapshot().popup?.stepIndex).toBe(0);
  });

  it('frames the chord step of a flow that has one, and has no chord where the flow has none', async () => {
    const r = rig();
    expect(typeof r.flow.chord).toBe('function');
    r.flow.begin();
    r.flow.step(1);
    const answer = r.flow.chord({ message: 'Write?', allow: 'Write', deny: 'Skip' });
    expect(r.snapshot().kind).toBe('chord');
    expect(r.snapshot().popup?.stepIndex).toBe(1);
    r.key(ESC);
    expect(await answer).toBe(NATIVE_PROMPT_CANCEL);

    const { chord, ...withoutChord } = createNativePromptChannel().flow;
    void chord;
    const bare: NativePromptFlow = withoutChord;
    const framed = framedFlow(bare, { title: '/x', origin: 'chat', stepNames: ['One'] });
    expect('chord' in framed).toBe(false);
  });

  it('passes every prompt’s options through untouched (escape, initial value, validation, guarded options)', async () => {
    const r = rig();
    r.flow.begin();
    const answer = r.flow.select({
      message: 'Allow?',
      options: [
        { value: 'use', label: 'Use it', guarded: true },
        { value: 'later', label: 'Not now' },
      ],
      initialValue: 'later',
      escape: 'back',
    });
    expect(r.snapshot().selected).toBe(1);
    expect(r.snapshot().escape).toBe('back');
    expect(r.snapshot().options[0]?.guarded).toBe(true);
    r.flow.cancel();
    await answer;
  });
});

describe('the Done step (ADR-0148 §6)', () => {
  it('is the last step: a select of one option `Done` naming the target, its lines above it, marked final, closed by `Enter`', async () => {
    const r = rig();
    r.flow.begin();
    const done = r.flow.done({
      message: 'Connected · Anthropic · claude-haiku-5-5',
      lines: ['Type a message to start, or /init to set up this folder'],
      target: '~/.relavium/config.toml',
    });
    const snapshot = r.snapshot();
    expect(snapshot.popup?.stepIndex).toBe(2);
    expect(snapshot.kind).toBe('select');
    expect(snapshot.final).toBe(true);
    expect(snapshot.escape).toBe('cancel');
    expect(snapshot.message).toBe('Connected · Anthropic · claude-haiku-5-5');
    expect(snapshot.details).toEqual(['Type a message to start, or /init to set up this folder']);
    expect(snapshot.options).toEqual([
      { value: FRAMED_DONE_VALUE, label: FRAMED_DONE_LABEL, hint: '~/.relavium/config.toml' },
    ]);
    r.settle();
    r.key(ENTER);
    await expect(done).resolves.toBeUndefined();
    // the mark belongs to the step that set it: the flow's next state carries none
    expect(r.snapshot().final).toBeUndefined();
  });

  it('is closed by `Esc` too, and resolves at once when the flow was cancelled before it', async () => {
    const r = rig();
    r.flow.begin();
    const done = r.flow.done({ message: 'Created.' });
    expect(r.snapshot().options[0]).toEqual({ value: FRAMED_DONE_VALUE, label: FRAMED_DONE_LABEL });
    expect(r.snapshot().details).toEqual([]);
    r.settle();
    r.key(ESC);
    await expect(done).resolves.toBeUndefined();
    await r.flow.end();
    r.flow.begin();
    r.flow.cancel();
    await expect(r.flow.done({ message: 'Too late' })).resolves.toBeUndefined();
  });

  it('is not answered inside the flow’s opening settle', async () => {
    const r = rig();
    r.flow.begin();
    const done = r.flow.done({ message: 'Created.' });
    r.channel.ui.shown(r.snapshot());
    r.key(ENTER);
    const early = await Promise.race([
      done.then(() => 'closed'),
      new Promise<string>((resolve) => setImmediate(() => resolve('open'))),
    ]);
    expect(early).toBe('open');
    r.flow.cancel();
    await done;
  });
});

describe('where it is never used', () => {
  it('the stand-alone chat’s pre-chat mount (which draws no popup slot) does not frame its flows', () => {
    const source = readFileSync(
      new URL('../commands/standalone-native-flow.ts', import.meta.url),
      'utf8',
    );
    expect(source).not.toMatch(/framed-flow|framedFlow|\.popup\?\.\(/u);
  });
});
