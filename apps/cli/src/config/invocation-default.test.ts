import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createStartingModeRuntime } from '../chat/starting-mode.js';
import { applyInvocationDefault } from './invocation-default.js';
import { loadResolvedConfig } from './load.js';

const roots: string[] = [];
const binding = { model: 'claude-sonnet-4-6', provider: 'anthropic' } as const;
function fixture(file: string, content: string) {
  const root = mkdtempSync(join(tmpdir(), 'rlv-model-provenance-'));
  roots.push(root);
  const home = join(root, 'operator');
  const cwd = join(root, 'workspace');
  mkdirSync(join(home, '.relavium'), { recursive: true });
  mkdirSync(join(cwd, '.relavium'), { recursive: true });
  writeFileSync(
    join(home, '.relavium', 'config.toml'),
    '[preferences]\ndefault_mode="auto"\ndefault_model="gpt-4o"\ndefault_provider="openai"\n',
  );
  const target = join(cwd, '.relavium', file);
  writeFileSync(target, content);
  const initial = loadResolvedConfig({ home, cwd });
  return { target, cwd, initial };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('invocation model fallback uses the validated configuration snapshot', () => {
  it.each(['project.toml', 'workspace.toml'])(
    'preserves %s model provenance without reopening its file',
    (file) => {
      const f = fixture(file, '[chat]\ndefault_model="gpt-4o"\n');
      writeFileSync(f.target, 'invalid TOML [');
      expect(applyInvocationDefault(f.initial, binding)).toBe(f.initial);
    },
  );

  it.each(['project.toml', 'workspace.toml'])(
    'applies ephemeral fallback from the same snapshot before a later %s observation revokes auto',
    (file) => {
      const f = fixture(file, '[chat]\nmax_turns=10\n');
      const runtime = createStartingModeRuntime(f.initial, true);
      const selected = runtime.resolve(f.cwd);
      writeFileSync(f.target, '[chat]\ndefault_mode="PRIVATE_INVALID_MODE"\n');
      expect(applyInvocationDefault(selected.loaded, binding).config.chat).toMatchObject({
        defaultModel: binding.model,
        defaultProvider: binding.provider,
        defaultMode: 'auto',
      });
      expect(() =>
        runtime.authority.assertDispatch(selected.startingMode, 'write_file'),
      ).not.toThrow();
      expect(() => runtime.read(f.cwd)).toThrow();
      expect(() => runtime.authority.assertDispatch(selected.startingMode, 'write_file')).toThrow(
        'revoked',
      );
    },
  );
});
