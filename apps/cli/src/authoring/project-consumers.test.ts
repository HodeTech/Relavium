import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildAuthored, serializeAuthored } from './authoring.js';
import { GLOBAL_ARTIFACTS_REMEDY, globalArtifactsNotice } from './global-artifacts.js';
import { createCommand } from '../commands/create.js';
import { importCommand } from '../commands/import.js';
import { exportCommand } from '../commands/export.js';
import { listCommand } from '../commands/list.js';
import { exportSessionToProject } from '../chat/export.js';
import { assembleDoctorProbes } from '../chat/doctor-host.js';
import { runDoctorChecks } from '../chat/doctor.js';
import { loadResolvedConfig } from '../config/load.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';

describe('project consumers never use global artifacts as project state', () => {
  let root: string, home: string, cwd: string, globalDir: string;
  let client: DbClient;
  let global: GlobalOptions;
  const spec = {
    kind: 'agent',
    name: 'local-agent',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'hello',
    tools: [],
  } as const;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-project-consumers-'));
    home = join(root, 'home');
    cwd = join(home, 'project');
    globalDir = join(home, '.relavium');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(join(globalDir, 'agents'), { recursive: true });
    mkdirSync(join(globalDir, 'workflows'));
    writeFileSync(
      join(globalDir, 'agents', 'global-agent.agent.yaml'),
      serializeAuthored(buildAuthored({ ...spec, name: 'global-agent' })),
    );
    writeFileSync(
      join(globalDir, 'workflows', 'global-flow.relavium.yaml'),
      serializeAuthored(buildAuthored({ ...spec, kind: 'workflow', name: 'global-flow' })),
    );
    writeFileSync(join(globalDir, 'project.toml'), '[defaults]\nmodel = "must-not-load-project"\n');
    writeFileSync(
      join(globalDir, 'workspace.toml'),
      '[defaults]\nmodel = "must-not-load-workspace"\n',
    );
    writeFileSync(
      join(globalDir, 'config.toml'),
      '[preferences]\ndefault_model = "operator-model"\n',
    );
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    global = { cwd, configPath: undefined, json: false, color: false, verbosity: 'normal' };
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  });

  it('loads only operator config until a real project layer exists, including home cwd', () => {
    for (const directory of [cwd, home]) {
      const loaded = loadResolvedConfig({ cwd: directory, home });
      expect(loaded.projectConfigDir).toBeUndefined();
      expect(loaded.config.defaultModel).toBe('operator-model');
    }
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(
      join(cwd, '.relavium', 'project.toml'),
      '[defaults]\nmodel = "real-project-model"\n',
    );
    expect(loadResolvedConfig({ cwd, home }).config.defaultModel).toBe('real-project-model');
    expect(readFileSync(join(globalDir, 'project.toml'), 'utf8')).toContain(
      'must-not-load-project',
    );
  });

  it('creates, imports and exports only in the local project and preserves the old global catalog', async () => {
    const captured = captureIo();
    const previous = readFileSync(join(globalDir, 'agents', 'global-agent.agent.yaml'), 'utf8');
    expect(
      await createCommand(
        { force: false },
        { io: captured.io, global, prompter: { gather: () => Promise.resolve(spec) } },
      ),
    ).toBe(0);
    expect(existsSync(join(cwd, '.relavium', 'agents', 'local-agent.agent.yaml'))).toBe(true);
    const source = join(root, 'import.agent.yaml');
    writeFileSync(source, serializeAuthored(buildAuthored({ ...spec, name: 'imported-agent' })));
    expect(importCommand({ path: source, force: false }, { io: captured.io, global })).toBe(0);
    expect(exportCommand({ id: 'imported-agent', force: false }, { io: captured.io, global })).toBe(
      0,
    );
    expect(readFileSync(join(cwd, 'imported-agent.agent.yaml'), 'utf8')).toContain(
      'imported-agent',
    );
    expect(readdirSync(join(globalDir, 'agents'))).toEqual(['global-agent.agent.yaml']);
    expect(readFileSync(join(globalDir, 'agents', 'global-agent.agent.yaml'), 'utf8')).toBe(
      previous,
    );
  });

  it('refuses authoring at home before prompting and in-chat export before history access', async () => {
    const captured = captureIo();
    const atHome = { ...global, cwd: home };
    const gather = vi.fn(() => Promise.resolve(spec));
    await expect(
      createCommand({ force: false }, { io: captured.io, global: atHome, prompter: { gather } }),
    ).rejects.toThrow('project directory');
    expect(gather).not.toHaveBeenCalled();
    const source = join(root, 'source.agent.yaml');
    writeFileSync(source, serializeAuthored(buildAuthored(spec)));
    expect(() =>
      importCommand({ path: source, force: false }, { io: captured.io, global: atHome }),
    ).toThrow('project directory');
    expect(() =>
      exportCommand({ id: 'global-agent', force: false }, { io: captured.io, global: atHome }),
    ).toThrow('project directory');
    const store = createSessionStore(client.db);
    const read = vi.spyOn(store, 'loadFull');
    for (const directory of [home, globalDir])
      expect(() =>
        exportSessionToProject({
          cwd: directory,
          homeDir: home,
          sessionId: 'not-read',
          store,
          projectConfigDir: undefined,
        }),
      ).toThrow('project directory');
    expect(read).not.toHaveBeenCalled();
    expect(existsSync(join(home, 'agents'))).toBe(false);
  });

  it('refuses an explicitly supplied global or aliased in-chat export destination', () => {
    const alias = join(root, 'global-alias');
    symlinkSync(globalDir, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const store = createSessionStore(client.db);
    const read = vi.spyOn(store, 'loadFull');
    for (const projectConfigDir of [globalDir, alias])
      expect(() =>
        exportSessionToProject({
          cwd,
          homeDir: home,
          projectConfigDir,
          sessionId: 'not-read',
          store,
        }),
      ).toThrow('project directory');
    expect(read).not.toHaveBeenCalled();
  });

  it('rechecks the create destination after its asynchronous wizard before publishing', async () => {
    const captured = captureIo();
    const globalBefore = readdirSync(join(globalDir, 'agents'));
    await expect(
      createCommand(
        { force: false },
        {
          io: captured.io,
          global,
          prompter: {
            gather: () => {
              symlinkSync(
                globalDir,
                join(cwd, '.relavium'),
                process.platform === 'win32' ? 'junction' : 'dir',
              );
              return Promise.resolve(spec);
            },
          },
        },
      ),
    ).rejects.toThrow('project directory');
    expect(readdirSync(join(globalDir, 'agents'))).toEqual(globalBefore);
    expect(captured.out()).toBe('');
  });

  it.each([false, true])(
    'list ignores global ids, emits a safe move/import remedy and does not open history (json=%s)',
    (json) => {
      const captured = captureIo();
      const openDb = vi.fn(() => {
        throw new Error('Global-only listing must not open history');
      });
      expect(
        listCommand({ agents: false }, { io: captured.io, global: { ...global, json }, openDb }),
      ).toBe(0);
      expect(captured.err()).toContain(GLOBAL_ARTIFACTS_REMEDY);
      expect(captured.out()).not.toContain('global-flow');
      if (json) expect(captured.out()).toBe('');
      expect(openDb).not.toHaveBeenCalled();
    },
  );

  it('doctor reports the same read-only artifact remedy without changing the global files', async () => {
    const before = readFileSync(join(globalDir, 'workflows', 'global-flow.relavium.yaml'), 'utf8');
    const report = await runDoctorChecks(
      false,
      assembleDoctorProbes({
        cwd,
        resolver: { resolveProvider: () => undefined, keyFor: () => '' },
        keychain: { get: () => null, set: () => {}, delete: () => false },
      }),
    );
    expect(report.checks.find((check) => check.id === 'global-artifacts')).toMatchObject({
      status: 'warn',
      detail: GLOBAL_ARTIFACTS_REMEDY,
    });
    expect(globalArtifactsNotice(home)).toBe(GLOBAL_ARTIFACTS_REMEDY);
    expect(readFileSync(join(globalDir, 'workflows', 'global-flow.relavium.yaml'), 'utf8')).toBe(
      before,
    );
  });

  it('discloses incomplete global inspection instead of scanning an arbitrarily large folder', () => {
    rmSync(join(globalDir, 'workflows', 'global-flow.relavium.yaml'));
    for (let index = 0; index < 260; index++)
      writeFileSync(join(globalDir, 'workflows', `unrelated-${index}.txt`), 'untouched');
    const notice = globalArtifactsNotice(home);
    expect(notice).toContain('inspection was incomplete');
    expect(notice).toContain('relavium import');
    expect(notice).not.toContain('unrelated-');
    expect(readdirSync(join(globalDir, 'workflows'))).toHaveLength(260);
  });

  it('refuses an unresolved global alias instead of silently discarding an existing project layer', () => {
    mkdirSync(join(cwd, '.relavium'));
    writeFileSync(
      join(cwd, '.relavium', 'project.toml'),
      '[defaults]\nmodel = "must-retain-project-layer"\n',
    );
    rmSync(globalDir, { recursive: true });
    symlinkSync(
      join(root, 'missing-global'),
      globalDir,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(() => loadResolvedConfig({ cwd, home })).toThrow('could not be resolved safely');
    expect(readFileSync(join(cwd, '.relavium', 'project.toml'), 'utf8')).toContain(
      'must-retain-project-layer',
    );
  });
});
