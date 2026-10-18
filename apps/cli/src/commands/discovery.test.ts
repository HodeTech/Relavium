import { describe, expect, it } from 'vitest';

import { CliError } from '../process/cli-error.js';
import { discoverCommands } from './discovery.js';

function expectFrozenTree(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectFrozenTree(child);
}

describe('pure CLI discovery DTO (unit projection, not production JSON help)', () => {
  it('has the approved envelope, stable authored order, executable containers, groups and unavailable stub', () => {
    const dto = discoverCommands();
    expect(Object.keys(dto).sort()).toEqual([
      'commands',
      'globalOptions',
      'path',
      'type',
      'version',
    ]);
    expect(dto).toMatchObject({ type: 'command_manifest', version: 1, path: [] });
    expect(dto.commands.map((entry) => entry.path.join(' '))).toEqual([
      'run',
      'chat',
      'chat resume',
      'chat list',
      'chat export',
      'create',
      'export',
      'import',
      'agent',
      'agent run',
      'gate',
      'gate list',
      'budget',
      'budget resume',
      'models',
      'models refresh',
      'models pricing',
      'provider',
      'provider list',
      'provider add',
      'provider set-key',
      'provider remove-key',
      'provider test',
      'media',
      'media prune-temporaries',
      'list',
      'logs',
      'status',
      'init',
    ]);
    expect(
      dto.commands
        .filter((entry) => entry.availability === 'not_implemented')
        .map((entry) => entry.path),
    ).toEqual([['init']]);
    expect(dto.commands.filter((entry) => entry.executorId !== undefined)).toHaveLength(24);
    for (const path of ['chat', 'gate', 'models'])
      expect(dto.commands.find((entry) => entry.path.join(' ') === path)?.executorId).toBe(path);
    expect(dto.commands.find((entry) => entry.path.join(' ') === 'agent')).not.toHaveProperty(
      'executorId',
    );
    expectFrozenTree(dto);
    expect(JSON.parse(JSON.stringify(dto))).toEqual(dto);
  });

  it.each([
    [['chat'], ['chat', 'chat resume', 'chat list', 'chat export']],
    [['models'], ['models', 'models refresh', 'models pricing']],
    [
      ['provider'],
      [
        'provider',
        'provider list',
        'provider add',
        'provider set-key',
        'provider remove-key',
        'provider test',
      ],
    ],
    [['agent'], ['agent', 'agent run']],
    [['gate'], ['gate', 'gate list']],
    [['init'], ['init']],
  ])('selects canonical subtree %j including its own root', (path, expected) => {
    const dto = discoverCommands(path);
    expect(dto.path).toEqual(path);
    expect(dto.commands.map((entry) => entry.path.join(' '))).toEqual(expected);
    expect(dto.globalOptions).toEqual(discoverCommands().globalOptions);
  });

  it.each(['resume', 'list', 'export'])(
    'resolves flat chat-%s alias to the exact canonical subtree',
    (verb) => {
      const aliased = discoverCommands([`chat-${verb}`]);
      expect(aliased).toEqual(discoverCommands(['chat', verb]));
      expect(aliased.path).toEqual(['chat', verb]);
      expect(aliased.commands).toHaveLength(1);
      expect(aliased.commands[0]?.executorId).toBe(`chat-${verb}`);
      expect(aliased.commands[0]?.aliases).toEqual([{ path: [`chat-${verb}`], deprecated: true }]);
    },
  );

  it('serializes only public fields and retains exact positional/option grammar', () => {
    const dto = discoverCommands();
    const commandFields = [
      'aliases',
      'allowExcessArguments',
      'availability',
      'description',
      'effect',
      'label',
      'options',
      'path',
      'positionals',
    ];
    for (const command of dto.commands) {
      expect(Object.keys(command).sort()).toEqual(
        [...commandFields, ...(command.executorId === undefined ? [] : ['executorId'])].sort(),
      );
      for (const positional of command.positionals)
        expect(Object.keys(positional).sort()).toEqual([
          'binding',
          'description',
          'name',
          'required',
          'type',
          'variadic',
        ]);
      for (const option of command.options)
        expect(Object.keys(option).sort()).toEqual(
          [
            'arity',
            'binding',
            'conflicts',
            'deprecatedSpellings',
            'description',
            'negated',
            'repetition',
            'required',
            'spellings',
            'type',
            ...(option.placeholder === undefined ? [] : ['placeholder']),
            ...(option.default === undefined ? [] : ['default']),
          ].sort(),
        );
    }
    expect(
      dto.commands.filter((entry) => !entry.allowExcessArguments).map((entry) => entry.path),
    ).toEqual([['run'], ['media', 'prune-temporaries']]);
    const pricing = discoverCommands(['models', 'pricing']).commands[0];
    expect(
      pricing?.options.filter((option) => ['provider', 'input', 'output'].includes(option.binding)),
    ).toMatchObject([
      { binding: 'provider', required: true, arity: 'required', spellings: ['--provider'] },
      {
        binding: 'input',
        required: false,
        spellings: ['--input-price'],
        deprecatedSpellings: ['--input'],
      },
      {
        binding: 'output',
        required: false,
        spellings: ['--output-price'],
        deprecatedSpellings: ['--output'],
      },
    ]);
    expect(discoverCommands(['gate']).commands[0]?.positionals).toMatchObject([
      { name: 'runId', required: false, variadic: false },
    ]);
    expect(discoverCommands(['provider', 'remove-key']).commands[0]?.options).toMatchObject([
      { binding: 'force', spellings: ['--force'] },
    ]);
  });

  it('describes every global spelling, value arity, repetition, conflict and negation without owner state', () => {
    const options = discoverCommands().globalOptions;
    expect(options.flatMap((option) => option.spellings)).toEqual([
      '--json',
      '--color',
      '--no-color',
      '--cwd',
      '--config',
      '--allow-fs-root',
      '--no-alt-screen',
      '--no-mouse',
      '-v',
      '--verbose',
      '-q',
      '--quiet',
      '-h',
      '--help',
      '-V',
      '--version',
    ]);
    expect(
      options
        .filter((option) => option.arity !== 'none')
        .map((option) => [option.binding, option.arity, option.repetition]),
    ).toEqual([
      ['cwd', 'required', 'single'],
      ['config', 'required', 'single'],
      ['allowFsRoots', 'required', 'repeatable'],
    ]);
    expect(options.filter((option) => option.negated).map((option) => option.spellings)).toEqual([
      ['--no-color'],
    ]);
    expect(
      options
        .filter((option) => option.conflicts.length > 0)
        .map((option) => [option.binding, option.conflicts]),
    ).toEqual([
      ['verbose', ['quiet']],
      ['quiet', ['verbose']],
    ]);
    expect(options.every((option) => option.scope === 'position-independent')).toBe(true);
    expect(options.every((option) => !Object.hasOwn(option, 'owner'))).toBe(true);
  });

  it.each([
    ['missing-canary-SECRET'],
    ['chat', 'resume', 'extra'],
    ['chat-resume', 'extra'],
    [''],
    ['Chat'],
  ])('refuses invalid subtree %j with fixed non-echoing text', (...path) => {
    expect(() => discoverCommands(path)).toThrowError(CliError);
    try {
      discoverCommands(path);
    } catch (error) {
      expect(error).toMatchObject({
        code: 'invalid_invocation',
        exitCode: 2,
        message: 'Unknown command help path. Use relavium --help.',
      });
    }
  });
});
