import { execFileSync } from 'node:child_process';

import { describe, expect, it, vi } from 'vitest';

import { createNativeProcessController } from '../../process/native-process-owner.js';

import { captureCreationMask, captureRequiredCreationMask } from './fs-creation-mask.js';

describe('creation mask observation', () => {
  it('does not reserve a process when the native profile reads the mask', async () => {
    const processes = createNativeProcessController();
    const reserve = vi.fn(processes.reserve);
    await expect(
      captureRequiredCreationMask({ reserve, observeMcp: processes.observeMcp }, false),
    ).resolves.toBeUndefined();
    expect(reserve).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === 'win32')(
    'observes the inherited mask in a joined child',
    async () => {
      const expected = Number.parseInt(
        execFileSync('/bin/sh', ['-c', 'umask'], { encoding: 'utf8' }).trim(),
        8,
      );
      await expect(captureCreationMask(createNativeProcessController())).resolves.toBe(expected);
    },
  );

  it('refuses a cancelled query', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      captureCreationMask(createNativeProcessController(), controller.signal),
    ).rejects.toThrow('filesystem creation policy unavailable');
  });
});
