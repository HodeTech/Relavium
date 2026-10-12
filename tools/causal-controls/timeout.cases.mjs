import { it, vi } from 'vitest';

if (process.env.RELAVIUM_CAUSAL_TIMEOUT_FIXTURE === 'config') {
  vi.setConfig({ hookTimeout: 20_000 });
  it('config override should never run', () => {});
} else {
  it('effective case override should never run', () => {}, 20_000);
}
