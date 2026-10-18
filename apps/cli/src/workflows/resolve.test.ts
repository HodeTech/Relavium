import { mkdtempSync, mkdirSync, rmSync, writeFileSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { MAX_SOURCE_CHARS, parseWorkflow, parseAgent } from '@relavium/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isCliError } from '../process/errors.js';
import { resolveYamlSource, resolveWorkflowSource } from './resolve.js';

vi.mock('node:fs', async (original) => {
  const native = await original<typeof import('node:fs')>();
  return { ...native, statSync: vi.fn(native.statSync), readFileSync: vi.fn(native.readFileSync) };
});

const YAML = 'schema_version: "1.0"\n';

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'relavium-resolve-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveWorkflowSource', () => {
  it('reads an explicit absolute path', () => {
    const path = join(root, 'flow.relavium.yaml');
    writeFileSync(path, YAML);
    const src = resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
    expect(src).toEqual({ path, yaml: YAML });
  });

  it('reads an explicit relative path against the cwd', () => {
    writeFileSync(join(root, 'flow.yaml'), YAML);
    const src = resolveWorkflowSource('./flow.yaml', { cwd: root, projectConfigDir: undefined });
    expect(src.path).toBe(join(root, 'flow.yaml'));
    expect(src.yaml).toBe(YAML);
  });

  it('resolves a bare id under <projectConfigDir>/workflows/<id>.relavium.yaml', () => {
    const dir = join(root, '.relavium', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.relavium.yaml'), YAML);
    const src = resolveWorkflowSource('greet', {
      cwd: root,
      projectConfigDir: join(root, '.relavium'),
    });
    expect(src.path).toBe(join(dir, 'greet.relavium.yaml'));
  });

  it('falls back to the bare <id>.yaml form', () => {
    const dir = join(root, '.relavium', 'workflows');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'greet.yaml'), YAML);
    const src = resolveWorkflowSource('greet', {
      cwd: root,
      projectConfigDir: join(root, '.relavium'),
    });
    expect(src.path).toBe(join(dir, 'greet.yaml'));
  });

  it('throws a clean exit-2 miss listing the candidate paths', () => {
    let caught: unknown;
    try {
      resolveWorkflowSource('absent', { cwd: root, projectConfigDir: join(root, '.relavium') });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('absent.relavium.yaml');
    }
  });

  it('reports no project when a bare id is given without a project config dir', () => {
    let caught: unknown;
    try {
      resolveWorkflowSource('absent', { cwd: root, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) expect(caught.message).toContain('no project');
  });

  it('rejects an existing path that is not a regular file (a directory) rather than reporting "not found"', () => {
    const dir = join(root, 'flow.relavium.yaml');
    mkdirSync(dir); // a directory where a workflow file was named
    let caught: unknown;
    try {
      resolveWorkflowSource(dir, { cwd: root, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('workflow'); // the `kind` is substituted into the diagnostic
      expect(caught.message).toContain('not a regular file');
      expect(caught.message).not.toContain('not found'); // the EACCES/EISDIR-as-miss bug regression guard
    }
  });

  it('rejects a workflow file over the size cap before reading it', () => {
    const path = join(root, 'huge.relavium.yaml');
    writeFileSync(path, 'a'.repeat(MAX_SOURCE_CHARS * 4 + 1)); // above the actual byte ceiling
    let caught: unknown;
    try {
      resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('workflow'); // the `kind` is substituted into the diagnostic
      expect(caught.message).toContain('size limit');
    }
  });
  it.each(['workflow', 'agent'] as const)(
    'accepts dense UTF-8 %s source above the old byte ceiling, then parses it',
    (kind) => {
      const header =
        kind === 'workflow'
          ? 'schema_version: "1.0"\nworkflow:\n  id: dense\n  nodes: [{id: a, type: input}, {id: b, type: output}]\n  edges: [{from: a, to: b}]\n'
          : 'id: dense\nmodel: gpt-4o\nprovider: openai\nsystem_prompt: hello\n';
      const yaml = `${header}#${'文'.repeat(Math.floor(MAX_SOURCE_CHARS / 2))}\n`;
      expect(yaml.length).toBeLessThan(MAX_SOURCE_CHARS);
      expect(Buffer.byteLength(yaml)).toBeGreaterThan(MAX_SOURCE_CHARS);
      const path = join(root, `${kind}.yaml`);
      writeFileSync(path, yaml);
      const source = resolveYamlSource(path, {
        cwd: root,
        kind,
        subdir: kind,
        projectConfigDir: undefined,
        idSuffixes: ['.yaml'],
      });
      expect(
        kind === 'workflow' ? parseWorkflow(source.yaml).workflow.id : parseAgent(source.yaml).id,
      ).toBe('dense');
    },
  );

  it('leaves the authoritative ASCII character overflow to the parser', () => {
    const path = join(root, 'long.yaml');
    writeFileSync(path, `#${'a'.repeat(MAX_SOURCE_CHARS)}`);
    const source = resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
    expect(() => parseWorkflow(source.yaml)).toThrow(/limit/i);
  });

  it('refuses true byte overflow before any file read', () => {
    const path = join(root, 'huge.yaml');
    writeFileSync(path, 'a'.repeat(MAX_SOURCE_CHARS * 4 + 1));
    expect(() => resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined })).toThrow(
      /size limit/,
    );
    expect(readFileSync).not.toHaveBeenCalled();
  });

  it.each(['stat', 'read'] as const)(
    'keeps a native %s fault as cause without disclosing its absolute path',
    (stage) => {
      const path = join(root, 'fault.yaml');
      writeFileSync(path, YAML);
      const cause = Object.assign(new Error(`private native path: ${path}`), { code: 'EACCES' });
      if (stage === 'stat')
        vi.mocked(statSync).mockImplementationOnce(() => {
          throw cause;
        });
      else
        vi.mocked(readFileSync).mockImplementationOnce(() => {
          throw cause;
        });
      try {
        resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
        expect.fail('native fault must refuse');
      } catch (error) {
        expect(isCliError(error)).toBe(true);
        if (!isCliError(error)) throw error;
        expect(error.cause).toBe(cause);
        expect(error.message).toContain('fault.yaml');
        expect(error.message).not.toContain(root);
        expect(error.message).not.toContain('private native');
      }
    },
  );

  it('labels both the absolute argument and searched candidates in a miss', () => {
    const path = join(root, 'missing.yaml');
    try {
      resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
      expect.fail('missing source must refuse');
    } catch (error) {
      expect(isCliError(error)).toBe(true);
      if (!isCliError(error)) throw error;
      expect(error.message).toContain('missing.yaml');
      expect(error.message).not.toContain(root);
    }
  });
});
