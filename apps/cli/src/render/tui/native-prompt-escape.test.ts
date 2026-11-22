/**
 * `escape: 'back'`: `Esc` steps back one step and clears what was typed, `Ctrl+C` leaves the form
 * ([ADR-0139](../../../../../docs/decisions/0139-a-workflow-run-is-hosted-inside-the-home.md) §5, the last row of its table).
 *
 * The default, which every existing caller gets, is `Esc` ends the flow; its own tests live beside the channel's other suites and are
 * run unchanged. The cases here pin the new mode and the one thing that must not move: the default.
 */

import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { flush } from './harness-util.js';
import {
  createNativePromptChannel,
  NATIVE_PROMPT_BACK,
  NATIVE_PROMPT_CANCEL,
} from './native-prompt-channel.js';

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
const esc: Key = { ...none, escape: true };
const ctrlC = (): [string, Key] => ['c', { ...none, ctrl: true }];
const enter: Key = { ...none, return: true };

function fixture() {
  const channel = createNativePromptChannel();
  channel.flow.begin();
  return channel;
}

describe('escape: back', () => {
  it('Esc settles the prompt as BACK and leaves the flow open for the next step', async () => {
    const { ui, flow } = fixture();
    const first = flow.text({ message: 'Name', escape: 'back' });
    ui.input('', esc);
    expect(await first).toBe(NATIVE_PROMPT_BACK);
    expect(ui.signal()?.aborted).toBe(false);
    expect(ui.getSnapshot().active).toBe(true);
    // The flow is alive: the previous step's prompt can be asked again and answered.
    const again = flow.text({ message: 'Name', escape: 'back' });
    ui.paste('Ada');
    ui.input('', enter);
    expect(await again).toBe('Ada');
  });

  it('Esc clears a secret typed so far: it is neither returned nor left in the field of the next prompt', async () => {
    const { ui, flow } = fixture();
    const field = flow.password({ message: 'Token', escape: 'back' });
    ui.paste('hunter2-secret');
    expect(ui.getSnapshot().display).not.toBe('');
    ui.input('', esc);
    expect(await field).toBe(NATIVE_PROMPT_BACK);
    expect(JSON.stringify(ui.getSnapshot())).not.toContain('hunter2');
    expect(ui.getSnapshot().display).toBe('');
    // The next field starts empty: an Enter with nothing typed returns nothing, not the cleared secret.
    const next = flow.password({ message: 'Token', escape: 'back' });
    ui.input('', enter);
    expect(await next).toBe('');
  });

  it('Ctrl+C leaves the form entirely: the flow is aborted and the typed secret is cleared', async () => {
    const { ui, flow } = fixture();
    const field = flow.password({ message: 'Token', escape: 'back' });
    ui.paste('hunter2-secret');
    ui.input(...ctrlC());
    expect(await field).toBe(NATIVE_PROMPT_CANCEL);
    expect(ui.signal()?.aborted).toBe(true);
    expect(JSON.stringify(ui.getSnapshot())).not.toContain('hunter2');
    expect(await flow.password({ message: 'Again', escape: 'back' })).toBe(NATIVE_PROMPT_CANCEL);
  });

  it('only a lone Esc steps back: a forwarded Ctrl+C, a raw ETX, a meta chord and an Esc stuck to other bytes leave', async () => {
    const forms: Array<[string, Key]> = [
      ['\x1b', { ...none, ctrl: true }], // how a host forwards a Ctrl+C it could not deliver
      ['\x03', none],
      ['x', { ...none, meta: true }],
      ['\x1bsecret-suffix', none],
    ];
    for (const [input, key] of forms) {
      const { ui, flow } = fixture();
      const field = flow.text({ message: 'Name', escape: 'back' });
      ui.input(input, key);
      expect(await field, JSON.stringify(input)).toBe(NATIVE_PROMPT_CANCEL);
      expect(ui.signal()?.aborted).toBe(true);
    }
  });

  it('the forwarded form of a lone Esc steps back too', async () => {
    const { ui, flow } = fixture();
    const field = flow.text({ message: 'Name', escape: 'back' });
    ui.input('\x1b', esc);
    expect(await field).toBe(NATIVE_PROMPT_BACK);
  });

  it('Esc does not choose the highlighted option, and neither does a bare letter or a paste', async () => {
    const { ui, flow } = fixture();
    const choice = flow.select({
      message: 'Pick',
      options: [
        { value: 'a', label: 'A' },
        { value: 'b', label: 'B' },
      ],
      escape: 'back',
    });
    ui.input('a', none);
    ui.input('b', none);
    ui.paste('a');
    ui.paste('\r');
    await flush();
    expect(ui.getSnapshot().kind).toBe('select');
    ui.input('', esc);
    expect(await choice).toBe(NATIVE_PROMPT_BACK);
  });

  it('Esc does not answer a confirmation', async () => {
    const { ui, flow } = fixture();
    const sure = flow.confirm('Sure?', true, 'back');
    ui.input('', esc);
    expect(await sure).toBe(NATIVE_PROMPT_BACK);
  });

  it('Esc does not answer a chord card, and Ctrl+C does not either', async () => {
    for (const [press, expected] of [
      [(ui: ReturnType<typeof fixture>['ui']) => ui.input('', esc), NATIVE_PROMPT_BACK],
      [(ui: ReturnType<typeof fixture>['ui']) => ui.input(...ctrlC()), NATIVE_PROMPT_CANCEL],
    ] as const) {
      const { ui, flow } = fixture();
      const card = flow.chord({
        message: 'Allow?',
        allow: 'Allow',
        deny: 'Refuse',
        escape: 'back',
      });
      press(ui);
      const answer = await card;
      expect(answer).toBe(expected);
      expect(answer).not.toBe('allow');
      expect(answer).not.toBe('deny');
    }
  });

  it('a paste carrying an Esc byte is rejected as text; it cannot step back', async () => {
    const { ui, flow } = fixture();
    const field = flow.text({ message: 'Name', escape: 'back' });
    expect(ui.paste('ab\x1bcd')).toBe(true);
    await flush();
    expect(ui.getSnapshot().kind).toBe('text');
    expect(ui.getSnapshot().error).toContain('unsupported control characters');
    ui.input('', esc);
    expect(await field).toBe(NATIVE_PROMPT_BACK);
  });

  it('with nothing open, Esc still leaves: stepping back needs a prompt to step back from', () => {
    const { ui, flow } = fixture();
    flow.busy('Working');
    ui.input('', esc);
    expect(ui.signal()?.aborted).toBe(true);
  });

  it('the mode lasts for one prompt: the next prompt, and the busy state between, are back to the default', async () => {
    const { ui, flow } = fixture();
    const first = flow.text({ message: 'One', escape: 'back' });
    expect(ui.getSnapshot().escape).toBe('back');
    ui.input('', enter);
    await first;
    expect(ui.getSnapshot().escape).toBe('cancel');
    const second = flow.text({ message: 'Two' });
    expect(ui.getSnapshot().escape).toBe('cancel');
    ui.input('', esc);
    expect(await second).toBe(NATIVE_PROMPT_CANCEL);
  });
});

describe('the default is unchanged', () => {
  it('Esc ends the flow at every kind of prompt, and so does Ctrl+C', async () => {
    const open = [
      (f: ReturnType<typeof fixture>) => f.flow.text({ message: 'm' }),
      (f: ReturnType<typeof fixture>) => f.flow.password({ message: 'm' }),
      (f: ReturnType<typeof fixture>) =>
        f.flow.select({ message: 'm', options: [{ value: 'a', label: 'A' }] }),
      (f: ReturnType<typeof fixture>) => f.flow.confirm('m'),
      (f: ReturnType<typeof fixture>) =>
        f.flow.chord({ message: 'm', allow: 'Allow', deny: 'Refuse' }),
    ];
    for (const ask of open) {
      for (const press of [
        (f: ReturnType<typeof fixture>) => f.ui.input('', esc),
        (f: ReturnType<typeof fixture>) => f.ui.input(...ctrlC()),
      ]) {
        const f = fixture();
        const answer = ask(f);
        press(f);
        expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
        expect(f.ui.signal()?.aborted).toBe(true);
      }
    }
  });
});
