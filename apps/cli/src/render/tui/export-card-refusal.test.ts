/**
 * The refusal of the export popup quotes the slug it was asked for through the full scrub (MVP-11 unit 6, round 1: test gap E06). A slug is a word a
 * project wrote: `Cannot export '<slug>'.` is drawn in the popup's message row, where a bidirectional override or `Press Ctrl+Y now` would pass for the
 * popup's own words, so it goes through `flowText` before it reaches the channel, as the question's slug does. The popup is the real one (the Home's host,
 * the real channel), and what is read is what it draws.
 */
import { describe, expect, it, vi } from 'vitest';

import { runExportCard, type ExportPort } from './export-card.js';
import { flowText } from './flow-text.js';
import { createNativePromptChannel } from './native-prompt-channel.js';
import { mountHome } from './surface-matrix/home-host.js';
import type { Variant } from './surface-matrix/variants.js';

const VARIANT: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
const BIDI_OVERRIDE = String.fromCharCode(0x202e);
const refusing: ExportPort = { prepare: () => ({ ok: false, reason: 'nothing to write' }) };

describe('the export refusal quotes the slug through the full scrub', () => {
  it.each([
    ['a bidirectional override and an answer chord', `wf${BIDI_OVERRIDE} Ctrl+Y now`],
    ['a forged legend row', 'wf [Ctrl+Y] Write the file · Esc denies'],
    ['a key-shaped string', `wf-sk-ant-api03-${'A'.repeat(40)}`],
  ])('%s is drawn in neither the message nor the legend', async (_name, slug) => {
    const m = mountHome(VARIANT, { nativePrompt: true });
    try {
      await m.settle();
      const channel = m.channel;
      if (channel === undefined) throw new Error('no channel');
      const running = runExportCard({ flow: channel.flow, port: refusing }, slug);
      await m.until(() => m.frame().join('\n').includes('Cannot export'));
      await m.settle();
      // The message on the channel is the scrubbed slug in the popup's own sentence, and nothing of what the slug said.
      expect(channel.ui.getSnapshot().message).toBe(`Cannot export '${flowText(slug)}'.`);
      expect(channel.ui.getSnapshot().message).not.toContain(BIDI_OVERRIDE);
      expect(channel.ui.getSnapshot().message).not.toContain('Ctrl+Y');
      // And the frame the person sees, legend row included, carries none of it either.
      const frame = m.frame().join('\n');
      expect(frame).toContain("Cannot export 'wf");
      expect(frame).not.toContain(BIDI_OVERRIDE);
      expect(frame).not.toContain('Ctrl+Y now');
      expect(frame).not.toContain('[Ctrl+Y]');
      expect(frame).not.toContain('sk-ant-api03-AAAA');
      channel.flow.cancel();
      await running;
    } finally {
      m.unmount();
    }
  });
});

/** The one bound of every `vi.waitFor` of this file. */
const WAIT_MS = 5000;
const KEY = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');

describe('the export refusal says its reason through the full scrub and the bound', () => {
  it.each([
    ['an answer chord', 'Press [Ctrl+Y] now', '[Ctrl+Y]'],
    ['a forged legend row', 'Write · [Ctrl+N] Write nothing · Esc denies', '[Ctrl+N]'],
    ['a key-shaped string', `cannot write ${KEY}`, KEY],
  ])('%s is not drawn', async (_name, reason, forbidden) => {
    const channel = createNativePromptChannel();
    const running = runExportCard(
      { flow: channel.flow, port: { prepare: () => ({ ok: false, reason }) } },
      'wf',
    );
    await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBe('failed'), {
      timeout: WAIT_MS,
    });
    expect(channel.ui.getSnapshot().details.join('\n')).not.toContain(forbidden);
    channel.flow.cancel();
    await running;
  });

  it('a reason longer than the popup’s bound is cut to it', async () => {
    const channel = createNativePromptChannel();
    const running = runExportCard(
      { flow: channel.flow, port: { prepare: () => ({ ok: false, reason: 'w'.repeat(600) }) } },
      'wf',
    );
    await vi.waitFor(() => expect(channel.ui.getSnapshot().final).toBe('failed'), {
      timeout: WAIT_MS,
    });
    const reason = channel.ui.getSnapshot().details.join('');
    expect(reason.length).toBeLessThanOrEqual(240);
    expect(reason.endsWith('…')).toBe(true);
    channel.flow.cancel();
    await running;
  });
});
