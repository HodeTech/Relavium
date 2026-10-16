import { Readable } from 'node:stream';
import type { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../program.js';
import type { ExitCode } from '../process/exit-codes.js';
import type { CliIo } from '../process/io.js';
import type { CommandInput } from './dispatch.js';

function capture(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      writeOut: (text) => {
        out.push(text);
      },
      writeErr: (text) => {
        err.push(text);
      },
      writeErrAcknowledged: (text) => {
        err.push(text);
        return Promise.resolve();
      },
      env: {},
      stdoutIsTty: false,
      stdinIsTty: false,
      stdin: Readable.from([]),
    },
  };
}

type Options = Readonly<Record<string, string | boolean | readonly string[]>>;
interface Case {
  readonly id: string;
  readonly argv: readonly string[];
  readonly positionals: readonly string[];
  readonly options: Options;
}

/** Independent argv/payload examples, not generated from the registry under test. */
const cases: readonly Case[] = [
  {
    id: 'run',
    argv: [
      'run',
      'wf',
      '--input',
      'n=-1',
      'text=a=b',
      '--input',
      'third=c',
      '--secret-inputs-stdin',
      '--allow-mcp-stdio',
      'd1',
      'd2',
      '--allow-mcp-stdio',
      'd3',
    ],
    positionals: ['wf'],
    options: {
      input: ['n=-1', 'text=a=b', 'third=c'],
      secretInputsStdin: true,
      allowMcpStdio: ['d1', 'd2', 'd3'],
    },
  },
  {
    id: 'chat',
    argv: ['chat', '--agent', 'helper'],
    positionals: [],
    options: { agent: 'helper' },
  },
  { id: 'chat-resume', argv: ['chat-resume', 's1'], positionals: ['s1'], options: {} },
  { id: 'chat-list', argv: ['chat-list'], positionals: [], options: {} },
  {
    id: 'chat-export',
    argv: ['chat-export', 's1', '--out', 'export.yaml', '--force'],
    positionals: ['s1'],
    options: { out: 'export.yaml', force: true },
  },
  { id: 'create', argv: ['create', '--force'], positionals: [], options: { force: true } },
  {
    id: 'export',
    argv: ['export', 'wf', '--out', 'copy.yaml', '--force'],
    positionals: ['wf'],
    options: { out: 'copy.yaml', force: true },
  },
  {
    id: 'import',
    argv: ['import', 'source.yaml', '--force'],
    positionals: ['source.yaml'],
    options: { force: true },
  },
  {
    id: 'agent.run',
    argv: [
      'agent',
      'run',
      'helper',
      '--input',
      'x=1',
      'y=a=b',
      '--fixture',
      'cassette.json',
      '--allow-mcp-stdio',
      'd1',
      'd2',
    ],
    positionals: ['helper'],
    options: { input: ['x=1', 'y=a=b'], fixture: 'cassette.json', allowMcpStdio: ['d1', 'd2'] },
  },
  {
    id: 'gate',
    argv: [
      'gate',
      'r1',
      '--approve',
      '--reject',
      '--comment',
      'reviewed',
      '--input',
      'payload',
      '--gate',
      'g1',
      '--secret-stdin',
      '--allow-mcp-stdio',
      'd1',
      'd2',
    ],
    positionals: ['r1'],
    options: {
      approve: true,
      reject: true,
      comment: 'reviewed',
      input: 'payload',
      gate: 'g1',
      secretStdin: true,
      allowMcpStdio: ['d1', 'd2'],
    },
  },
  {
    id: 'budget.resume',
    argv: [
      'budget',
      'resume',
      'r1',
      '--approve-amount',
      '0',
      '--abort',
      '--gate',
      'b1',
      '--secret-stdin',
      '--allow-mcp-stdio',
      'd1',
      'd2',
    ],
    positionals: ['r1'],
    options: {
      approveAmount: '0',
      abort: true,
      gate: 'b1',
      secretStdin: true,
      allowMcpStdio: ['d1', 'd2'],
    },
  },
  { id: 'gate.list', argv: ['gate', 'list', 'r1'], positionals: ['r1'], options: {} },
  { id: 'list', argv: ['list', '--agents'], positionals: [], options: { agents: true } },
  { id: 'logs', argv: ['logs', 'r1'], positionals: ['r1'], options: {} },
  { id: 'status', argv: ['status'], positionals: [], options: {} },
  { id: 'models', argv: ['models'], positionals: [], options: {} },
  {
    id: 'models.refresh',
    argv: ['models', 'refresh', '--providers', '--catalog'],
    positionals: [],
    options: { providers: true, catalog: true },
  },
  {
    id: 'models.pricing',
    argv: [
      'models',
      'pricing',
      'm1',
      '--provider',
      'openai',
      '--input',
      '1.25',
      '--output',
      '2.5',
      '--cached',
      '0.25',
      '--image',
      '0.1',
      '--audio',
      '0.2',
      '--video',
      '0.3',
      '--clear',
    ],
    positionals: ['m1'],
    options: {
      provider: 'openai',
      input: '1.25',
      output: '2.5',
      cached: '0.25',
      image: '0.1',
      audio: '0.2',
      video: '0.3',
      clear: true,
    },
  },
  {
    id: 'provider.list',
    argv: ['provider', 'list', '--verify'],
    positionals: [],
    options: { verify: true },
  },
  {
    id: 'provider.add',
    argv: [
      'provider',
      'add',
      'openai',
      '--base-url',
      'https://proxy.example/v1',
      '--pricing-url',
      'https://prices.example/',
    ],
    positionals: ['openai'],
    options: { baseUrl: 'https://proxy.example/v1', pricingUrl: 'https://prices.example/' },
  },
  {
    id: 'provider.set-key',
    argv: ['provider', 'set-key', 'openai'],
    positionals: ['openai'],
    options: {},
  },
  {
    id: 'media.prune-temporaries',
    argv: ['media', 'prune-temporaries', '--legacy-offline', '--force'],
    positionals: [],
    options: { legacyOffline: true, force: true },
  },
  {
    id: 'provider.remove-key',
    argv: ['provider', 'remove-key', 'openai'],
    positionals: ['openai'],
    options: {},
  },
  {
    id: 'provider.test',
    argv: ['provider', 'test', 'openai', '--model', 'cheap'],
    positionals: ['openai'],
    options: { model: 'cheap' },
  },
];

