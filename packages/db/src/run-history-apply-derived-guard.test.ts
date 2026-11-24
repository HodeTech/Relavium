import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { RunEventSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

/**
 * ADR-0140 §4: `applyDerived` is exhaustive over `RunEvent`. The compiler proves it through `assertNever` (a type
 * with no `case` stops `tsc`), and this test is the same proof at test time: it reads the union from the shared
 * schema and the switch from the store's source, so a new durable event type added to `@relavium/shared` without
 * a decision here — fold it, or say in a comment why it writes nothing — fails the package's tests even where
 * only vitest is run.
 */

const source = readFileSync(
  fileURLToPath(new URL('./run-history-store.ts', import.meta.url)),
  'utf8',
);

/** The text of the `applyDerived` switch — from its `switch (event.type)` to the end of the arrow function. */
function applyDerivedSwitch(): string {
  const start = source.indexOf('const applyDerived = ');
  const end = source.indexOf('const fold = ', start);
  expect(start).toBeGreaterThan(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
}

const eventTypes = RunEventSchema.innerType().options.map((option) => option.shape.type.value);

describe('applyDerived exhaustiveness (ADR-0140 §4)', () => {
  it('reads a plausible set of event types from the shared union', () => {
    expect(eventTypes.length).toBeGreaterThan(25);
    expect(new Set(eventTypes).size).toBe(eventTypes.length);
    expect(eventTypes).toContain('cost:attempt_settled');
    expect(eventTypes).toContain('budget:estimate_committed');
  });

  it('names every RunEvent type as an explicit case', () => {
    const body = applyDerivedSwitch();
    const unhandled = eventTypes.filter((type) => !body.includes(`case '${type}':`));
    expect(unhandled).toEqual([]);
  });

  it('ends in assertNever, not a silent default', () => {
    const body = applyDerivedSwitch();
    const arm = /default:\s*([^\n]*)/u.exec(body)?.[1] ?? '';
    expect(arm).toBe('return assertNever(event);');
    // Exactly one `default`, so a second silent arm cannot sit beside the guard.
    expect(body.match(/\bdefault:/gu)).toHaveLength(1);
  });

  it('keeps the no-op group free of writes', () => {
    // From the first no-op arm to the default: every case there says why it writes nothing, and none writes.
    const body = applyDerivedSwitch();
    const noOps = body.slice(body.indexOf("case 'agent:token':"), body.indexOf('default:'));
    expect(noOps).toContain("case 'budget:estimate_committed':");
    expect(noOps).not.toMatch(/\btx\./u);
  });
});
