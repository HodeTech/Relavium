import { describe, expect, it } from 'vitest';

import { stripTerminalControls as rootStripTerminalControls } from './index.js';
import { stripTerminalControls } from './terminal-safe.js';

describe('supported terminal-safe leaf', () => {
  it('retains the root function identity in source and actual compiled exports', async () => {
    expect(rootStripTerminalControls).toBe(stripTerminalControls);
    const root = await import('@relavium/shared');
    const leaf = await import('@relavium/shared/terminal-safe');
    expect(root.stripTerminalControls).toBe(leaf.stripTerminalControls);
  });

  it('removes finite escape/control families while preserving text, tabs, newlines and shaping', () => {
    const text = 'plain\ttext\nemoji 👩\u200d💻 and shaping \u200c';
    const hostile = [
      '\u001b[31m',
      '\u001b]52;c;YWJj\u0007',
      '\u001bPpayload\u001b\\',
      '\u001b^payload\u0007',
      '\u001b_payload\u001b\\',
      '\u001bXpayload\u001b\\',
      '\u001bM',
      '\u0001',
      '\r',
      '\u007f',
      '\u009b',
      '\u061c',
      '\u200e',
      '\u200f',
      '\u202e',
      '\u2066',
      '\u2069',
    ].join('');
    expect(stripTerminalControls(hostile + text)).toBe(text);
  });

  it('keeps unterminated string-sequence bodies visible', () => {
    for (const introducer of [']', 'P', '^', '_', 'X']) {
      expect(stripTerminalControls(`before\u001b${introducer}visible remainder`)).toBe(
        'beforevisible remainder',
      );
    }
  });
});
