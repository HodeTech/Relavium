// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * A key's repeat and its release are not presses ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3, §8; MVP-11 step 4, review round 2, security F4). The CLI never turns on the kitty protocol's "report event types", but a terminal another
 * program left in it sends `ESC[121;5:2u` (a held `Ctrl+Y`'s repeat) and `ESC[121;5:3u` (its release), which Ink 7 parses as `Ctrl+Y` with an
 * `eventType`. On a confirmation line a repeat is refused as a held key (`early`) and disarms the line; on a step that is no line it is still a
 * refused affirmative; and a release never reaches anything: each host's one reader drops it, so it can neither type a letter twice into the
 * composer nor give a card or a line a second `Ctrl+Y`.
 */
import { describe, expect, it, vi } from 'vitest';

import { createChordHistory } from '../render/tui/chord-guard.js';
import { mountStandaloneChat, type ChatMount } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { createNotificationChannel } from './notifications.js';
import { createPopupHost, type ChordRefusal } from './popup-host.js';
import { reducePopupKey, type PopupKey, type PopupSpec, type PopupStep } from './popup-reducer.js';

const LIST: PopupStep = {
  name: 'List',
  content: {
    kind: 'list',
    rows: [
      { id: 'a', label: 'alpha row' },
      { id: 'b', label: 'bravo row' },
    ],
  },
  controls: [{ key: 'd', verb: 'arm' }],
};
const LINE: PopupStep = {
  name: 'Confirm',
  content: { kind: 'report', lines: ['Sends one request to:', '  https://a.example'] },
  back: 0,
  holds: 'chord',
  chord: { verb: 'send' },
};
const spec = (origin: 'home' | 'chat', initialStep = 0): PopupSpec => ({
  id: 'events',
  title: '/events',
  origin,
  rail: 'path',
  steps: [LIST, LINE],
  initialStep,
});

const REPEAT: PopupKey = { ctrl: true, eventType: 'repeat' };
const RELEASE: PopupKey = { ctrl: true, eventType: 'release' };

describe('the reducer: a Ctrl+Y that is not a press reaches a line as a held chord', () => {
  it('a press is the chord; a repeat and a release are the chord marked held', () => {
    expect(reducePopupKey('y', { ctrl: true }, LINE)).toEqual({ kind: 'chord' });
    expect(reducePopupKey('y', { ctrl: true, eventType: 'press' }, LINE)).toEqual({
      kind: 'chord',
    });
    expect(reducePopupKey('y', REPEAT, LINE)).toEqual({ kind: 'chord', held: true });
    expect(reducePopupKey('y', RELEASE, LINE)).toEqual({ kind: 'chord', held: true });
  });
});

describe('the host: a held Ctrl+Y never answers', () => {
  function rig() {
    let now = 0;
    const history = createChordHistory();
    const host = createPopupHost({
      now: () => now,
      schedule: () => () => undefined,
      notifications: createNotificationChannel({ schedule: () => () => undefined }),
      history,
      placement: 'overlay',
    });
    host.bindVisibility(() => true);
    host.bindOpenGate(() => undefined);
    host.bindPageRows(() => 18);
    const chord = vi.fn();
    const refusals: ChordRefusal[] = [];
    host.openForUser(spec('chat', 1), {
      chord,
      chordRefused: (_context, reason) => refusals.push(reason),
    });
    host.shown(host.getSnapshot());
    return {
      host,
      history,
      chord,
      refusals,
      advance: (ms: number): void => {
        now += ms;
      },
      now: (): number => now,
    };
  }

  it.each([
    ['repeat', REPEAT],
    ['release', RELEASE],
  ] as const)(
    'a %s on a line, long after its frame: refused early, the line disarmed, a resolution on the history',
    (_name, key) => {
      const r = rig();
      r.advance(3000);
      r.host.input('y', key);
      expect(r.chord).not.toHaveBeenCalled();
      expect(r.refusals).toEqual(['early']);
      expect(r.host.getSnapshot().frame?.stepIndex).toBe(0);
      expect(r.history.lastResolvedAt).toBe(r.now());
    },
  );

  it('a repeat on a step that is no line is a refused affirmative (its lockout restarts)', () => {
    const r = rig();
    r.advance(3000);
    r.host.input('', { escape: true }); // back to the list
    r.advance(3000);
    r.host.input('y', REPEAT);
    expect(r.history.lastResolvedAt).toBe(r.now());
  });

  it('the control: a press there answers', () => {
    const r = rig();
    r.advance(3000);
    r.host.input('y', { ctrl: true });
    expect(r.chord).toHaveBeenCalledOnce();
  });
});

/** The kitty protocol's forms of `Ctrl+Y`: a press, a held key's repeat, a release (CSI codepoint ; modifiers : event u). */
const KITTY = {
  press: '\u001b[121;5u',
  repeat: '\u001b[121;5:2u',
  release: '\u001b[121;5:3u',
};

type Mount = HomeMount | ChatMount;
const HOSTS: readonly (readonly [string, (variant: Variant) => Mount])[] = [
  ['the stand-alone chat', (variant) => mountStandaloneChat(variant)],
  ['the Home', (variant) => mountHome(variant)],
];

describe.each(HOSTS)('%s, the parsed keys', (_name, mount) => {
  async function onTheLine(m: Mount) {
    const chord = vi.fn();
    const refusals: ChordRefusal[] = [];
    const origin = 'controller' in m && !('store' in m) ? 'home' : 'chat';
    expect(
      m.popups.openForUser(spec(origin, 1), {
        chord,
        chordRefused: (_context, reason) => refusals.push(reason),
        control: (context, key) => {
          if (key === 'd') context.goToStep(1);
        },
      }).opened,
    ).toBe(true);
    await m.until(() => m.frame().join('\n').includes('https://a.example'));
    await m.settle();
    m.skip(2600);
    return { chord, refusals };
  }

  it('a release after the dwell is dropped by the reader: the line stays armed, and the press that follows answers', async () => {
    const m = mount({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      const { chord, refusals } = await onTheLine(m);
      m.key(KITTY.release);
      await m.settle();
      expect(chord).not.toHaveBeenCalled();
      expect(refusals).toEqual([]);
      expect(m.popups.getSnapshot().frame?.stepIndex).toBe(1);
      m.key(KITTY.press);
      await m.until(() => chord.mock.calls.length === 1);
      expect(chord).toHaveBeenCalledOnce();
    } finally {
      m.unmount();
    }
  });

  it('a repeat after the dwell is refused as a held key and disarms the line', async () => {
    const m = mount({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      const { chord, refusals } = await onTheLine(m);
      m.key(KITTY.repeat);
      await m.until(() => refusals.length === 1);
      expect(chord).not.toHaveBeenCalled();
      expect(refusals).toEqual(['early']);
      expect(m.popups.getSnapshot().frame?.stepIndex).toBe(0);
    } finally {
      m.unmount();
    }
  });

  it('the legacy Ctrl+Y byte still answers (the control)', async () => {
    const m = mount({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      const { chord } = await onTheLine(m);
      m.key(KEYS.ctrlY);
      await m.until(() => chord.mock.calls.length === 1);
      expect(chord).toHaveBeenCalledOnce();
    } finally {
      m.unmount();
    }
  });
});

describe('a release never types into the composer (the readers drop it)', () => {
  it('the stand-alone chat: `a`, then its release, is one `a`', async () => {
    const m = mountStandaloneChat({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      m.key('a');
      await m.settle();
      m.key('\u001b[97;1:3u');
      await m.settle();
      await m.settle();
      expect(m.store.getSnapshot().state.status).toBe('idle');
      expect(m.text()).toContain('> a');
      expect(m.text()).not.toContain('> aa');
    } finally {
      m.unmount();
    }
  });

  it('the Home: `a`, then its release, is one `a`', async () => {
    const m = mountHome({ renderer: 'alt', color: false, size: { cols: 80, rows: 24 } });
    try {
      await m.settle();
      m.key('a');
      await m.until(() => m.controller.getSnapshot().input.text === 'a');
      m.key('\u001b[97;1:3u');
      await m.settle();
      await m.settle();
      expect(m.controller.getSnapshot().input.text).toBe('a');
    } finally {
      m.unmount();
    }
  });
});
