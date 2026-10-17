import { isAbsolute, join, parse } from 'node:path';
import { describe, expect, it } from 'vitest';

import { extractGlobalOptions, resolveGlobalOptions } from './options.js';

const prefix = ['node-canary', 'entry-canary'];
const argv = (...tokens: string[]): string[] => [...prefix, ...tokens];
const nativeRoot = parse(process.cwd()).root;
const absentAbsoluteRoot = join(nativeRoot, 'relavium-step6-uncreated-root-canary');

describe('EARLY_DEBUG_EXACT_VALUE', () => {
  it.each([undefined, '', '0', 'false', 'TRUE', '01', '1'])(
    'uses only exact RELAVIUM_DEBUG=%s as the absent-flag verbose alias',
    (debug) => {
      expect(resolveGlobalOptions({}, '/work', { RELAVIUM_DEBUG: debug }).verbosity).toBe(
        debug === '1' ? 'verbose' : 'normal',
      );
    },
  );

  it('lets explicit quiet override the debug alias and JSON remain independent', () => {
    expect(
      resolveGlobalOptions({ quiet: true, json: true }, '/work', { RELAVIUM_DEBUG: '1' }),
    ).toMatchObject({ verbosity: 'quiet', json: true });
  });

  it('lets explicit verbose override a non-enabling debug value', () => {
    expect(
      resolveGlobalOptions({ verbose: true }, '/work', { RELAVIUM_DEBUG: '0' }).verbosity,
    ).toBe('verbose');
  });

  it.each([{}, { RELAVIUM_DEBUG: '1' }])('refuses both explicit flags with env %j', (env) => {
    let failure: unknown;
    try {
      resolveGlobalOptions({ verbose: true, quiet: true, json: true }, '/work', env);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'invalid_invocation', exitCode: 2 });
  });
});

describe('EARLY_GLOBAL_POSITION_AND_TERMINATOR', () => {
  // Independent shipping grammar fixture: importing descriptors here would hide missing paths.
  const commandPaths = [
    ['run', 'workflow.yaml'],
    ['chat'],
    ['chat-resume', 'session'],
    ['chat-list'],
    ['chat-export', 'session'],
    ['create'],
    ['export', 'workflow'],
    ['import', 'workflow.yaml'],
    ['agent', 'run', 'agent.yaml'],
    ['gate', 'run-id'],
    ['budget', 'resume', 'run-id'],
    ['gate', 'list'],
    ['list'],
    ['logs', 'run-id'],
    ['status'],
    ['models'],
    ['models', 'refresh'],
    ['models', 'pricing', 'model'],
    ['provider', 'list'],
    ['provider', 'add', 'provider'],
    ['provider', 'set-key', 'provider'],
    ['media', 'prune-temporaries'],
    ['provider', 'remove-key', 'provider'],
    ['provider', 'test', 'provider'],
  ];

  it.each(commandPaths.map((path) => ({ path })))(
    'preserves command path $path with globals before and after it',
    ({ path }) => {
      const result = extractGlobalOptions(argv('--json', ...path, '-q'));
      expect(result.error).toBeUndefined();
      expect(result.raw).toEqual({ json: true, quiet: true });
      expect(result.rest).toEqual(argv(...path));
    },
  );

  it('preserves both node-style prefix tokens even when they resemble global flags', () => {
    expect(extractGlobalOptions(['--json', '-q', 'status'])).toEqual({
      raw: {},
      rest: ['--json', '-q', 'status'],
    });
  });

  it.each(['constructor', 'toString', '__proto__'])(
    'leaves prototype-named unknown command token %s for Commander',
    (token) => {
      const result = extractGlobalOptions(argv('--json', token, '-q'));
      expect(result.error).toBeUndefined();
      expect(result.raw).toEqual({ json: true, quiet: true });
      expect(result.rest).toEqual(argv(token));
    },
  );

  it('retains help/version spellings while extracting lowercase -v', () => {
    const result = extractGlobalOptions(argv('-v', '-V', '-h', '--help', '--version', 'status'));
    expect(result.raw).toEqual({ verbose: true });
    expect(result.rest).toEqual(argv('-V', '-h', '--help', '--version', 'status'));
  });

  it('stops at -- and preserves every later global-looking token verbatim', () => {
    const result = extractGlobalOptions(argv('--json', 'run', '--', '-q', '--cwd', 'x', '--json'));
    expect(result.raw).toEqual({ json: true });
    expect(result.rest).toEqual(argv('run', '--', '-q', '--cwd', 'x', '--json'));
  });

  it('preserves repeated command inputs and their additional equals signs', () => {
    const input = ['run', 'wf', '--input', 'first=a=b', '--input', 'second=', '--input=third=c=d'];
    const result = extractGlobalOptions(argv(...input, '--json'));
    expect(result.error).toBeUndefined();
    expect(result.raw).toEqual({ json: true });
    expect(result.rest).toEqual(argv(...input));
  });

  it('accepts spaced/equal valued globals without normalizing their lexical content', () => {
    const result = extractGlobalOptions(
      argv('--cwd', 'relative/a=b', 'list', '--config=config=c.toml'),
    );
    expect(result.error).toBeUndefined();
    expect(result.raw).toEqual({ cwd: 'relative/a=b', config: 'config=c.toml' });
    expect(result.rest).toEqual(argv('list'));
  });

  it('retains last explicit color/cwd/config occurrence', () => {
    const result = extractGlobalOptions(
      argv('--color', '--cwd=a', '--config=a', '--no-color', '--cwd', 'b', '--config', 'b'),
    );
    expect(result.error).toBeUndefined();
    expect(result.raw).toEqual({ color: false, cwd: 'b', config: 'b' });
  });
});

