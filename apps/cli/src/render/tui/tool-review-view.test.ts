import { describe, expect, it } from 'vitest';

import { keyTone } from './tool-review-view.js';

/** How a key legend's parts are coloured: the answers stand out, the exits are as visible as any answer, the words stay dim. */
describe('keyTone — a legend part, coloured by what it does', () => {
  it('draws allow in green, deny in red, any other bracketed key in cyan, all bold', () => {
    for (const part of ['[Ctrl+Y]', '[Ctrl+G]', '[Ctrl+O]'])
      expect(keyTone(part, true), part).toEqual({ color: 'green', bold: true });
    expect(keyTone('[Ctrl+N]', true)).toEqual({ color: 'red', bold: true });
    for (const part of ['[v]', '[b]', '[Ctrl+R]', '[PgUp/PgDn]'])
      expect(keyTone(part, true), part).toEqual({ color: 'cyan', bold: true });
  });

  it('draws both exits, Esc and Ctrl+C (the stop key every legend names), in yellow and bold (ADR-0137 §4)', () => {
    expect(keyTone('Esc', true)).toEqual({ color: 'yellow', bold: true });
    expect(keyTone('Ctrl+C', true)).toEqual({ color: 'yellow', bold: true });
  });

  it('dims the words, and draws nothing at all with colour off', () => {
    expect(keyTone(' stops the turn', true)).toEqual({ dimColor: true });
    expect(keyTone(' Deny   ', true)).toEqual({ dimColor: true });
    for (const part of ['[Ctrl+Y]', '[Ctrl+N]', 'Esc', 'Ctrl+C', ' words', '[v]'])
      expect(keyTone(part, false), part).toEqual({});
  });
});
