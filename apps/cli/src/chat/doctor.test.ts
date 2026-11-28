import type { ToolHost } from '@relavium/core';
import { describe, expect, it } from 'vitest';

import { assembleToolEnv } from '../engine/tool-host/assemble.js';
import {
  checkConfig,
  checkKeychain,
  checkTools,
  formatDoctorReport,
  runDoctorChecks,
  type DoctorCheck,
  type DoctorProbes,
} from './doctor.js';

// A REAL host with the `fs` + `process` arms wired (NO cast) — assembleToolEnv is pure construction (no I/O).
const REAL_HOST: ToolHost = assembleToolEnv({
  profile: 'chat-read-only',
  fsScopeTier: 'sandboxed',
  workspaceDir: '/tmp/doctor-test',
}).host;

const okProbe = (): void => {};
const throwing =
  (message: string): (() => void) =>
  () => {
    throw new Error(message);
  };

const baseProbes = (overrides: Partial<DoctorProbes> = {}): DoctorProbes => ({
  keychain: okProbe,
  config: okProbe,
  toolHost: REAL_HOST,
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
    expect(checkTools(REAL_HOST).detail).toBe('fs, process');
  });

  it('reports "none" when no arm is wired', () => {
    expect(checkTools({}).detail).toBe('none');
  });

  it('includes the mcp arm when present', () => {
    // Presence-only: checkTools reads `arm !== undefined`, never a method — so a documented stub stands in for the
    // McpCapability (the one arm without a pure factory like assembleToolEnv; a real McpClient is heavy to build).
    const mcpArm = { id: 'mcp' } as unknown as NonNullable<ToolHost['mcp']>;
    expect(checkTools({ ...REAL_HOST, mcp: mcpArm }).detail).toBe('fs, process, mcp');
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
    expect(out).toContain('✓ ok · OS keychain: reachable');
  });

  it('writes the plain glyph forms when colour is off, with the check’s word beside each', () => {
    const out = formatDoctorReport(
      {
        checks: [
          { id: 'keychain', label: 'OS keychain', status: 'ok', detail: 'reachable' },
          { id: 'provider', label: 'providers', status: 'warn', detail: 'no keys configured' },
          { id: 'config', label: 'config', status: 'fail', detail: 'bad' },
        ],
      },
      true,
    );
    expect(out).toContain('x doctor: 1 check(s) failed');
    expect(out).toContain('  ok · OS keychain: reachable');
    expect(out).toContain('! warning · providers: no keys configured');
    expect(out).toContain('x failed · config: bad');
    expect(out).not.toMatch(/[✓✗⚠]/u);
  });

  it('never says a word twice: the plain `ok` is its own word, and every status says its word once in both modes', () => {
    const rows = (status: 'ok' | 'warn' | 'fail', ascii: boolean): string =>
      formatDoctorReport(
        { checks: [{ id: 'a', label: 'label', status, detail: 'detail' }] },
        ascii,
      ).split('\n')[1] ?? '';
    expect(rows('ok', true)).toBe('  ok · label: detail');
    expect(rows('warn', true)).toBe('  ! warning · label: detail');
    expect(rows('fail', true)).toBe('  x failed · label: detail');
    expect(rows('ok', false)).toBe('  ✓ ok · label: detail');
    expect(rows('warn', false)).toBe('  ⚠ warning · label: detail');
    expect(rows('fail', false)).toBe('  ✗ failed · label: detail');
    for (const status of ['ok', 'warn', 'fail'] as const) {
      for (const ascii of [true, false]) {
        expect(rows(status, ascii), `${status} ${String(ascii)}`).not.toMatch(
          /\b(ok|warning|failed)\b.*\b\1\b.*·/u,
        );
      }
    }
  });

  it('the heading does not repeat a plain `ok` in front of a sentence that already says it', () => {
    const heading = (checks: Parameters<typeof formatDoctorReport>[0]['checks'], ascii: boolean) =>
      formatDoctorReport({ checks }, ascii).split('\n')[0];
    const pass = [{ id: 'a', label: 'a', status: 'ok' as const, detail: 'd' }];
    const warn = [{ id: 'a', label: 'a', status: 'warn' as const, detail: 'd' }];
    const fail = [{ id: 'a', label: 'a', status: 'fail' as const, detail: 'd' }];
    expect(heading(pass, true)).toBe('doctor: all checks passed');
    expect(heading(pass, false)).toBe('✓ doctor: all checks passed');
    expect(heading(warn, true)).toBe('! doctor: 1 warning(s)');
    expect(heading(warn, false)).toBe('⚠ doctor: 1 warning(s)');
    expect(heading(fail, true)).toBe('x doctor: 1 check(s) failed');
    expect(heading(fail, false)).toBe('✗ doctor: 1 check(s) failed');
  });

  it('counts failures in the heading and marks them with ✗', () => {
    const out = formatDoctorReport({
      checks: [
        { id: 'keychain', label: 'OS keychain', status: 'ok', detail: 'reachable' },
        { id: 'config', label: 'config', status: 'fail', detail: 'bad' },
      ],
    });
    expect(out).toContain('doctor: 1 check(s) failed');
    expect(out).toContain('✗ failed · config: bad');
  });

  it('uses the warn glyph and reports warnings in the heading when there are no failures', () => {
    const out = formatDoctorReport({
      checks: [
        { id: 'provider', label: 'providers', status: 'warn', detail: 'no keys configured' },
        { id: 'mcp', label: 'MCP servers', status: 'warn', detail: 'none configured' },
      ],
    });
    // A warn-only report must NOT read "all checks passed" — the heading surfaces the warning count.
    expect(out).toContain('doctor: 2 warning(s)');
    expect(out).not.toContain('all checks passed');
    expect(out).toContain('⚠ warning · providers: no keys configured');
  });

  it('a failure outranks warnings in the heading', () => {
    const out = formatDoctorReport({
      checks: [
        { id: 'a', label: 'a', status: 'warn', detail: 'w' },
        { id: 'b', label: 'b', status: 'fail', detail: 'f' },
      ],
    });
    expect(out).toContain('doctor: 1 check(s) failed');
  });
});
