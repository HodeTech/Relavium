/**
 * The keys a form's legend names ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md) §3, §5)
 * where `popup-reducer.test.ts` leaves them open (found by the step-5 round-1 mutation sweep): each field is named as soon as it has a CHOICE to
 * make, which is two options, not three, and a field with one option names nothing.
 */
import { describe, expect, it } from 'vitest';

import type { PopupForm, PopupFormField } from './frame-model.js';
import { openFrame, popupLegend, type PopupSpec } from './popup-reducer.js';

const field = (label: string, verb: string, count: number): PopupFormField => ({
  label,
  verb,
  options: Array.from({ length: count }, (_, index) => ({
    id: `o${String(index)}`,
    label: `option ${String(index)}`,
  })),
});

/** The keys and verbs the legend of a one-step form names, in order, drawn on a page and a width that hold it whole. */
function formKeys(form: PopupForm): string[] {
  const spec: PopupSpec = {
    id: 'f',
    title: '/f',
    origin: 'chat',
    steps: [{ name: 'F', enter: 'apply', content: form }],
  };
  return popupLegend(openFrame(spec, 1), 20, 66).items.flatMap((item) =>
    'keys' in item ? [`${String(item.keys)} ${item.verb}`] : [],
  );
}

describe('the legend of a form', () => {
  it('names `←/→` for a tab field of two options, and `↑/↓` for a radio group of two', () => {
    expect(formKeys({ kind: 'form', tabs: field('Effort', 'effort', 2) })).toContain('←/→ effort');
    expect(formKeys({ kind: 'form', radio: field('Apply to', 'apply to', 2) })).toContain(
      '↑/↓ apply to',
    );
  });

  it('names a field of three options too, and one of a single option (no choice to make) not at all', () => {
    expect(formKeys({ kind: 'form', tabs: field('Effort', 'effort', 3) })).toContain('←/→ effort');
    expect(formKeys({ kind: 'form', tabs: field('Effort', 'effort', 1) })).not.toContain(
      '←/→ effort',
    );
    expect(formKeys({ kind: 'form', radio: field('Apply to', 'apply to', 1) })).not.toContain(
      '↑/↓ apply to',
    );
  });
});
