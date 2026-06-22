import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isCliError } from '../process/errors.js';
import { resolveWorkflowSource } from './resolve.js';

const YAML = 'schema_version: "1.0"\n';

let root: string;
beforeEach(() => {
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
      expect(caught.message).toContain('not a regular file');
      expect(caught.message).not.toContain('not found'); // the EACCES/EISDIR-as-miss bug regression guard
    }
  });

  it('rejects a workflow file over the size cap before reading it', () => {
    const path = join(root, 'huge.relavium.yaml');
    writeFileSync(path, 'a'.repeat(2 * 1024 * 1024 + 1)); // 2 MiB + 1 byte
    let caught: unknown;
    try {
      resolveWorkflowSource(path, { cwd: root, projectConfigDir: undefined });
    } catch (err) {
      caught = err;
    }
    expect(isCliError(caught)).toBe(true);
    if (isCliError(caught)) {
      expect(caught.code).toBe('invalid_invocation');
      expect(caught.message).toContain('size limit');
    }
  });
});
