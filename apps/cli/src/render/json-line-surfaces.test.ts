/**
 * `CR-03` — the behavioural half of the machine-output floor.
 *
 * `#W15-10` built `stringifyJsonLine` and wired two call sites. `CR-03` found three more; the fold of its own
 * review then found a SIXTH (`commands/export.ts`) that a source-scanning regex had missed purely because
 * prettier wrapped the argument onto its own line. A guard that only checks the places someone remembered
 * catches nothing new, so the CALL-SITE half is now an ESLint `no-restricted-syntax` selector in
 * `eslint.config.mjs` — it fires on the shape, anywhere in `apps/cli/src`, the first time a new surface is
 * written. That is the mechanism; this file keeps the reason it exists visible as executable behaviour.
 */
import { describe, expect, it } from 'vitest';

import { stringifyJsonLine } from './sanitize.js';

describe('CR-03 — the --json machine-output floor', () => {
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
