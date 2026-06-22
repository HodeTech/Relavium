import { describe, expect, it } from 'vitest';

import {
  assertNoGlobalOptionConflicts,
  extractGlobalOptions,
  resolveGlobalOptions,
} from './options.js';

const argv = (...tokens: string[]): string[] => ['node', 'relavium', ...tokens];

describe('extractGlobalOptions', () => {
  it('extracts globals from after the subcommand and leaves command tokens intact', () => {
    const { raw, rest } = extractGlobalOptions(argv('run', 'wf', '--input', 'a=1', '--json', '-v'));
    expect(raw.json).toBe(true);
    expect(raw.verbose).toBe(true);
    expect(rest).toEqual(['node', 'relavium', 'run', 'wf', '--input', 'a=1']);
  });

  it('extracts globals from before the subcommand', () => {
    const { raw, rest } = extractGlobalOptions(argv('--json', 'list'));
    expect(raw.json).toBe(true);
    expect(rest).toEqual(['node', 'relavium', 'list']);
  });

  it('reads --cwd / --config values (spaced and =forms)', () => {
    expect(
      extractGlobalOptions(argv('--cwd', '/x', '--config', '/c.toml', 'list')).raw,
    ).toMatchObject({ cwd: '/x', config: '/c.toml' });
    expect(extractGlobalOptions(argv('--cwd=/y', 'list')).raw.cwd).toBe('/y');
  });

  it('treats --no-color as color off', () => {
    expect(extractGlobalOptions(argv('--no-color')).raw.color).toBe(false);
  });

  it('reports (not throws) invalid_invocation when --cwd / --config has no argument', () => {
    const missingCwd = extractGlobalOptions(argv('--cwd'));
    expect(missingCwd.error?.code).toBe('invalid_invocation');
    expect(missingCwd.error?.message).toContain('requires a non-empty argument');
    expect(extractGlobalOptions(argv('--config', '--json')).error?.code).toBe('invalid_invocation');
  });

  it('reports invalid_invocation for an empty =-form value', () => {
    expect(extractGlobalOptions(argv('--cwd=')).error?.code).toBe('invalid_invocation');
    expect(extractGlobalOptions(argv('--config=')).error?.code).toBe('invalid_invocation');
  });

  it('keeps globals parsed before a failing flag (so --json is honored on the error)', () => {
    const { raw, error } = extractGlobalOptions(argv('--json', '--cwd'));
    expect(raw.json).toBe(true);
    expect(error?.code).toBe('invalid_invocation');
  });

  it('honors -- as end-of-options: stops extracting and passes the rest verbatim', () => {
    const { raw, rest } = extractGlobalOptions(argv('run', '--', '--json'));
    expect(raw.json).toBeUndefined();
    expect(rest).toEqual(['node', 'relavium', 'run', '--', '--json']);
  });

  it('keeps globals before -- but not after it', () => {
    const { raw, rest } = extractGlobalOptions(argv('--json', 'run', '--', '--cwd', 'x'));
    expect(raw.json).toBe(true);
    expect(raw.cwd).toBeUndefined();
    expect(rest).toEqual(['node', 'relavium', 'run', '--', '--cwd', 'x']);
  });
});

describe('resolveGlobalOptions', () => {
  it('applies defaults (normal verbosity, color on, json off, fallback cwd)', () => {
    expect(resolveGlobalOptions({}, '/work')).toEqual({
      json: false,
      color: true,
      cwd: '/work',
      configPath: undefined,
      verbosity: 'normal',
    });
  });

  it('honors the raw flags', () => {
    expect(
      resolveGlobalOptions({ json: true, color: false, cwd: '/x', config: '/c.toml' }, '/work'),
    ).toEqual({ json: true, color: false, cwd: '/x', configPath: '/c.toml', verbosity: 'normal' });
  });

  it('maps --verbose / --quiet to verbosity', () => {
    expect(resolveGlobalOptions({ verbose: true }, '/w').verbosity).toBe('verbose');
    expect(resolveGlobalOptions({ quiet: true }, '/w').verbosity).toBe('quiet');
  });

  it('rejects --verbose combined with --quiet', () => {
    expect(() => resolveGlobalOptions({ verbose: true, quiet: true }, '/w')).toThrowError(
      'cannot be combined',
    );
  });
});

describe('assertNoGlobalOptionConflicts', () => {
  it('throws on verbose + quiet, passes otherwise', () => {
    expect(() => assertNoGlobalOptionConflicts({ verbose: true, quiet: true })).toThrow();
    expect(() => assertNoGlobalOptionConflicts({ verbose: true })).not.toThrow();
  });
});
