import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, vi } from 'vitest';

import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import type { CliInvocation } from '../process/invocation.js';
import {
  nativeProcessesForInvocation,
  type NativeProcessController,
} from '../process/native-process-owner.js';

/** A physical child witness for host-only forwarding, with an independent tool timeout. */
export async function witnessNativeToolProcess(
  nativeProcesses: NativeProcessController | undefined,
  invocation: CliInvocation,
  workspaceDir: string,
  expectedParentOwners = 0,
): Promise<void> {
  expect(nativeProcesses, 'NATIVE_INVOCATION_FORWARDING').toBe(
    nativeProcessesForInvocation(invocation),
  );
  const { host } = assembleToolEnv({
    profile: 'workflow-read-write',
    fsScopeTier: 'project',
    workspaceDir,
    ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
  });
  if (host.process === undefined) throw new Error('the real process arm is missing');
  expect(invocation.registry.activeOwners).toBe(expectedParentOwners);
  const pending = host.process.spawn(
    process.execPath,
    ['-e', 'setTimeout(() => process.stdout.write("native-witness"), 150)'],
    {},
    { timeoutMs: 2_000 },
  );
  await vi.waitFor(
    () =>
      expect(invocation.registry.activeOwners, 'NATIVE_PROCESS_ASSEMBLY_OWNERSHIP').toBe(
        expectedParentOwners + 1,
      ),
    { interval: 1 },
  );
  expect(await pending).toMatchObject({ exitCode: 0, stdout: 'native-witness' });
  await vi.waitFor(() => expect(invocation.registry.activeOwners).toBe(expectedParentOwners), {
    interval: 1,
  });
}

/** Keep an actual tool child alive across overlapping builders, bounded independently of their gates. */
export async function holdNativeToolProcess(
  nativeProcesses: NativeProcessController | undefined,
  invocation: CliInvocation,
  workspaceDir: string,
): Promise<{ close: () => Promise<void> }> {
  expect(nativeProcesses, 'NATIVE_PENDING_FORWARDING').toBe(
    nativeProcessesForInvocation(invocation),
  );
  const before = invocation.registry.activeOwners;
  const marker = join(workspaceDir, `native-${randomUUID()}.marker`);
  const abort = new AbortController();
  const { host } = assembleToolEnv({
    profile: 'workflow-read-write',
    fsScopeTier: 'project',
    workspaceDir,
    ...(nativeProcesses === undefined ? {} : { nativeProcesses }),
  });
  if (host.process === undefined) throw new Error('the real process arm is missing');
  const pending = host.process
    .spawn(
      process.execPath,
      [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "started"); setTimeout(() => {}, 30000)',
        marker,
      ],
      {},
      { timeoutMs: 3_000 },
      abort.signal,
    )
    .catch((error: unknown) => error);
  const close = async (): Promise<void> => {
    abort.abort();
    await pending;
    rmSync(marker, { force: true });
  };
  try {
    await vi.waitFor(
      () => {
        expect(existsSync(marker)).toBe(true); // physical native entry, not only a reserved field
        expect(invocation.registry.activeOwners).toBe(before + 1);
      },
      { interval: 1 },
    );
    return { close };
  } catch (error) {
    await close();
    throw error;
  }
}
