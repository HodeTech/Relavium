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

  it('throws invalid_invocation when --cwd has no argument', () => {
    expect(() => extractGlobalOptions(argv('--cwd'))).toThrowError(/requires an argument/);
    expect(() => extractGlobalOptions(argv('--config', '--json'))).toThrowError(
      /requires an argument/,
    );
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
      /cannot be combined/,
    );
  });
});

describe('assertNoGlobalOptionConflicts', () => {
  it('throws on verbose + quiet, passes otherwise', () => {
    expect(() => assertNoGlobalOptionConflicts({ verbose: true, quiet: true })).toThrow();
    expect(() => assertNoGlobalOptionConflicts({ verbose: true })).not.toThrow();
  });
});
