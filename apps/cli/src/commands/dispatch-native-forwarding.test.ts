import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createCliInvocation, type CliInvocation } from '../process/invocation.js';
import { nativeProcessesForInvocation } from '../process/native-process-owner.js';
import { captureIo } from '../test-support.js';
import { executeCommand, type CommandInput, type DispatchContext } from './dispatch.js';
import { witnessNativeToolProcess } from './native-forwarding.test-support.js';

const receivedInvocations: CliInvocation[] = [];

/** Retain the real production dependency projections; replace only the command body with a native owner. */
async function nativeBoundary(deps: DispatchContext): Promise<0> {
  expect(deps.invocation, 'NATIVE_DISPATCH_INVOCATION').toBeDefined();
  if (deps.invocation === undefined) throw new Error('dispatch omitted the original invocation');
  receivedInvocations.push(deps.invocation);
  await witnessNativeToolProcess(
    nativeProcessesForInvocation(deps.invocation),
    deps.invocation,
    deps.global.cwd,
  );
  return 0;
}

vi.mock('./run.js', () => ({
  runCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
}));
vi.mock('./chat.js', () => ({
  chatCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
  chatResumeCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
}));
vi.mock('./agent-run.js', () => ({
  agentRunCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
}));
vi.mock('./gate.js', () => ({
  gateCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
  budgetCommand: (_args: unknown, deps: DispatchContext) => nativeBoundary(deps),
}));

const routes: readonly (readonly [string, CommandInput])[] = [
  ['run', { positionals: ['workflow'], options: {} }],
  ['chat', { positionals: [], options: {} }],
  ['chat-resume', { positionals: ['session'], options: {} }],
  ['agent.run', { positionals: ['agent'], options: {} }],
  ['gate', { positionals: ['run'], options: { approve: true } }],
  ['budget.resume', { positionals: ['run'], options: { approveAmount: '1' } }],
];

describe('production native dispatch dependency forwarding', () => {
  it.each(routes)(
    '%s reaches physical native creation under the supplied registry',
    async (id, input) => {
      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-dispatch-native-')));
      const invocation = createCliInvocation();
      const before = receivedInvocations.length;
      try {
        expect(
          await executeCommand(id, input, {
            io: captureIo().io,
            global: { json: false, color: false, cwd, configPath: undefined, verbosity: 'normal' },
            invocation,
          }),
        ).toBe(0);
        expect(receivedInvocations.slice(before), 'NATIVE_DISPATCH_ENTERS_ONCE').toHaveLength(1);
        expect(receivedInvocations[before], 'NATIVE_DISPATCH_ORIGINAL_INVOCATION').toBe(invocation);
        expect(invocation.registry.activeOwners).toBe(0);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );
});
