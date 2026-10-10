import { expect, it } from 'vitest';
import type { RunDeparture } from '@relavium/core';
import { captureIo } from '../test-support.js';
import { outcomeToExitCode, reportDepartureHealth, type RunOutcome } from './drive.js';

for (const json of [false, true]) {
  for (const observed of ['paused', 'completed', undefined] satisfies (RunOutcome | undefined)[]) {
    it(`reports combined receipt obligations from the actual primary terminal (${String(observed)}, json=${json})`, () => {
      const { io, out, err } = captureIo();
      const departure = {
        kind: observed === 'paused' ? 'detached' : 'closed',
        moneyDurability: 'uncertain',
        effectNeedsAttention: true,
      } satisfies RunDeparture;
      expect(outcomeToExitCode(observed, 'uncertain', undefined, departure)).toBe(8);
      reportDepartureHealth(io, json, departure, 'uncertain', observed);
      expect(out()).toBe('');
      expect(err().trim().split('\n')).toHaveLength(1);
      expect(err()).toContain('check provider billing');
      expect(err()).toContain('inspect the target');
      expect(err()).toContain('resolve the effect record');
      if (json)
        expect(JSON.parse(err())).toMatchObject({
          type: 'diagnostic',
          code: 'money_durability_uncertain',
          terminalDurability: observed === 'completed' ? 'uncertain' : 'none',
          effectNeedsAttention: true,
        });
      else
        expect(err()).toContain(
          `Terminal durability: ${observed === 'completed' ? 'uncertain' : 'none'}`,
        );
    });
  }
  it(`keeps legacy terminal effect classification and its single final warning (json=${json})`, () => {
    const { io, out, err } = captureIo();
    const departure = {
      kind: 'closed',
      moneyDurability: 'durable',
      effectNeedsAttention: false,
    } satisfies RunDeparture;
    expect(outcomeToExitCode('failed', 'uncertain', 'effect_needs_attention', departure)).toBe(7);
    reportDepartureHealth(io, json, departure, 'uncertain', 'failed', 'effect_needs_attention');
    expect(out()).toBe('');
    expect(err().trim().split('\n')).toHaveLength(1);
    expect(err()).toContain('inspect the target');
    if (json)
      expect(JSON.parse(err())).toMatchObject({
        code: 'effect_needs_attention',
        terminalDurability: 'uncertain',
        effectNeedsAttention: true,
      });
  });
  it(`keeps ordinary terminal/fence uncertainty free of invented receipt warnings (json=${json})`, () => {
    const { io, out, err } = captureIo();
    const departure = {
      kind: 'closed',
      moneyDurability: 'durable',
      effectNeedsAttention: false,
    } satisfies RunDeparture;
    expect(outcomeToExitCode('completed', 'uncertain', undefined, departure)).toBe(5);
    expect(outcomeToExitCode(undefined, 'uncertain', undefined, departure)).toBe(6);
    reportDepartureHealth(io, json, departure, 'uncertain', 'completed');
    reportDepartureHealth(io, json, departure, 'uncertain', undefined);
    expect(err()).toBe('');
    expect(out()).toBe('');
  });
}
