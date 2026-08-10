/**
 * `CR-03` — every `--json` surface goes through the safe serializer, not just the two `#W15-10` reached.
 *
 * `#W15-10` built `stringifyJsonLine` and wired the workflow renderer and the record writer to it. Four
 * sibling paths kept a bare `JSON.stringify`, which escapes `ESC` but leaves `U+009B` (the 8-bit CSI), `DEL`
 * and the whole Trojan-Source bidi family RAW — and all four carry model-, tool- or artifact-derived content
 * straight to a terminal. A propagation gap: the fix landed, the siblings did not get it.
 *
 * This is a SOURCE-level assertion rather than four end-to-end drives, deliberately. What the finding is
 * about is a call site, and a call site is what a future edit reintroduces; wiring four command harnesses
 * would test the harnesses. The escaping behaviour itself is covered in `sanitize.test.ts`.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { stringifyJsonLine } from './sanitize.js';

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every file that writes NDJSON to stdout under `--json`. Adding a fifth means adding it here. */
const JSON_SURFACES = [
  'commands/agent-run.ts',
  'commands/chat.ts',
  'commands/chat-export.ts',
  'commands/import.ts',
];

describe('CR-03 — the --json surfaces', () => {
  it.each(JSON_SURFACES)(
    '%s emits through stringifyJsonLine, never a bare JSON.stringify',
    (rel) => {
      const source = readFileSync(join(srcRoot, rel), 'utf8');
      // The shape that reaches a terminal: a template-literal NDJSON line written to stdout.
      const bare = [...source.matchAll(/write(?:Out|Err)\(`\$\{JSON\.stringify\(/g)];
      expect(
        bare,
        `${rel} writes a --json line with a bare JSON.stringify. That leaves U+009B, DEL and the bidi ` +
          `family raw in content the model or an imported artifact controls. Use stringifyJsonLine — the ` +
          `escape is lossless, so no machine contract changes.`,
      ).toEqual([]);
      expect(source, `${rel} should import the safe serializer`).toContain('stringifyJsonLine');
    },
  );

  it('the shared serializer neutralizes what a bare JSON.stringify leaves raw', () => {
    // Built from code points at RUNTIME, never typed into this file: a raw C1/bidi byte in source is a
    // Trojan-Source hazard in its own right, and an editor or a tool in the chain can silently rewrite it.
    const CSI_8BIT = String.fromCharCode(0x9b); // the 8-bit CSI — `JSON.stringify` leaves it raw
    const DEL = String.fromCharCode(0x7f);
    const RLO = String.fromCharCode(0x202e); // right-to-left override
    const hostile = { id: 'n1', text: `ok${CSI_8BIT}2J${RLO}evil${DEL}` };
    const safe = stringifyJsonLine(hostile);
    const bare = JSON.stringify(hostile);

    for (const raw of [CSI_8BIT, RLO, DEL]) {
      expect(bare, 'the bare form is the hazard this item is about').toContain(raw);
      expect(safe).not.toContain(raw);
    }
    // Lossless: `--json` promises to reproduce the data, which is why this escapes rather than strips.
    expect(JSON.parse(safe)).toEqual(hostile);
  });
});
