import type { ToolHost } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import {
  checkConfig,
  checkKeychain,
  checkTools,
  formatDoctorReport,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorProbes,
} from './doctor.js';

const FS_ARM = { id: 'fs' } as unknown as NonNullable<ToolHost['fs']>;
const PROCESS_ARM = { id: 'process' } as unknown as NonNullable<ToolHost['process']>;

const okProbe = (): void => {};
const throwing = (message: string): (() => void) => () => {
  throw new Error(message);
};

const baseProbes = (overrides: Partial<DoctorProbes> = {}): DoctorProbes => ({
  keychain: okProbe,
  config: okProbe,
  toolHost: { fs: FS_ARM, process: PROCESS_ARM },
  ...overrides,
});

describe('checkKeychain', () => {
  it('reports ok when the probe succeeds', () => {
    expect(checkKeychain(okProbe)).toEqual<DoctorCheck>({
      id: 'keychain',
      label: 'OS keychain',
      status: 'ok',
      detail: 'reachable',
    });
  });

  it('reports fail with the (sanitized) error detail when the probe throws', () => {
    const check = checkKeychain(throwing('backend down'));
    expect(check.status).toBe('fail');
    expect(check.detail).toBe('backend down');
  });

  it('flattens a multi-line error message to a single line', () => {
    const check = checkKeychain(throwing('line one\nline two'));
    expect(check.detail).not.toContain('\n');
  });
});

describe('checkConfig', () => {
  it('reports ok when the config loads', () => {
    expect(checkConfig(okProbe).status).toBe('ok');
  });

  it('reports fail with the error detail on a ConfigError', () => {
    const check = checkConfig(throwing('relavium.toml: invalid value at [chat].model'));
    expect(check.status).toBe('fail');
    expect(check.detail).toContain('[chat].model');
  });
});

describe('checkTools', () => {
  it('lists only the wired arms', () => {
    expect(checkTools({ fs: FS_ARM, process: PROCESS_ARM }).detail).toBe('fs, process');
  });

  it('reports "none" when no arm is wired', () => {
    expect(checkTools({}).detail).toBe('none');
  });

  it('includes the mcp arm when present', () => {
    const host: ToolHost = { fs: FS_ARM, mcp: { id: 'mcp' } as unknown as NonNullable<ToolHost['mcp']> };
    expect(checkTools(host).detail).toBe('fs, mcp');
  });
});

describe('runDoctorChecks', () => {
  it('runs only the fast tier when deep is false', async () => {
    const report = await runDoctorChecks(false, baseProbes());
    expect(report.checks.map((c) => c.id)).toEqual(['keychain', 'config', 'tools']);
  });

  it('skips the deep tier when deep is true but no deep probes are wired', async () => {
    const report = await runDoctorChecks(true, baseProbes());
    expect(report.checks).toHaveLength(3);
  });

  it('appends the deep provider + mcp checks when deep is true', async () => {
    const report = await runDoctorChecks(
      true,
      baseProbes({
        deepProviders: () =>
          Promise.resolve([
            { id: 'provider:anthropic', label: 'anthropic', status: 'ok', detail: 'key works' },
          ]),
        deepMcp: () =>
          Promise.resolve([{ id: 'mcp:fs', label: 'fs', status: 'fail', detail: 'timeout' }]),
      }),
    );
    expect(report.checks.map((c) => c.id)).toEqual([
      'keychain',
      'config',
      'tools',
      'provider:anthropic',
      'mcp:fs',
    ]);
  });
});

describe('formatDoctorReport', () => {
  it('renders an all-passed heading with glyph rows', () => {
    const out = formatDoctorReport({
      checks: [{ id: 'keychain', label: 'OS keychain', status: 'ok', detail: 'reachable' }],
    });
    expect(out).toContain('doctor: all checks passed');
    expect(out).toContain('✓ OS keychain: reachable');
  });

  it('counts failures in the heading and marks them with ✗', () => {
    const out = formatDoctorReport({
      checks: [
        { id: 'keychain', label: 'OS keychain', status: 'ok', detail: 'reachable' },
        { id: 'config', label: 'config', status: 'fail', detail: 'bad' },
      ],
    });
    expect(out).toContain('doctor: 1 check(s) failed');
    expect(out).toContain('✗ config: bad');
  });

  it('uses the warn glyph for warn checks', () => {
    const out = formatDoctorReport({
      checks: [{ id: 'mcp:x', label: 'x', status: 'warn', detail: 'no servers' }],
    });
    expect(out).toContain('⚠ x: no servers');
  });
});
