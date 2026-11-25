import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { expect, it, vi } from 'vitest';

import { scriptedResolver } from '../chat/test-support.js';
import type { RootAppProps } from '../render/tui/home-app.js';
import { captureIo } from '../test-support.js';
import { driveHome } from './drive-home.js';

/**
 * The Home's `/doctor` reads in the TUI's words (MVP-11 Step 2 review round 2, N1): the real probes (no injected `doctorProbes`), a home that
 * holds a global workflow, and the report the Home draws. Since MVP-11 Step 4b the report is the `/doctor` POPUP (ADR-0148 §8), which writes
 * nothing into the Home's notice. A new file, small on purpose: the Home's own drive tests are large.
 */
vi.mock('../secrets/os-keychain.js', () => ({
  createOsKeychainStore: () => ({ get: () => null, set: () => undefined, delete: () => false }),
}));

it('the Home’s /doctor opens its popup, which names /import and no shell command, and writes no notice', async () => {
  const client = createClient(':memory:');
  runMigrations(client.db);
  const cwd = mkdtempSync(join(tmpdir(), 'relavium-home-doctor-surface-cwd-'));
  const homeDir = mkdtempSync(join(tmpdir(), 'relavium-home-doctor-surface-home-'));
  mkdirSync(join(homeDir, '.relavium', 'workflows'), { recursive: true });
  writeFileSync(join(homeDir, '.relavium', 'workflows', 'global-flow.relavium.yaml'), 'name: x\n');
  const captured = captureIo();
  let props: RootAppProps | undefined;
  let unmount = (): void => {};
  const exited = new Promise<void>((resolve) => {
    unmount = resolve;
  });
  const running = driveHome({
    homeDir,
    writeControl: (sequence) => captured.io.writeOut(sequence),
    io: { ...captured.io, stdoutIsTty: true, stdinIsTty: true },
    global: {
      cwd,
      configPath: join(cwd, 'absent.toml'),
      json: false,
      color: false,
      verbosity: 'normal',
    },
    providers: scriptedResolver([]),
    openSessionStore: () => ({
      db: client.db,
      store: createSessionStore(client.db),
      close: () => client.sqlite.close(),
    }),
    render: (value) => {
      props = value;
      value.onRendererReady?.(async (publish) => {
        await publish?.();
      });
      return {
        unmount,
        waitUntilExit: () => exited,
        waitUntilRenderFlush: () => Promise.resolve(),
      };
    },
    getSize: () => ({ cols: 120, rows: 40 }),
    subscribeResize: () => () => {},
    subscribeSignals: () => () => {},
    subscribeProcessExit: () => () => {},
    jobControlLifecycle: {
      supported: false,
      onSuspend: () => () => {},
      onContinue: () => () => {},
      suspendSelf: () => {},
    },
    onboardingTerminalLifecycle: {
      onInput: () => () => {},
      isRawMode: () => false,
      setRawMode: () => {},
    },
  });
  try {
    await vi.waitFor(() => expect(props).toBeDefined());
    const controller = props?.controller;
    if (controller === undefined) throw new Error('missing Home mount');
    controller.handleKey('/', {});
    for (const char of 'doctor') controller.handleKey(char, {});
    controller.handleKey('', { return: true });
    const popups = props?.popups;
    if (popups === undefined) throw new Error('the Home has a popup host');
    /** The rows of the popup's checks, as words. */
    const report = (): string => {
      const content = popups.getSnapshot().frame?.steps[0]?.content;
      return content?.kind === 'list'
        ? content.rows.map((row) => `${row.label}: ${row.detail ?? ''}`).join('\n')
        : '';
    };
    await vi.waitFor(() => expect(report()).toContain('Workflows or agents in'), {
      timeout: 5000,
    });
    expect(report()).toContain('/import');
    expect(report()).not.toContain('relavium import');
    expect(controller.getSnapshot().notice).toBeUndefined();
    popups.closeAll('escape');
    // A line typed into the prompt (pasted: a lone `/` would open the palette instead) is answered by the landing, and the prompt does not keep
    // `/doctor` behind the popup.
    controller.handlePaste('/doctor');
    expect(controller.getSnapshot().input.text).toBe('/doctor');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(popups.getSnapshot().frame?.spec.id).toBe('doctor'), {
      timeout: 5000,
    });
    expect(controller.getSnapshot().input.text).toBe('');
    popups.closeAll('escape');
    // The deep tier is new on the Home: a typed `/doctor --deep` opens the popup on its confirmation line (it still needs its chord).
    controller.handlePaste('/doctor --deep');
    expect(controller.getSnapshot().input.text).toBe('/doctor --deep');
    controller.handleKey('', { return: true });
    await vi.waitFor(() => expect(popups.getSnapshot().frame?.stepIndex).toBe(2), {
      timeout: 5000,
    });
    expect(popups.getSnapshot().frame?.spec.id).toBe('doctor');
    expect(controller.getSnapshot().notice).toBeUndefined();
    expect(controller.getSnapshot().input.text).toBe('');
    popups.closeAll('escape');
    controller.handleKey('c', { ctrl: true });
    controller.handleKey('c', { ctrl: true });
  } finally {
    unmount();
    await running;
    rmSync(cwd, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  }
});
