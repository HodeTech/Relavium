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

  it('treats --no-color as color off and --color as color on', () => {
    expect(extractGlobalOptions(argv('--no-color')).raw.color).toBe(false);
    expect(extractGlobalOptions(argv('--color')).raw.color).toBe(true);
    // Both present ⇒ last flag wins (idempotent boolean flags, applied in argv order).
    expect(extractGlobalOptions(argv('--no-color', '--color')).raw.color).toBe(true);
    expect(extractGlobalOptions(argv('--color', '--no-color')).raw.color).toBe(false);
  });

  it('extracts --no-alt-screen (position-independent) and leaves command tokens intact', () => {
    expect(extractGlobalOptions(argv('--no-alt-screen', 'chat')).raw.noAltScreen).toBe(true);
    const { raw, rest } = extractGlobalOptions(argv('chat', '--no-alt-screen'));
    expect(raw.noAltScreen).toBe(true);
    expect(rest).toEqual(['node', 'relavium', 'chat']);
    expect(extractGlobalOptions(argv('chat')).raw.noAltScreen).toBeUndefined(); // absent ⇒ unset
    expect(extractGlobalOptions(argv('--no-mouse', 'chat')).raw.noMouse).toBe(true);
    expect(extractGlobalOptions(argv('chat')).raw.noMouse).toBeUndefined(); // absent ⇒ unset
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
  it('applies defaults (normal verbosity, color on, json off, fallback cwd, alt-screen not disabled)', () => {
    expect(resolveGlobalOptions({}, '/work')).toEqual({
      json: false,
      color: true,
      cwd: '/work',
      configPath: undefined,
      verbosity: 'normal',
      noAltScreen: false,
      noMouse: false,
    });
  });

  it('honors the raw flags', () => {
    expect(
      resolveGlobalOptions({ json: true, color: false, cwd: '/x', config: '/c.toml' }, '/work'),
    ).toEqual({
      json: true,
      color: false,
      cwd: '/x',
      configPath: '/c.toml',
      verbosity: 'normal',
      noAltScreen: false,
      noMouse: false,
    });
  });

  it('maps --no-alt-screen to noAltScreen (absent ⇒ false)', () => {
    expect(resolveGlobalOptions({ noAltScreen: true }, '/w').noAltScreen).toBe(true);
    expect(resolveGlobalOptions({}, '/w').noAltScreen).toBe(false);
  });

  it('maps --no-mouse to noMouse (absent ⇒ false) — the ADR-0068 §e mouse opt-out, Step 5e', () => {
    expect(resolveGlobalOptions({ noMouse: true }, '/w').noMouse).toBe(true);
    expect(resolveGlobalOptions({}, '/w').noMouse).toBe(false);
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

  describe('color precedence (2.5.J): flag > NO_COLOR > FORCE_COLOR > on', () => {
    const color = (
      raw: Parameters<typeof resolveGlobalOptions>[0],
      env: Record<string, string | undefined> = {},
    ): boolean => resolveGlobalOptions(raw, '/w', env).color;

    it('defaults ON with no flag and no env', () => {
      expect(color({})).toBe(true);
    });

    it('an explicit flag wins over any env (both directions)', () => {
      expect(color({ color: false }, { FORCE_COLOR: '1' })).toBe(false); // --no-color beats FORCE_COLOR
      expect(color({ color: true }, { NO_COLOR: '1' })).toBe(true); // --color beats NO_COLOR
    });

    it('NO_COLOR turns color OFF for ANY non-empty value (no-color.org)', () => {
      expect(color({}, { NO_COLOR: '1' })).toBe(false);
      expect(color({}, { NO_COLOR: 'anything' })).toBe(false);
      expect(color({}, { NO_COLOR: '0' })).toBe(false); // even '0' is non-empty ⇒ off
      expect(color({}, { NO_COLOR: '' })).toBe(true); // empty ⇒ not set ⇒ falls through
    });

    it('NO_COLOR turns off even alongside FORCE_COLOR=1 (a truthy FORCE_COLOR never force-ONs over NO_COLOR)', () => {
      expect(color({}, { NO_COLOR: '1', FORCE_COLOR: '1' })).toBe(false);
    });

    it('FORCE_COLOR=0/false turns color OFF (the supports-color convention); other values keep the default on', () => {
      // 0/false is the one FORCE_COLOR value with an observable effect — it opts out (distinct from default-on).
      expect(color({}, { FORCE_COLOR: '0' })).toBe(false);
      expect(color({}, { FORCE_COLOR: 'false' })).toBe(false);
      // A truthy or empty value is consistent with the default-on (color already defaults on).
      expect(color({}, { FORCE_COLOR: '1' })).toBe(true);
      expect(color({}, { FORCE_COLOR: 'true' })).toBe(true);
      expect(color({}, { FORCE_COLOR: '' })).toBe(true);
    });

    it('an explicit flag beats FORCE_COLOR=0 (the per-invocation override wins over env opt-out)', () => {
      expect(color({ color: true }, { FORCE_COLOR: '0' })).toBe(true);
    });
  });
});

describe('assertNoGlobalOptionConflicts', () => {
  it('throws on verbose + quiet, passes otherwise', () => {
    expect(() => assertNoGlobalOptionConflicts({ verbose: true, quiet: true })).toThrow();
    expect(() => assertNoGlobalOptionConflicts({ verbose: true })).not.toThrow();
  });
});
