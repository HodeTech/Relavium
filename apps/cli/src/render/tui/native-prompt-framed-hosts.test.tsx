/**
 * The native prompt channel framed as a popup, mounted in the real hosts (MVP-11 unit 6, 6.1; ADR-0148 §1, §3, §4): a chord step drawn in the
 * popup frame and answered only after its own guards and the flow's opening guard, measured from the FRAMED frame's acknowledgement; a chord
 * step that is not wholly on its page drawn as the notice and never answered; the picker framed and answered; a masked field emptied by a
 * resize in the Home's and in the stand-alone chat's resize paths, with no frame after the resize drawing what was typed; and a framed
 * select's `PgUp`/`PgDn` moving by the window the popup draws.
 *
 * The hosts' channels run on the real clock, so the waits are real and named.
 */
import { describe, expect, it } from 'vitest';

import { POPUP_SELECT_SETTLE_MS } from '../../popups/opening-guard.js';
import { nativePopupGeometry } from '../../popups/popup-slot.js';
import { bracketed } from './harness-util.js';
import {
  NATIVE_PROMPT_CANCEL,
  NATIVE_PROMPT_RESIZED,
  type NativePopupDescriptor,
} from './native-prompt-channel.js';
import {
  mountHostedChat,
  mountStandaloneChat,
  type ChatMount,
} from './surface-matrix/chat-host.js';
import { KEYS, mountHome, type HomeMount } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';
import { APPROVAL_QUIET_MS, APPROVAL_SETTLE_MS } from './tool-review-model.js';

/** A real wait past the flow's opening settle and a chord card's dwell (the hosts' clocks are the real one). */
const PAST_THE_GUARDS_MS =
  Math.max(POPUP_SELECT_SETTLE_MS, APPROVAL_SETTLE_MS) + APPROVAL_QUIET_MS + 100;
/** How long a pending answer is watched before the test says it did not come. */
const WATCH_MS = 150;

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const PENDING: unique symbol = Symbol('pending');
const within = <T,>(promise: Promise<T>, ms = WATCH_MS): Promise<T | typeof PENDING> =>
  Promise.race([promise, pause(ms).then((): typeof PENDING => PENDING)]);

const descriptor = (origin: 'home' | 'chat'): NativePopupDescriptor => ({
  title: '/import',
  origin,
  stepIndex: 1,
  stepCount: 3,
  stepNames: ['Path', 'Confirm', 'Done'],
  exitLabel: 'close',
  depth: 1,
});

/** Whether the prompt on the channel now is the frame on the terminal, measured and flushed: what a key that counts waits for. */
function shownNow(channel: NonNullable<HomeMount['channel']>): boolean {
  try {
    channel.ui.assertVisible(channel.ui.getSnapshot());
    return true;
  } catch {
    return false;
  }
}

type Host = 'home' | 'chat' | 'standalone-chat';
const HOSTS: readonly Host[] = ['home', 'chat', 'standalone-chat'];
const RENDERERS = ['alt', 'inline'] as const;

async function mount(host: Host, variant: Variant): Promise<HomeMount | ChatMount> {
  if (host === 'home') return mountHome(variant, { nativePrompt: true });
  if (host === 'chat') return mountHostedChat(variant, { nativePrompt: true });
  return mountStandaloneChat(variant, { nativePrompt: true });
}

const DETAILS = [
  'from        ~/Downloads/deploy.relavium.yaml',
  'to          .relavium/workflows/deploy.relavium.yaml',
  'Canonical YAML: comments are dropped and values are kept as written. The file you named is not changed.',
];