describe('EARLY_MALFORMED_GLOBAL_HAS_POLICY', () => {
  it.each(['--cwd', '--config', '--allow-fs-root'])(
    'returns a fixed typed refusal for missing/blank/next-flag values of %s',
    (flag) => {
      const cases = [
        [flag],
        [flag, ''],
        [flag, '  '],
        [flag, '--unknown-secret-canary'],
        [`${flag}=`],
        [`${flag}=  `],
      ];
      for (const tokens of cases) {
        const result = extractGlobalOptions(argv('--json', '-q', 'status', ...tokens, '--verbose'));
        expect(result.error).toMatchObject({
          code: 'invalid_invocation',
          exitCode: 2,
          message: `\`${flag}\` requires a non-empty argument.`,
        });
        expect(result.raw).toEqual({ json: true, quiet: true });
        expect(result.rest).toEqual(argv('status'));
        expect(resolveGlobalOptions(result.raw, '/work', { RELAVIUM_DEBUG: '1' })).toMatchObject({
          json: true,
          verbosity: 'quiet',
        });
        expect(result.error?.message).not.toContain('canary');
      }
    },
  );
});

describe('EARLY_FS_SYNTAX_ONLY', () => {
  it('accepts a syntactically native absolute root without filesystem admission', () => {
    expect(isAbsolute(absentAbsoluteRoot)).toBe(true);
    const result = extractGlobalOptions(argv('chat', '--allow-fs-root', absentAbsoluteRoot));
    expect(result.error).toBeUndefined();
    expect(result.raw.allowFsRoots).toEqual([absentAbsoluteRoot]);
    const global = resolveGlobalOptions(result.raw, '/work');
    expect(global.allowFsRoots).toEqual([absentAbsoluteRoot]);
    expect(global.fsGrants).toBeUndefined();
    expect(Object.isFrozen(global.allowFsRoots)).toBe(true);
  });

  it.each([
    'relative-secret-canary',
    './relative-secret-canary',
    '../relative-secret-canary',
    '~secret-canary',
  ])('refuses nonabsolute root syntax without echoing %s', (root) => {
    const result = extractGlobalOptions(argv('--json', '--allow-fs-root', root));
    expect(result.error).toMatchObject({ code: 'invalid_invocation', exitCode: 2 });
    expect(result.error?.message).toBe('Filesystem root grants must use absolute paths.');
    expect(result.raw).toEqual({ json: true });
    expect(result.error?.message).not.toContain(root);
  });

  it('uses the native path syntax rather than accepting a foreign drive by spelling', () => {
    const root = 'C:\\relavium-secret-canary';
    const result = extractGlobalOptions(argv('--allow-fs-root', root));
    if (isAbsolute(root)) {
      expect(result.error).toBeUndefined();
      expect(result.raw.allowFsRoots).toEqual([root]);
    } else {
      expect(result.error).toMatchObject({ code: 'invalid_invocation', exitCode: 2 });
      expect(result.error?.message).toBe('Filesystem root grants must use absolute paths.');
    }
  });

  it('accepts sixteen roots and refuses the seventeenth without losing the first sixteen', () => {
    const roots = Array.from({ length: 17 }, (_, index) => join(nativeRoot, `root-${index}`));
    const tokens = roots.flatMap((root) => ['--allow-fs-root', root]);
    const atLimit = extractGlobalOptions(argv(...tokens.slice(0, 32)));
    expect(atLimit.error).toBeUndefined();
    expect(atLimit.raw.allowFsRoots).toEqual(roots.slice(0, 16));
    const overLimit = extractGlobalOptions(argv(...tokens));
    expect(overLimit.error).toMatchObject({
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'Filesystem root grants exceed the supported bounds.',
    });
    expect(overLimit.raw.allowFsRoots).toEqual(roots.slice(0, 16));
  });

  it('accepts 4096 lexical characters and refuses 4097 without echoing the root', () => {
    const root = nativeRoot + 'a'.repeat(4096 - nativeRoot.length);
    expect(extractGlobalOptions(argv(`--allow-fs-root=${root}`)).error).toBeUndefined();
    expect(extractGlobalOptions(argv(`--allow-fs-root=${root}`)).raw.allowFsRoots).toEqual([root]);
    const result = extractGlobalOptions(argv(`--allow-fs-root=${root}b`));
    expect(result.error).toMatchObject({
      code: 'invalid_invocation',
      exitCode: 2,
      message: 'Filesystem root grants exceed the supported bounds.',
    });
    expect(result.raw.allowFsRoots).toBeUndefined();
  });
});
