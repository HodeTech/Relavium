// Chalk's level is read once, when it is first imported: the matrix's own first import (see `force-color.ts`).
import '../render/tui/force-color.js';

/**
 * A form and a list whose rows state their effect, drawn by the real slot in a real host ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3, §4): the page the slot binds and the legend it draws are judged on the same rows (`bodyPageRows`): a form's whole body, so a form
 * that is wholly on its page inline names its `Enter` and takes it, and a list's window under its effect paragraph, so `PgDn` moves by the
 * rows it draws; `←/→` and `↑/↓` reach the form through the host's one reader; and the effect follows the highlight without moving the frame.
 */
import { describe, expect, it } from 'vitest';

import type { PopupForm } from './frame-model.js';
import { mountStandaloneChat } from '../render/tui/surface-matrix/chat-host.js';
import { KEYS } from '../render/tui/surface-matrix/home-host.js';
import type { Variant } from '../render/tui/surface-matrix/variants.js';
import { framePage } from './popup-slot.js';
import { popupGeometry, popupInnerWidth } from './geometry.js';
import { openFrame, type PopupFormValues, type PopupSpec } from './popup-reducer.js';

const LONG_WARNING =
  'This chat moves from Anthropic to OpenAI. Your messages and short tool receipts are sent to OpenAI. It also carries the content-free receipts of the tools that ran.';

/** A form whose compact layout is eleven rows: more than the inline page of ten, and whole in the inline body (which holds up to seventeen). */
const TALL: PopupForm = {
  kind: 'form',
  summary: 'gpt-5  400k context',
  tabs: {
    label: 'Reasoning effort',
    verb: 'effort',
    initial: 'medium',
    options: ['low', 'medium', 'high'].map((id) => ({ id, label: id })),
  },
  radio: {
    label: 'Apply to',
    verb: 'scope',
    initial: 'chat',
    options: [
      { id: 'chat', label: 'This chat', warning: LONG_WARNING },
      { id: 'new', label: 'New chats' },
      { id: 'all', label: 'Every chat' },
      { id: 'none', label: 'Nowhere' },
    ],
  },
};

const formSpec = (form: PopupForm): PopupSpec => ({
  id: 'form',
  title: '/form',
  origin: 'chat',
  steps: [{ name: 'Form', content: form, enter: 'apply' }],
});

const RIGHT = '\u001b[C';
const DOWN = '\u001b[B';
const PAGE_DOWN = '\u001b[6~';

describe('a form in the real slot', () => {
  it.each(['alt', 'inline'] as const)(
    '%s: the page is the form’s whole body, so a tall compact form is answerable and its legend names `Enter`',
    async (renderer) => {
      const variant: Variant = { renderer, color: false, size: { cols: 80, rows: 24 } };
      const m = mountStandaloneChat(variant);
      const applied: PopupFormValues[] = [];
      try {
        await m.settle();
        expect(
          m.popups.openForUser(formSpec(TALL), {
            apply: (_context, values) => applied.push(values),
          }).opened,
        ).toBe(true);
        expect(await m.until(() => m.text().includes('Reasoning effort'))).toBe(true);
        await m.settle();
        expect(m.text()).toContain('Enter apply');
        m.skip(600);
        m.key(RIGHT);
        await m.settle();
        m.key(DOWN);
        await m.settle();
        // Colour is off in this cell: the radio's mark is drawn in its plain form.
        expect(await m.until(() => m.text().includes('(*) New chats'))).toBe(true);
        expect(m.text()).toContain('> high');
        await m.settle();
        // The form as it is now was acknowledged by the slot: its own settle passes before its `Enter` counts.
        m.skip(600);
        m.key(KEYS.enter);
        await m.settle();
        expect(applied).toEqual([{ tab: 'high', radio: 'new' }]);
      } finally {
        m.unmount();
      }
    },
  );

  it('framePage of a form is its body; of a list with effects, the window above the paragraph', () => {
    const geometry = popupGeometry({
      columns: 80,
      rows: 24,
      kind: 'standard',
      placement: 'replace',
      rail: false,
      bodyRows: 11,
    });
    expect(framePage(openFrame(formSpec(TALL), 1), geometry)).toEqual({
      rows: 11,
      innerWidth: popupInnerWidth(80, 'standard'),
    });
    const effects: PopupSpec = {
      id: 'effects',
      title: '/effects',
      origin: 'chat',
      steps: [
        {
          name: 'List',
          content: {
            kind: 'list',
            rows: Array.from({ length: 6 }, (_, index) => ({
              id: `r${String(index)}`,
              label: `row ${String(index)}`,
              effect: 'One line of effect.',
            })),
          },
        },
      ],
    };
    // Eleven rows: six for the list window would leave room for a blank row and the one-row paragraph, so the window is 11 − 2 = 9 (at most 10).
    expect(framePage(openFrame(effects, 1), geometry).rows).toBe(9);
  });
});

describe('a list whose rows state their effect, in the real slot', () => {
  it('PgDn moves by the rows the window draws (not the whole body), and the paragraph follows the highlight', async () => {
    const variant: Variant = { renderer: 'alt', color: false, size: { cols: 80, rows: 24 } };
    const m = mountStandaloneChat(variant);
    const rows = Array.from({ length: 30 }, (_, index) => ({
      id: `r${String(index)}`,
      label: `row ${String(index)}`,
      effect: `The effect of row ${String(index)}, which wraps over two lines of the popup at eighty columns when it is long enough.`,
    }));
    try {
      await m.settle();
      m.popups.openForUser({
        id: 'effects',
        title: '/effects',
        origin: 'chat',
        steps: [{ name: 'List', content: { kind: 'list', rows }, enter: 'apply' }],
      });
      expect(await m.until(() => m.text().includes('The effect of row 0'))).toBe(true);
      await m.settle();
      const height = m.frame().length;
      m.skip(600);
      m.key(PAGE_DOWN);
      await m.settle();
      // The body is 18 rows at 80×24 in the alternate screen (21 less the frame's three): a blank row and two of the paragraph leave a window of
      // 15, so a page lands on row 15 (a page of the whole body, 18, would land on row 18, past the rows the window drew).
      expect(await m.until(() => m.text().includes('The effect of row 15,'))).toBe(true);
      expect(m.frame()).toHaveLength(height);
      m.key(DOWN);
      await m.settle();
      expect(await m.until(() => m.text().includes('The effect of row 16,'))).toBe(true);
      expect(m.frame()).toHaveLength(height);
    } finally {
      m.unmount();
    }
  });
});
