/**
 * The saved startup default the `/mode` popup marks `startup` ([ADR-0148](../../../../docs/decisions/0148-a-user-started-report-setting-or-flow-is-a-centred-popup.md)
 * §3; MVP-11 unit 8, OD-25): read through the invocation's own runtime when the popup opens, `undefined` where it cannot be read, never guessed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadResolvedConfig } from '../config/load.js';
import { readStartupDefault } from './startup-default.js';
import { createStartingModeRuntime } from './starting-mode.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(config: string | undefined) {
  const root = mkdtempSync(join(tmpdir(), 'relavium-startup-default-'));
  roots.push(root);
  const home = join(root, 'home');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(cwd);
  const path = join(home, '.relavium', 'config.toml');
  if (config !== undefined) writeFileSync(path, config);
  return { runtime: createStartingModeRuntime(loadResolvedConfig({ cwd, home }), true), cwd, path };
}

describe('readStartupDefault', () => {
  it.each(['ask', 'plan', 'accept-edits', 'auto'] as const)(
    'reads the global default_mode %s',
    (mode) => {
      const f = fixture(`[preferences]\ndefault_mode = "${mode}"\n`);
      expect(readStartupDefault(f.runtime, f.cwd)).toBe(mode);
    },
  );

  it('with no config file, or none that names a mode, the default is `ask`', () => {
    expect(readStartupDefault(fixture(undefined).runtime, fixture(undefined).cwd)).toBe('ask');
    const f = fixture('[preferences]\ntheme = "kept"\n');
    expect(readStartupDefault(f.runtime, f.cwd)).toBe('ask');
  });

  it('reads the file as it is NOW, not as it was when the chat started (a live read through the runtime)', () => {
    const f = fixture('[preferences]\ndefault_mode = "ask"\n');
    expect(readStartupDefault(f.runtime, f.cwd)).toBe('ask');
    writeFileSync(f.path, '[preferences]\ndefault_mode = "plan"\n');
    expect(readStartupDefault(f.runtime, f.cwd)).toBe('plan');
  });

  it('a configuration that cannot be read is `undefined`, never a guess, and never throws', () => {
    const f = fixture('[preferences]\ndefault_mode = "plan"\n');
    writeFileSync(f.path, '[preferences\ndefault_mode="x27\n');
    expect(readStartupDefault(f.runtime, f.cwd)).toBeUndefined();
    const throwing = vi.fn(() => {
      throw new Error('the configuration could not be read');
    });
    expect(readStartupDefault({ read: throwing }, f.cwd)).toBeUndefined();
    expect(throwing).toHaveBeenCalledOnce();
  });

  it('a broken configuration revokes startup auto for this invocation (the runtime’s own observation, a narrowing only)', () => {
    const f = fixture('[preferences]\ndefault_mode = "auto"\n');
    expect(f.runtime.authority.revocationRevision).toBe(0);
    writeFileSync(f.path, '[preferences\ndefault_mode="x27\n');
    expect(readStartupDefault(f.runtime, f.cwd)).toBeUndefined();
    expect(f.runtime.authority.revocationRevision).toBeGreaterThan(0);
  });
});
