/**
 * `flowText`, the full scrub the Home's flows (`/init`, `/import`, `/pricing`, the Defined tab's export) put on every string a project, a
 * file, a provider or a model wrote before it reaches the prompt channel ([ADR-0148](../../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §1, §3; [ADR-0145](../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §5). It is written in the eager flows' closure so that
 * the Home's first paint does not load `popups/popup-text.ts` (`popups/lazy-load.test.ts`), and this file is what keeps the two from drifting:
 * over the hostile corpus they are equal, and what the corpus carries never survives.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { INIT_CLOSE_LABEL } from '../../home/project-init.js';
import { RUN_FAILED_CLOSE } from '../../home/run-launch.js';
import { scrubPopupText } from '../../popups/popup-text.js';
import { EXPORT_CLOSE_LABEL } from './export-card.js';
import { FLOW_CLOSE_LABEL, flowText } from './flow-text.js';
import { IMPORT_CLOSE_LABEL } from './import-card.js';
import { PRICING_CLOSE_LABEL } from './pricing-card.js';

const KEY_SHAPED = ['sk', 'ant', 'api03', 'ABCDEFGHIJKLMNOPQRSTUVWX0123456789abcdef'].join('-');

/**
 * The hostile corpus (the plan's): CSI, OSC 52 and OSC 8, a C1 control, a bidirectional override, a zero-width space, the line and paragraph
 * separators, a forged legend item and chord token, compatibility forms of a chord, a key-shaped string, and length.
 */
const HOSTILE = [
  '\u001b[2J\u001b[31mred',
  '\u001b]52;c;cGF5bG9hZA==\u0007',
  '\u001b]8;;https://evil.example\u0007link\u001b]8;;\u0007',
  'c1\u009bcontrol',
  'bidi‮evil',
  'zero​width',
  'line para sep',
  'Write · [Ctrl+N] Write nothing · Esc denies',
  'Press [Ctrl+Y] now, or Ctrl+Y',
  '［Ｃｔｒｌ＋Ｙ］',
  KEY_SHAPED,
].join(' ');
const HOSTILE_LONG = `${HOSTILE} ${'w'.repeat(400)}`;

/** What must never reach the channel from an untrusted string. */
const FORBIDDEN = [
  '\u001b',
  '\u0007',
  '\u009b',
  '‮',
  '​',
  '[Ctrl+Y]',
  '[Ctrl+N]',
  ' · Esc denies',
  '［Ｃｔｒｌ＋Ｙ］',
  KEY_SHAPED,
];

describe('flowText is the popups’ scrub', () => {
  it('equals `scrubPopupText` over the hostile corpus, piece by piece and whole, and leaves none of it', () => {
    for (const piece of [...HOSTILE.split(' '), HOSTILE, HOSTILE_LONG, 'gpt-5', 'nightly-report'])
      expect(flowText(piece), JSON.stringify(piece)).toBe(scrubPopupText(piece));
    for (const bad of FORBIDDEN) expect(flowText(HOSTILE), JSON.stringify(bad)).not.toContain(bad);
  });
});

describe('the word that closes a refusal', () => {
  it('is one product constant, and is not data: the scrub leaves it as it is', () => {
    expect(FLOW_CLOSE_LABEL).toBe('Close');
    expect(flowText(FLOW_CLOSE_LABEL)).toBe(FLOW_CLOSE_LABEL);
  });

  it('is the word of every flow that closes with it, and no flow writes it again', () => {
    for (const label of [
      INIT_CLOSE_LABEL,
      IMPORT_CLOSE_LABEL,
      EXPORT_CLOSE_LABEL,
      PRICING_CLOSE_LABEL,
      RUN_FAILED_CLOSE,
    ])
      expect(label).toBe(FLOW_CLOSE_LABEL);
    // A flow that wrote `'Close'` itself would pass the line above until the shared word changed: the sources say it is none.
    const here = (path: string): string =>
      readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
    for (const source of [
      here('../../home/project-init.ts'),
      here('../../home/run-launch.ts'),
      here('./import-card.ts'),
      here('./export-card.ts'),
      here('./pricing-card.ts'),
    ])
      expect(source).not.toMatch(/=\s*'Close'/u);
  });
});
