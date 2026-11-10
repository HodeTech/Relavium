import {
  mkdirSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, createSessionStore, runMigrations } from '@relavium/db';
import { buildAuthored, serializeAuthored } from './authoring.js';
import { createCommand } from '../commands/create.js';
import { importCommand } from '../commands/import.js';
import { exportCommand } from '../commands/export.js';
import { discoverCatalog } from '../workflows/catalog.js';
import { resolveWorkflowSource, resolveYamlSource } from '../workflows/resolve.js';
import { resolveChatAgentSource } from '../chat/agent-source.js';
import { exportSession, exportSessionToProject } from '../chat/export.js';
import { captureIo } from '../test-support.js';
import type { GlobalOptions } from '../process/options.js';

describe('actual project catalog targets exclude global state', () => {
  let root: string, home: string, cwd: string, marker: string, globalDir: string;
  const spec = {
    kind: 'agent',
    name: 'sample',
    provider: 'anthropic',
    model: 'claude-sonnet-4-6',
    systemPrompt: 'local source',
    tools: [],
  } as const;
  const yaml = () => serializeAuthored(buildAuthored(spec));
  const options = (): GlobalOptions => ({
    cwd,
    configPath: undefined,
    json: true,
    color: false,
    verbosity: 'normal',
  });
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'relavium-artifact-boundary-'));
    home = join(root, 'home');
    cwd = join(home, 'project');
    marker = join(cwd, '.relavium');
    globalDir = join(home, '.relavium');
    for (const dir of [
      join(marker, 'agents'),
      join(marker, 'workflows'),
      join(globalDir, 'agents'),
      join(globalDir, 'workflows'),
    ])
      mkdirSync(dir, { recursive: true });
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });
  function nestedGlobal(): void {
    rmSync(globalDir, { recursive: true });
    const nested = join(marker, 'device-state');
    for (const kind of ['agents', 'workflows']) mkdirSync(join(nested, kind), { recursive: true });
    symlinkSync(nested, globalDir, process.platform === 'win32' ? 'junction' : 'dir');
  }

  function withSession(run: (store: ReturnType<typeof createSessionStore>) => void): void {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      const timestamp = '2026-11-10T00:00:00.000Z';
      store.createSession({
        id: 's1',
        agentSlug: 'sample',
        title: 'Local session',
        context: { workingDir: cwd, fsScopeTier: 'project' },
        status: 'active',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
      store.appendMessage({
        id: 'user',
        sessionId: 's1',
        sequenceNumber: 0,
        role: 'user',
        content: [{ type: 'text', text: 'private transcript' }],
        timestamp,
      });
      store.appendMessage({
        id: 'answer',
        sessionId: 's1',
        sequenceNumber: 1,
        role: 'assistant',
        content: [{ type: 'text', text: 'local answer' }],
        timestamp,
      });
      run(store);
    } finally {
      client.sqlite.close();
    }
  }

  it.each(['agents', 'workflows'] as const)(
    'refuses a bare %s id through a global file alias while explicit file references remain available',
    (kind) => {
      const suffix = kind === 'agents' ? '.agent.yaml' : '.relavium.yaml';
      const target = join(globalDir, kind, `sample${suffix}`);
      writeFileSync(target, kind === 'agents' ? yaml() : 'global workflow sentinel');
      const alias = join(marker, kind, `sample${suffix}`);
      symlinkSync(target, alias);
      const resolve = (ref: string) =>
        resolveYamlSource(ref, {
          cwd,
          kind,
          subdir: kind,
          projectConfigDir: marker,
          idSuffixes: [suffix],
          homeDir: home,
        });
      expect(() => resolve('sample')).toThrow('global configuration');
      expect(resolve(alias).yaml).toBe(readFileSync(target, 'utf8'));
      const entries = discoverCatalog({ projectConfigDir: marker, cwd, kind, homeDir: home });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.valid).toBe(false);
      expect(entries[0]?.error).toContain('global catalog links');
      if (kind === 'agents') {
        expect(() =>
          resolveChatAgentSource('sample', {
            cwd,
            projectConfigDir: marker,
            defaultModel: undefined,
          }),
        ).toThrow('global configuration');
        expect(
          resolveChatAgentSource(alias, { cwd, projectConfigDir: marker, defaultModel: undefined })
            .agent.id,
        ).toBe('sample');
      } else
        expect(() =>
          resolveWorkflowSource('sample', { cwd, projectConfigDir: marker, homeDir: home }),
        ).toThrow('global configuration');
    },
  );

  it.each(['import', 'create'] as const)(
    'refuses a forced %s through a final global file alias without changing its bytes',
    async (command) => {
      const target = join(globalDir, 'agents', 'sample.agent.yaml');
      writeFileSync(target, 'preserve-global-bytes\n');
      symlinkSync(target, join(marker, 'agents', 'sample.agent.yaml'));
      const source = join(root, 'source.agent.yaml');
      writeFileSync(source, yaml());
      const { io } = captureIo();
      if (command === 'import')
        expect(() =>
          importCommand({ path: source, force: true }, { io, global: options() }),
        ).toThrow('global configuration');
      else
        await expect(
          createCommand(
            { force: true },
            { io, global: options(), prompter: { gather: () => Promise.resolve(spec) } },
          ),
        ).rejects.toThrow('global configuration');
      expect(readFileSync(target, 'utf8')).toBe('preserve-global-bytes\n');
    },
  );

  it('excludes a canonical global directory nested within the project marker', async () => {
    nestedGlobal();
    rmdirSync(join(marker, 'agents'));
    symlinkSync(
      join(globalDir, 'agents'),
      join(marker, 'agents'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    writeFileSync(join(globalDir, 'agents', 'sample.agent.yaml'), yaml());
    expect(() =>
      discoverCatalog({ projectConfigDir: marker, cwd, kind: 'agents', homeDir: home }),
    ).toThrow('global configuration');
    expect(() =>
      resolveChatAgentSource('sample', { cwd, projectConfigDir: marker, defaultModel: undefined }),
    ).toThrow('global configuration');
    const source = join(root, 'source.agent.yaml');
    writeFileSync(source, yaml());
    const { io } = captureIo();
    expect(() => importCommand({ path: source, force: true }, { io, global: options() })).toThrow(
      'global configuration',
    );
    await expect(
      createCommand(
        { force: true },
        { io, global: options(), prompter: { gather: () => Promise.resolve(spec) } },
      ),
    ).rejects.toThrow('global configuration');
    expect(readdirSync(join(globalDir, 'agents'))).toEqual(['sample.agent.yaml']);
    expect(readFileSync(join(globalDir, 'agents', 'sample.agent.yaml'), 'utf8')).toBe(yaml());
  });

  it('rejects a global file alias even when canonical containment is inside the catalog', () => {
    nestedGlobal();
    const target = join(globalDir, 'agents', 'sample.agent.yaml');
    writeFileSync(target, yaml());
    symlinkSync(target, join(marker, 'agents', 'sample.agent.yaml'));
    const entry = discoverCatalog({
      projectConfigDir: marker,
      cwd,
      kind: 'agents',
      homeDir: home,
    })[0];
    expect(entry?.valid).toBe(false);
    expect(entry?.error).toContain('global catalog links');
  });

  it.each([false, true])(
    'refuses in-chat export through a global catalog directory before history access (nested=%s)',
    (nested) => {
      if (nested) nestedGlobal();
      rmdirSync(join(marker, 'workflows'));
      symlinkSync(
        join(globalDir, 'workflows'),
        join(marker, 'workflows'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const store = createSessionStore(client.db);
        const read = vi.spyOn(store, 'loadFull');
        expect(() =>
          exportSessionToProject({
            store,
            sessionId: 'not-read',
            cwd,
            homeDir: home,
            projectConfigDir: marker,
          }),
        ).toThrow('global configuration');
        expect(read).not.toHaveBeenCalled();
        expect(readdirSync(join(globalDir, 'workflows'))).toEqual([]);
      } finally {
        client.sqlite.close();
      }
    },
  );

  it('refuses unresolved dangling catalog targets before authoring', () => {
    symlinkSync(join(root, 'absent.agent.yaml'), join(marker, 'agents', 'sample.agent.yaml'));
    const source = join(root, 'source.agent.yaml');
    writeFileSync(source, yaml());
    const { io } = captureIo();
    expect(() => importCommand({ path: source, force: true }, { io, global: options() })).toThrow(
      'could not be resolved safely',
    );
  });

  it('still imports an explicitly selected global source into an ordinary project catalog', () => {
    const source = join(globalDir, 'agents', 'sample.agent.yaml');
    writeFileSync(source, yaml());
    const { io } = captureIo();
    expect(importCommand({ path: source, force: false }, { io, global: options() })).toBe(0);
    expect(readFileSync(join(marker, 'agents', 'sample.agent.yaml'), 'utf8')).toBe(yaml());
    expect(readFileSync(source, 'utf8')).toBe(yaml());
  });

  it.each(['artifact', 'session'] as const)(
    'refuses a default %s export through a global file alias, preserving explicit output selection',
    (kind) => {
      writeFileSync(join(marker, 'agents', 'sample.agent.yaml'), yaml());
      const name = kind === 'artifact' ? 'sample.agent.yaml' : 's1.relavium.yaml';
      const target = join(globalDir, name);
      const output = join(cwd, name);
      writeFileSync(target, 'preserve-global-output\n');
      symlinkSync(target, output);
      const { io } = captureIo();
      withSession((store) => {
        const write = (explicit: boolean) =>
          kind === 'artifact'
            ? exportCommand(
                { id: 'sample', force: true, ...(explicit ? { out: target } : {}) },
                { io, global: options() },
              )
            : exportSession({
                store,
                sessionId: 's1',
                cwd,
                homeDir: home,
                force: true,
                ...(explicit ? { outPath: target } : {}),
              });
        expect(() => write(false)).toThrow('global configuration');
        expect(readFileSync(target, 'utf8')).toBe('preserve-global-output\n');
        expect(lstatSync(output).isSymbolicLink()).toBe(true);
        write(true);
        expect(readFileSync(target, 'utf8')).toContain(
          kind === 'artifact' ? 'id: sample' : 'private transcript',
        );
      });
    },
  );

  it.each(['home', 'global'] as const)(
    'refuses default session export from %s before reading history',
    (location) => {
      withSession((store) => {
        const read = vi.spyOn(store, 'loadFull');
        const directory = location === 'home' ? home : globalDir;
        expect(() =>
          exportSession({ store, sessionId: 's1', cwd: directory, homeDir: home, force: true }),
        ).toThrow('global configuration');
        expect(read).not.toHaveBeenCalled();
        expect(existsSync(join(directory, 's1.relavium.yaml'))).toBe(false);
      });
    },
  );
});
