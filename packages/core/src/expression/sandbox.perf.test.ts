/**
 * Expression-sandbox perf spike (1.AB acceptance gate, ADR-0027 §9). Runs in its own vitest worker, so
 * the first `createExpressionSandbox()` is a genuine cold start (wasm instantiation). It measures
 * cold-start, per-eval latency, and per-eval RSS, logs them for the record, and soft-asserts generous
 * regression ceilings — the QuickJS-wasm *choice* is settled (this is an implementation gate, not a
 * decision gate). The numbers confirm the v1.0 caps (1000ms timeout) sit far above legitimate cost.
 */
import { describe, expect, it } from 'vitest';

import { createExpressionSandbox, type EvaluateInput } from './sandbox.js';

const EVALS = 500;

describe('expression sandbox — perf spike', () => {
  // A benchmark, not a precise timing gate: it runs alongside the whole suite, so it uses a generous
  // per-eval cap (measurement must never trip the sandbox's own timeout) and a long vitest timeout,
  // and asserts only an outlier-robust catastrophic-regression ceiling. The numbers are logged.
  it('cold-start and per-eval cost stay well under the caps', { timeout: 60_000 }, async () => {
    const t0 = performance.now();
    const sandbox = await createExpressionSandbox({
      limits: { timeoutMs: 5_000, memoryBytes: 16 * 1024 * 1024, stackBytes: 256 * 1024 },
    });
    const coldStartMs = performance.now() - t0;

    const input: EvaluateInput = {
      kind: 'condition',
      expression: 'run.outputs["scan"].score < inputs.threshold && ctx.mode === "strict"',
      scope: {
        inputs: { threshold: 7 },
        ctx: { mode: 'strict' },
        outputs: { scan: { score: 3 } },
      },
    };

    // Warm a few iterations (JIT/alloc) before timing.
    for (let i = 0; i < 20; i++) {
      sandbox.evaluate(input);
    }

    const rssBefore = process.memoryUsage().rss;
    const samples: number[] = [];
    for (let i = 0; i < EVALS; i++) {
      const s = performance.now();
      sandbox.evaluate(input);
      samples.push(performance.now() - s);
    }
    const rssDeltaMb = (process.memoryUsage().rss - rssBefore) / (1024 * 1024);

    samples.sort((a, b) => a - b);
    const avg = samples.reduce((sum, v) => sum + v, 0) / samples.length;
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? avg;

    // The perf spike records its numbers for the ADR-0027 §9 acceptance gate.
    console.log(
      `[1.AB perf spike] cold-start=${coldStartMs.toFixed(1)}ms ` +
        `per-eval avg=${avg.toFixed(3)}ms p95=${p95.toFixed(3)}ms (n=${EVALS}) ` +
        `rss-delta=${rssDeltaMb.toFixed(1)}MB`,
    );

    // Outlier-robust catastrophic-regression guard only (avg over n=500 absorbs scheduling spikes);
    // p95 is logged, not asserted. The observed values (cold-start ~35ms, avg ~1ms) leave huge headroom.
    expect(coldStartMs).toBeLessThan(30_000);
    expect(avg).toBeLessThan(100);
  });
});