describe('a chord step drawn in the popup frame', () => {
  it.each(HOSTS.flatMap((host) => RENDERERS.map((renderer) => [host, renderer] as const)))(
    'in the %s host, %s: its facts wrapped, its answers on the legend row, Ctrl+Y only after the guards, from the framed frame',
    async (host, renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const m = await mount(host, variant);
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        channel.flow.popup?.(descriptor(host === 'home' ? 'home' : 'chat'));
        const answer = channel.flow.chord({
          message: "Import workflow 'deploy' into this project?",
          details: DETAILS,
          allow: 'Write the file',
          deny: 'Write nothing',
        });
        await m.until(() => m.frame().join('\n').includes('/import'));
        await m.settle();
        const text = m.frame().join('\n');
        expect(text).toContain('step 2 of 3');
        expect(text).toMatch(/Path .* Confirm .* Done/u);
        expect(text).toContain('[Ctrl+Y] Write the file · [Ctrl+N] Write nothing · Esc denies');
        expect(text).toContain('The file you named is not changed.');
        // The card's own rows are not drawn: the popup frame is.
        expect(text).not.toContain('│ from');
        m.key(KEYS.ctrlY);
        expect(await within(answer)).toBe(PENDING);
        await pause(PAST_THE_GUARDS_MS);
        m.key(KEYS.ctrlY);
        expect(await answer).toBe('allow');
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );

  it('Ctrl+N answers at once', async () => {
    const m = mountHome(
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      { nativePrompt: true },
    );
    try {
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');
      channel.flow.begin();
      channel.flow.popup?.(descriptor('home'));
      const answer = channel.flow.chord({
        message: 'Write?',
        details: DETAILS,
        allow: 'Write',
        deny: 'Skip',
      });
      await m.until(() => m.frame().join('\n').includes('[Ctrl+Y] Write'));
      await m.until(() => shownNow(channel), 400);
      m.key(KEYS.ctrlN);
      expect(await answer).toBe('deny');
      await channel.flow.end();
    } finally {
      m.unmount();
    }
  });

  /** Facts no popup holds (30 rows), and facts the floor's popup cannot hold but a wider terminal's can (rows that wrap only at 66 columns). */
  const TOO_LONG = Array.from({ length: 30 }, (_, index) => `fact ${String(index)}`);
  const WIDE = Array.from({ length: 9 }, (_, index) => `fact ${String(index)} ${'w'.repeat(62)}`);
  it.each(
    RENDERERS.flatMap((renderer) => [
      [renderer, 'too long for any popup', TOO_LONG, 'This is too long for a popup'] as const,
      [renderer, 'too wide for the floor', WIDE, 'No room for this popup'] as const,
    ]),
  )(
    '%s, %s: a chord step that is not wholly on its page is the notice and is never answered; Esc leaves it',
    async (renderer, _case, details, notice) => {
      const m = mountHome(
        { renderer, color: false, size: { cols: 80, rows: 24 } },
        { nativePrompt: true },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        channel.flow.popup?.(descriptor('home'));
        const answer = channel.flow.chord({
          message: 'Write?',
          details,
          allow: 'Write',
          deny: 'Skip',
        });
        await m.until(() => m.frame().join('\n').includes(notice));
        const text = m.frame().join('\n');
        expect(text).toContain(notice);
        expect(text).not.toContain('fact 0');
        await pause(PAST_THE_GUARDS_MS);
        m.key(KEYS.ctrlY);
        expect(await within(answer)).toBe(PENDING);
        m.key(KEYS.escape);
        expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );
});

describe('the picker drawn in the popup frame', () => {
  it.each(RENDERERS)(
    '%s: its filter, its rows and its legend, and Enter resumes after the settle',
    async (renderer) => {
      const m = mountHome(
        { renderer, color: false, size: { cols: 80, rows: 24 } },
        { nativePrompt: true },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        channel.flow.popup?.({
          ...descriptor('home'),
          title: '/resume',
          stepIndex: 0,
          stepCount: 1,
          stepNames: ['Session'],
        });
        const answer = channel.flow.pick({
          message: 'Resume a session',
          load: (query) =>
            Promise.resolve({
              options: [
                { value: 's1', label: 'Fix the flaky test', hint: '2 days ago' },
                { value: 's2', label: 'Plan the release', hint: '3 days ago' },
              ].filter((option) => option.label.toLowerCase().includes(query.toLowerCase())),
            }),
        });
        await m.until(() => m.frame().join('\n').includes('Fix the flaky test'));
        await m.settle();
        const text = m.frame().join('\n');
        expect(text).toContain('/resume');
        expect(text).toContain('This directory · Page 1');
        expect(text).toContain('Filter: _');
        // the picker's legend fitted to the popup's 66 columns: the paging item goes first, the way back never
        expect(text).toContain('↑/↓ select · Enter resume · Tab all directories · Esc close');
        m.key('p');
        await m.until(() => !m.frame().join('\n').includes('Fix the flaky test'));
        expect(m.frame().join('\n')).toContain('Filter: p_');
        await pause(PAST_THE_GUARDS_MS);
        m.key(KEYS.enter);
        expect(await answer).toBe('s2');
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );
});

describe('a resize clears a masked field, framed, in each host’s resize path (ADR-0148 §4)', () => {
  it('the Home (its own resize subscription): no frame after the resize draws what was typed; the field says so and takes a new key', async () => {
    let size = { cols: 80, rows: 24 };
    const listeners = new Set<() => void>();
    const m = mountHome(
      { renderer: 'alt', color: false, size },
      {
        nativePrompt: true,
        getSize: () => size,
        subscribeResize: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    );
    try {
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');
      channel.flow.begin();
      channel.flow.popup?.({
        ...descriptor('home'),
        title: 'Connect a provider',
        stepNames: ['Provider', 'Key', 'Done'],
      });
      const answer = channel.flow.password({
        message: 'Paste your Anthropic API key',
        validate: (value) => (value === '' ? 'required' : undefined),
      });
      await m.until(() => m.frame().join('\n').includes('Paste your Anthropic API key'));
      await m.until(() => shownNow(channel), 400);
      m.key(bracketed('sk-ant-old-secret'));
      await m.until(() => m.frame().join('\n').includes('•'));
      const before = m.raw().length;
      size = { cols: 100, rows: 30 };
      m.resize(100, 30);
      for (const listener of [...listeners]) listener();
      await m.until(() => m.frame().join('\n').includes(NATIVE_PROMPT_RESIZED));
      await m.settle();
      expect(m.raw().slice(before)).not.toContain('•');
      expect(channel.ui.getSnapshot().display).toBe('');
      await pause(PAST_THE_GUARDS_MS);
      m.key(bracketed('sk-new'));
      await m.until(() => channel.ui.getSnapshot().display !== '');
      await pause(APPROVAL_QUIET_MS);
      m.key(KEYS.enter);
      expect(await answer).toBe('sk-new');
      await channel.flow.end();
    } finally {
      m.unmount();
    }
  });

  it('the stand-alone chat (the native prompt host’s resize listener): the same', async () => {
    const m = mountStandaloneChat(
      { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
      { nativePrompt: true },
    );
    try {
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');
      channel.flow.begin();
      channel.flow.popup?.({ ...descriptor('chat'), title: '/providers' });
      const answer = channel.flow.password({
        message: 'Paste your OpenAI API key',
        validate: (value) => (value === '' ? 'required' : undefined),
      });
      await m.until(() => m.frame().join('\n').includes('Paste your OpenAI API key'));
      await m.until(() => shownNow(channel), 400);
      m.key(bracketed('sk-old-secret'));
      await m.until(() => m.frame().join('\n').includes('•'));
      const before = m.raw().length;
      m.resize(90, 28);
      await m.until(() => m.frame().join('\n').includes(NATIVE_PROMPT_RESIZED));
      await m.settle();
      expect(m.raw().slice(before)).not.toContain('•');
      await pause(PAST_THE_GUARDS_MS);
      m.key(bracketed('sk-new'));
      await m.until(() => channel.ui.getSnapshot().display !== '');
      await pause(APPROVAL_QUIET_MS);
      m.key(KEYS.enter);
      expect(await answer).toBe('sk-new');
      await channel.flow.end();
    } finally {
      m.unmount();
    }
  });
});

describe('a SHRINK writes no frame that holds the old bullets (the renderer redraws on a resize: the field is emptied first)', () => {
  const SHRINKS = [
    { cols: 70, rows: 24 },
    { cols: 60, rows: 20 },
  ] as const;

  it.each(SHRINKS.flatMap((to) => [true, false].map((framed) => [to, framed] as const)))(
    'the Home, to %o, framed=%s',
    async (to, framed) => {
      let size = { cols: 80, rows: 24 };
      const listeners = new Set<() => void>();
      const m = mountHome(
        { renderer: 'alt', color: false, size },
        {
          nativePrompt: true,
          getSize: () => size,
          subscribeResize: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
        },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        if (framed) channel.flow.popup?.({ ...descriptor('home'), title: '/providers' });
        const answer = channel.flow.password({ message: 'Paste your Anthropic API key' });
        await m.until(() => m.frame().join('\n').includes('Paste your Anthropic API key'));
        await m.until(() => shownNow(channel), 400);
        m.key(bracketed('sk-ant-old-secret-0000000000000000000000'));
        await m.until(() => m.frame().join('\n').includes('•'));
        const before = m.raw().length;
        size = { ...to };
        m.resize(to.cols, to.rows);
        for (const listener of [...listeners]) listener();
        await m.settle();
        await m.settle();
        expect(m.raw().slice(before)).not.toContain('•');
        expect(channel.ui.getSnapshot().display).toBe('');
        channel.flow.cancel();
        expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );

  it.each(SHRINKS.flatMap((to) => [true, false].map((framed) => [to, framed] as const)))(
    'the stand-alone chat, to %o, framed=%s',
    async (to, framed) => {
      const m = mountStandaloneChat(
        { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } },
        { nativePrompt: true },
      );
      try {
        await m.settle();
        const channel = m.channel;
        if (channel === undefined) throw new Error('no channel');
        channel.flow.begin();
        if (framed) channel.flow.popup?.({ ...descriptor('chat'), title: '/providers' });
        const answer = channel.flow.password({ message: 'Paste your OpenAI API key' });
        await m.until(() => m.frame().join('\n').includes('Paste your OpenAI API key'));
        await m.until(() => shownNow(channel), 400);
        m.key(bracketed('sk-old-secret-0000000000000000000000'));
        await m.until(() => m.frame().join('\n').includes('•'));
        const before = m.raw().length;
        m.resize(to.cols, to.rows);
        await m.settle();
        await m.settle();
        expect(m.raw().slice(before)).not.toContain('•');
        expect(channel.ui.getSnapshot().display).toBe('');
        channel.flow.cancel();
        expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
        await channel.flow.end();
      } finally {
        m.unmount();
      }
    },
  );
});

describe('a framed select drawn in a window pages by the window the popup draws', () => {
  it('inline (ten rows): PgDn moves the cursor by the popup’s page, never by the card’s', async () => {
    const variant: Variant = { renderer: 'inline', color: false, size: { cols: 80, rows: 24 } };
    const m = mountHome(variant, { nativePrompt: true });
    try {
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');
      channel.flow.begin();
      channel.flow.popup?.({
        ...descriptor('home'),
        title: '/run',
        stepIndex: 0,
        stepNames: ['Workflow', 'Inputs', 'Confirm'],
      });
      const options = Array.from({ length: 30 }, (_, index) => ({
        value: `w${String(index)}`,
        label: `workflow-${String(index)}`,
      }));
      const answer = channel.flow.select({ message: 'Run which workflow?', options });
      await m.until(() => m.frame().join('\n').includes('workflow-0'));
      await m.settle();
      expect(m.frame().join('\n')).toContain('PgUp/PgDn page');
      const { layout } = nativePopupGeometry(
        channel.ui.getSnapshot(),
        'replace',
        variant.size,
        false,
      );
      const page = layout?.page;
      expect(page).toBeGreaterThanOrEqual(1);
      await m.until(() => shownNow(channel), 400);
      m.key(KEYS.pageDown);
      await m.until(() => channel.ui.getSnapshot().selected !== 0);
      expect(channel.ui.getSnapshot().selected).toBe(page);
      expect(m.frame().join('\n')).toContain(`> workflow-${String(page)}`);
      channel.flow.cancel();
      expect(await answer).toBe(NATIVE_PROMPT_CANCEL);
      await channel.flow.end();
    } finally {
      m.unmount();
    }
  });
});
