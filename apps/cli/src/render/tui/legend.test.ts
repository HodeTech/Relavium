import { describe, expect, it } from 'vitest';

import { LEGEND_SEPARATOR, legend } from './legend.js';

describe('legend', () => {
  it('joins key and verb pairs in the order given with the one separator, no full stop', () => {
    expect(
      legend([
        { keys: '↑/↓', verb: 'select' },
        { keys: 'd', verb: 'withdraw' },
        { keys: 'Esc', verb: 'close' },
      ]),
    ).toBe('↑/↓ select · d withdraw · Esc close');
    expect(LEGEND_SEPARATOR).toBe(' · ');
  });

  it('is empty for no items and a bare pair for one', () => {
    expect(legend([])).toBe('');
    expect(legend([{ keys: 'Esc', verb: 'close' }])).toBe('Esc close');
  });
});