function walk(command: Command, parent = ''): { path: string; command: Command }[] {
  return command.commands.flatMap((child) => {
    const path = parent === '' ? child.name() : `${parent}.${child.name()}`;
    return [{ path, command: child }, ...walk(child, path)];
  });
}

describe('descriptor-derived real Commander actions (compatibility grammar only)', () => {
  it.each(cases)(
    '$id parses and forwards every present binding and awaits its exit',
    async (testCase) => {
      const { io } = capture();
      const result: { exitCode?: ExitCode } = {};
      const global = {
        json: false,
        color: false,
        cwd: '/test',
        configPath: undefined,
        verbosity: 'normal' as const,
      };
      const execute = vi.fn<(id: string, input: CommandInput, ctx: unknown) => Promise<ExitCode>>(
        () => Promise.resolve(3),
      );
      const context = { io, global, result };
      const program = buildProgram(io, { context, execute });
      await program.parseAsync(['node', 'relavium', ...testCase.argv]);
      expect(execute).toHaveBeenCalledTimes(1);
      const call = execute.mock.calls[0];
      if (call === undefined) throw new Error('missing action callback');
      expect(call[0]).toBe(testCase.id);
      expect(call[1].positionals).toEqual(testCase.positionals);
      expect(
        Object.fromEntries(
          Object.entries(call[1].options).filter(([, value]) => value !== undefined),
        ),
      ).toEqual(testCase.options);
      expect(call[2]).toBe(context);
      expect(result.exitCode).toBe(3);
    },
  );

  it('retains all actual command paths and mandatory/variadic grammar independently of model schema', () => {
    const nodes = walk(buildProgram(capture().io));
    expect(nodes.map((node) => node.path).sort()).toEqual(
      [
        ...cases.map((testCase) => testCase.id),
        'agent',
        'budget',
        'provider',
        'media',
        'init',
      ].sort(),
    );
    for (const testCase of cases) {
      const command = nodes.find((node) => node.path === testCase.id)?.command;
      if (command === undefined) throw new Error(`missing command ${testCase.id}`);
      expect(command.options.map((option) => option.long).sort()).toEqual(
        [...new Set(testCase.argv.filter((token) => token.startsWith('--')))].sort(),
      );
      expect(
        command.options.map((option) => [option.attributeName(), option.required]).sort(),
      ).toEqual(
        Object.entries(testCase.options)
          .map(([key, value]) => [key, typeof value !== 'boolean'])
          .sort(),
      );
      expect(
        command.registeredArguments.map((arg) => [arg.name(), arg.required, arg.variadic]),
      ).toEqual(
        testCase.positionals.map((_value, index) => {
          const names: Readonly<Record<string, string>> = {
            run: 'workflow',
            'chat-resume': 'sessionId',
            'chat-export': 'sessionId',
            export: 'id',
            import: 'path',
            'agent.run': 'agent',
            gate: 'runId',
            'gate.list': 'runId',
            'budget.resume': 'runId',
            logs: 'runId',
            'models.pricing': 'model',
            'provider.add': 'name',
            'provider.set-key': 'name',
            'provider.remove-key': 'name',
            'provider.test': 'name',
          };
          expect(index).toBe(0);
          return [names[testCase.id], !['gate', 'gate.list'].includes(testCase.id), false];
        }),
      );
    }
    const options = nodes.flatMap(({ path, command }) =>
      command.options.map((option) => ({
        path,
        binding: option.attributeName(),
        required: option.required,
        optional: option.optional,
        mandatory: option.mandatory,
        variadic: option.variadic,
        negate: option.negate,
        hasDefault: option.defaultValue !== undefined,
      })),
    );
    expect(
      options.filter((option) => option.mandatory).map((option) => [option.path, option.binding]),
    ).toEqual([['models.pricing', 'provider']]);
    expect(
      options.filter((option) => option.variadic).map((option) => [option.path, option.binding]),
    ).toEqual([
      ['run', 'input'],
      ['run', 'allowMcpStdio'],
      ['agent.run', 'input'],
      ['agent.run', 'allowMcpStdio'],
      ['gate', 'allowMcpStdio'],
      ['budget.resume', 'allowMcpStdio'],
    ]);
    expect(
      options.filter((option) => option.optional || option.negate || option.hasDefault),
    ).toEqual([]);
    expect(
      nodes
        .find((node) => node.path === 'gate')
        ?.command.registeredArguments.map((arg) => [arg.name(), arg.required, arg.variadic]),
    ).toEqual([['runId', false, false]]);
    expect(
      nodes
        .find((node) => node.path === 'gate.list')
        ?.command.registeredArguments.map((arg) => [arg.name(), arg.required, arg.variadic]),
    ).toEqual([['runId', false, false]]);
  });

  it.each(
    [
      ['models', 'pricing', 'm1', '--input', '1'],
      ['run'],
      ['logs'],
      ['agent', 'run'],
      ['budget', 'resume'],
      ['run', 'wf', 'extra'],
      ['media', 'prune-temporaries', 'extra'],
    ].map((argv) => ({ argv })),
  )(
    'refuses missing required grammar/excess arguments before dispatch: $argv',
    async ({ argv }) => {
      const execute = vi.fn(() => Promise.resolve(0 as const));
      const { io } = capture();
      const program = buildProgram(io, {
        context: {
          io,
          global: {
            json: false,
            color: false,
            cwd: '/test',
            configPath: undefined,
            verbosity: 'normal',
          },
          result: {},
        },
        execute,
      });
      await expect(program.parseAsync(['node', 'relavium', ...argv])).rejects.toBeDefined();
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('keeps the init stub as an explicit unavailable action', async () => {
    const execute = vi.fn(() => Promise.resolve(0 as const));
    await expect(
      buildProgram(capture().io, { execute }).parseAsync(['node', 'relavium', 'init']),
    ).rejects.toMatchObject({ code: 'not_implemented', exitCode: 2 });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each(
    [
      ['gate', '--approve'],
      ['gate', 'list'],
    ].map((argv) => ({ argv })),
  )('omits absent optional runId bindings: $argv', async ({ argv }) => {
    const execute = vi.fn<(id: string, input: CommandInput, ctx: unknown) => Promise<ExitCode>>(
      () => Promise.resolve(0),
    );
    const { io } = capture();
    await buildProgram(io, {
      context: {
        io,
        global: {
          json: false,
          color: false,
          cwd: '/test',
          configPath: undefined,
          verbosity: 'normal',
        },
        result: {},
      },
      execute,
    }).parseAsync(['node', 'relavium', ...argv]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1].positionals).toEqual([]);
    expect(execute.mock.calls[0]?.[0]).toBe(argv[1] === 'list' ? 'gate.list' : 'gate');
  });

  it('refuses a missing executor wiring with fixed infrastructure classification', async () => {
    const { io } = capture();
    const program = buildProgram(io, {
      context: {
        io,
        global: {
          json: false,
          color: false,
          cwd: '/test',
          configPath: undefined,
          verbosity: 'normal',
        },
        result: {},
      },
    });
    await expect(program.parseAsync(['node', 'relavium', 'status'])).rejects.toMatchObject({
      code: 'cli_internal',
      exitCode: 9,
    });
  });
});
