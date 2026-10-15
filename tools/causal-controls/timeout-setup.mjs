/** Runtime fence for effective Vitest case/configured hook budgets in physical phases. */
import { beforeEach, vi } from 'vitest';

const maxMilliseconds = 15_000;
function assertBudget(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maxMilliseconds)
    throw new Error(`CAUSAL_TIMEOUT_BUDGET: ${label} exceeds ${maxMilliseconds} ms`);
}

const setConfig = vi.setConfig;
vi.setConfig = (config) => {
  for (const name of ['testTimeout', 'hookTimeout'])
    if (config[name] !== undefined) assertBudget(config[name], name);
  return setConfig(config);
};

beforeEach(({ task }) => assertBudget(task.timeout, 'effective case timeout'));
