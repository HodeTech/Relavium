import { expect, it } from 'vitest';
import { createInkRenderer } from './ink-renderer.js';

for (const boundary of ['release-input', 'suspend'] as const) {
  it(`actual Ink ${boundary} acknowledges each mount without retaining a beforeExit listener`, async () => {
    const before = new Set(process.rawListeners('beforeExit'));
    const summaries: string[] = [];
    const renderer = createInkRenderer({
      color: false,
      writeSummary: (text) => summaries.push(text),
    });
    renderer.onEvent({
      type: 'run:cancelled',
      runId: 'native-ink-input-ack',
      timestamp: '2026-10-09T00:00:00.000Z',
      sequenceNumber: 1,
    });
    try {
      for (let cycle = 0; cycle < 12; cycle++) {
        if (boundary === 'release-input') await renderer.releaseInput?.();
        else await renderer.suspend?.();
        expect(process.rawListeners('beforeExit')).toEqual([...before]);
        expect(summaries).toEqual([]);
        if (cycle < 11) await renderer.resume?.();
      }
      await renderer.finalize?.();
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toContain('run cancelled');
      expect(process.rawListeners('beforeExit')).toEqual([...before]);
    } finally {
      await renderer.releaseInput?.();
      // Negative controls deliberately expose SDK listeners. Remove only this fixture's additions.
      for (const listener of process.rawListeners('beforeExit')) {
        if (!before.has(listener))
          Reflect.apply(process.removeListener.bind(process), process, ['beforeExit', listener]);
      }
    }
  });
}
