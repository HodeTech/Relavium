import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ChatMode } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import { globalConfigPath, type PreparedConfigWrite } from '../config/write.js';
import type { NoticeFlush } from '../engine/effect-retention.js';
import { createStartingModeRuntime, type StartingModeRuntime } from './starting-mode.js';
import { activateStartingModeHint, type StartingModeHintOptions } from './starting-mode-hint.js';

function deferred() {
  let release = (): void => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

describe('starting-mode hint activation ordering (controlled flush ports, not real frame proof)', () => {
  let root: string;
  let home: string;
  let cwd: string;
  let configPath: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-starting-hint-'));
    home = join(root, 'home');
    cwd = join(root, 'workspace');
    configPath = join(root, 'selected-config.toml');
    mkdirSync(home);
    mkdirSync(cwd);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function fixture(interactive = true) {
    const runtime = createStartingModeRuntime(
      loadResolvedConfig({ home, cwd, configPath }),
      interactive,
    );
    let active = true;
    let admitting = true;
    let mode: ChatMode = 'ask';
    const notice = vi.fn<(text: string) => void>();
    const flushNotice = vi.fn<NoticeFlush>(async (publish) => {
      await publish?.();
    });
    const options: StartingModeHintOptions = {
      runtime,
      cwd,
      selection: runtime.resolve(cwd).startingMode,
      currentMode: () => mode,
      isActive: () => active,
      assertAdmitting: () => {
        if (!admitting) throw new Error('PRIVATE_OWNER_FAILURE');
      },
      notice,
      flushNotice,
    };
    return {
      options,
      runtime,
      notice,
      flushNotice,
      deactivate: () => {
        active = false;
      },
      stop: () => {
        admitting = false;
      },
      setMode: (value: ChatMode) => {
        mode = value;
      },
    };
  }

  const prepared = (publish = vi.fn(() => ({ durability: 'confirmed' as const }))) => ({
    rewriteNeeded: false,
    publish,
  });

  it('waits for hint and rewrite acknowledgements before the writer and uses its final gate', async () => {
    const f = fixture();
    const hint = deferred();
    const rewrite = deferred();
    f.flushNotice
      .mockImplementationOnce(async (publish) => {
        await publish?.();
        await hint.promise;
      })
      .mockImplementationOnce(async (publish) => {
        await publish?.();
        await rewrite.promise;
      });
    const finalGate = vi.fn();
    const publish = vi.fn((assertAdmitting?: () => void) => {
      expect(assertAdmitting).toBeTypeOf('function');
      assertAdmitting?.();
      assertAdmitting?.();
      return { durability: 'confirmed' } as const;
    });
    const prepareHintShown = vi.fn(() => ({ rewriteNeeded: true, publish }));
    const running = activateStartingModeHint(
      { ...f.options, assertVisible: finalGate },
      { prepareHintShown },
    );
    await vi.waitFor(() => expect(f.notice).toHaveBeenCalledTimes(1));
    expect(f.notice.mock.calls[0]?.[0]).toMatch(/ask.*Shift\+Tab.*\/mode.*startup default/);
    expect(prepareHintShown).not.toHaveBeenCalled();
    hint.release();
    await vi.waitFor(() => expect(f.flushNotice).toHaveBeenCalledTimes(2));
    expect(prepareHintShown).toHaveBeenCalledExactlyOnceWith(home, configPath);
    expect(f.notice.mock.calls[1]?.[0]).toContain('removes its comments and ordering');
    expect(publish).not.toHaveBeenCalled();
    rewrite.release();
    await running;
    expect(publish).toHaveBeenCalledTimes(1);
    expect(finalGate).toHaveBeenCalledTimes(4);
    expect(f.notice.mock.calls.at(-1)?.[0]).toBe('Startup mode hint recorded.');
  });

  it.each(['inactive', 'headless', 'explicit', 'foreign', 'plan', 'accept-edits', 'auto'] as const)(
    'does not read or publish for an ineligible activation: %s',
    async (kind) => {
      const f = fixture(kind !== 'headless');
      const read = vi.fn((currentCwd: string) => f.runtime.read(currentCwd));
      const runtime: StartingModeRuntime = { ...f.runtime, read };
      const selection =
        kind === 'explicit'
          ? runtime.authority.explicit('ask')
          : kind === 'foreign'
            ? fixture().options.selection
            : kind === 'plan' || kind === 'accept-edits' || kind === 'auto'
              ? { ...f.options.selection, mode: kind }
              : f.options.selection;
      if (kind === 'inactive') f.deactivate();
      const prepareHintShown = vi.fn(() => prepared());
      await activateStartingModeHint({ ...f.options, runtime, selection }, { prepareHintShown });
      expect(read).not.toHaveBeenCalled();
      expect(f.flushNotice).not.toHaveBeenCalled();
      expect(prepareHintShown).not.toHaveBeenCalled();
    },
  );

  it('does not offer the hint after a current-mode change or an already recorded acknowledgement', async () => {
    const changed = fixture();
    changed.setMode('plan');
    const prepareHintShown = vi.fn(() => prepared());
    await activateStartingModeHint(changed.options, { prepareHintShown });
    expect(changed.notice).not.toHaveBeenCalled();
    writeFileSync(configPath, '[preferences]\ndefault_mode_hint_shown=true\n');
    const recorded = fixture();
    await activateStartingModeHint(recorded.options, { prepareHintShown });
    expect(recorded.notice).not.toHaveBeenCalled();
    expect(prepareHintShown).not.toHaveBeenCalled();
  });

  it('strictly reloads current preferences and observes narrowing without publishing', async () => {
    const f = fixture();
    const observe = vi.spyOn(f.runtime.authority, 'observe');
    writeFileSync(configPath, '[preferences]\ndefault_mode="plan"\n');
    const prepareHintShown = vi.fn(() => prepared());
    await activateStartingModeHint(f.options, { prepareHintShown });
    expect(observe).toHaveBeenCalledWith(expect.objectContaining({ mode: 'plan' }));
    expect(f.notice).not.toHaveBeenCalled();
    expect(prepareHintShown).not.toHaveBeenCalled();
  });

  it('revokes on a strict read error and reports only a fixed nonblocking notice', async () => {
    const f = fixture();
    const revoke = vi.spyOn(f.runtime.authority, 'revoke');
    writeFileSync(configPath, 'PRIVATE_CONFIG_FAILURE=[');
    const prepareHintShown = vi.fn(() => prepared());
    await expect(
      activateStartingModeHint(f.options, { prepareHintShown }),
    ).resolves.toBeUndefined();
    expect(revoke).toHaveBeenCalled();
    expect(prepareHintShown).not.toHaveBeenCalled();
    expect(f.notice.mock.calls).toEqual([
      ['The startup mode hint could not be recorded. Chat remains available.'],
    ]);
  });

  it.each(['clipped', 'disposed', 'mode-changed', 'owner-stopped'] as const)(
    'does not consume an unacknowledged activation and lets a replacement retry: %s',
    async (kind) => {
      const f = fixture();
      f.flushNotice.mockImplementationOnce(async (publish) => {
        await publish?.();
        if (kind === 'disposed') f.deactivate();
        else if (kind === 'mode-changed') f.setMode('plan');
        else if (kind === 'owner-stopped') f.stop();
        else throw new Error('PRIVATE_CLIPPED_NOTICE');
      });
      const publish = vi.fn(() => ({ durability: 'confirmed' as const }));
      const prepareHintShown = vi.fn(() => prepared(publish));
      await activateStartingModeHint(f.options, { prepareHintShown });
      expect(prepareHintShown).not.toHaveBeenCalled();
      const next = fixture();
      await activateStartingModeHint(
        { ...next.options, runtime: f.runtime, selection: f.options.selection },
        { prepareHintShown },
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(f.notice.mock.calls.flat().join(' ')).not.toContain('PRIVATE_');
    },
  );

  it('serializes overlapping activations and retries only the surviving current session', async () => {
    const old = fixture();
    const acknowledgement = deferred();
    old.flushNotice.mockImplementationOnce(async (publish) => {
      await publish?.();
      await acknowledgement.promise;
    });
    const publish = vi.fn(() => ({ durability: 'confirmed' as const }));
    const prepareHintShown = vi.fn(() => prepared(publish));
    const first = activateStartingModeHint(old.options, { prepareHintShown });
    await vi.waitFor(() => expect(old.flushNotice).toHaveBeenCalledTimes(1));
    const next = fixture();
    const options = { ...next.options, runtime: old.runtime, selection: old.options.selection };
    const second = activateStartingModeHint(options, { prepareHintShown });
    expect(next.flushNotice).not.toHaveBeenCalled();
    old.deactivate();
    acknowledgement.release();
    await Promise.all([first, second]);
    expect(next.flushNotice).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
    await activateStartingModeHint(options, { prepareHintShown });
    expect(publish).toHaveBeenCalledTimes(1);
  });

  it.each(['prepare', 'publish'] as const)(
    'a recording failure after visible delivery does not repeat the hint in the invocation: %s',
    async (phase) => {
      const f = fixture();
      const prepareHintShown = vi.fn((): PreparedConfigWrite => {
        if (phase === 'prepare') throw new Error('PRIVATE_PREPARE_FAILURE');
        return {
          rewriteNeeded: false,
          publish: () => {
            throw new Error('PRIVATE_PUBLICATION_FAILURE');
          },
        };
      });
      await expect(
        activateStartingModeHint(f.options, { prepareHintShown }),
      ).resolves.toBeUndefined();
      await activateStartingModeHint(f.options, { prepareHintShown });
      expect(prepareHintShown).toHaveBeenCalledTimes(1);
      expect(f.flushNotice).toHaveBeenCalledTimes(1);
      expect(f.notice.mock.calls.at(-1)?.[0]).toBe(
        'The startup mode hint could not be recorded. Chat remains available.',
      );
      expect(f.notice.mock.calls.flat().join(' ')).not.toContain('PRIVATE_');
    },
  );

  it('does not publish if the rewrite notice cannot be acknowledged', async () => {
    const f = fixture();
    f.flushNotice.mockImplementationOnce(async (publish) => {
      await publish?.();
    });
    f.flushNotice.mockImplementationOnce(async (publish) => {
      await publish?.();
      throw new Error('PRIVATE_REWRITE_FAILURE');
    });
    const publish = vi.fn(() => ({ durability: 'confirmed' as const }));
    await activateStartingModeHint(f.options, {
      prepareHintShown: () => ({ rewriteNeeded: true, publish }),
    });
    expect(publish).not.toHaveBeenCalled();
    expect(f.notice.mock.calls.flat().join(' ')).not.toContain('PRIVATE_');
  });

  it.each(['owner', 'active', 'frame', 'mode'] as const)(
    'rechecks %s at the writer final gate and never acknowledges after late invalidation',
    async (kind) => {
      const f = fixture();
      let frameValid = true;
      let recorded = false;
      const publish = vi.fn((assertAdmitting?: () => void) => {
        assertAdmitting?.();
        if (kind === 'owner') f.stop();
        else if (kind === 'active') f.deactivate();
        else if (kind === 'mode') f.setMode('plan');
        else frameValid = false;
        assertAdmitting?.();
        recorded = true;
        return { durability: 'confirmed' } as const;
      });
      await activateStartingModeHint(
        {
          ...f.options,
          assertVisible: () => {
            if (!frameValid) throw new Error('PRIVATE_FRAME_FAILURE');
          },
        },
        { prepareHintShown: () => ({ rewriteNeeded: false, publish }) },
      );
      expect(publish).toHaveBeenCalledTimes(1);
      expect(recorded).toBe(false);
      expect(f.notice.mock.calls.flat().join(' ')).not.toContain('PRIVATE_');
      expect(f.notice.mock.calls.flat()).not.toContain('Startup mode hint recorded.');
    },
  );

  it('reports publication with uncertain durability as recorded, not unsaved', async () => {
    const f = fixture();
    await activateStartingModeHint(f.options, {
      prepareHintShown: () => ({
        rewriteNeeded: false,
        publish: () => ({ durability: 'unconfirmed' }),
      }),
    });
    expect(f.notice.mock.calls.at(-1)?.[0]).toBe(
      'Startup mode hint recorded, but persistence after a crash could not be confirmed.',
    );
  });

  it('uses the real typed writer on the pinned operator file only after controlled disclosure', async () => {
    writeFileSync(configPath, '# operator comment\n[preferences]\nalt_screen=false\n');
    const original = readFileSync(configPath, 'utf8');
    const f = fixture();
    const publications: string[] = [];
    f.flushNotice.mockImplementation(async (publish) => {
      expect(readFileSync(configPath, 'utf8')).toBe(original);
      await publish?.();
      publications.push(f.notice.mock.calls.at(-1)?.[0] ?? '');
    });
    await activateStartingModeHint(f.options);
    expect(publications).toHaveLength(2);
    expect(publications[0]).toContain('Shift+Tab');
    expect(publications[1]).toContain('removes its comments and ordering');
    const loaded = loadResolvedConfig({ home, cwd, configPath });
    expect(loaded.globalConfig?.preferences).toMatchObject({
      alt_screen: false,
      default_mode_hint_shown: true,
    });
    expect(existsSync(globalConfigPath(home))).toBe(false);
    const anotherInvocation = fixture();
    await activateStartingModeHint(anotherInvocation.options);
    expect(anotherInvocation.notice).not.toHaveBeenCalled();
  });

  it('contains a failed diagnostic sink as well as a failed owner assertion', async () => {
    const f = fixture();
    f.notice.mockImplementation(() => {
      throw new Error('PRIVATE_NOTICE_FAILURE');
    });
    await expect(activateStartingModeHint(f.options)).resolves.toBeUndefined();
    f.stop();
    await expect(activateStartingModeHint(f.options)).resolves.toBeUndefined();
    expect(existsSync(configPath)).toBe(false);
  });

  it('provisions the canonical operator directory without relying on database creation', async () => {
    configPath = globalConfigPath(home);
    const f = fixture();
    expect(existsSync(join(home, '.relavium'))).toBe(false);
    await activateStartingModeHint(f.options);
    expect(loadResolvedConfig({ home, cwd }).globalConfig?.preferences).toMatchObject({
      default_mode_hint_shown: true,
    });
    expect(f.flushNotice).toHaveBeenCalledTimes(1);
    expect(f.notice.mock.calls.at(-1)?.[0]).toBe('Startup mode hint recorded.');
  });
});
