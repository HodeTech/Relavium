import { describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../program.js';
import { captureIo } from '../test-support.js';

/**
 * Commander action → `executeCommand` FORWARDING guard (2.5.G S10 regression). The manifest drift guard
 * ([manifest.test.ts](manifest.test.ts)) pins each command's option *names/descriptions*, but NOT that the
 * commander `.action()` actually *forwards* the parsed opt into the `CommandInput` it dispatches. A dropped opt
 * (the S10 `provider add --pricing-url` bug: the flag parsed but the action forwarded only `{ baseUrl }`) is
 * therefore invisible to it. Here we mock the dispatch table and assert the exact `CommandInput` each action hands
 * off, so a future "added an option to specs.ts but forgot to widen its action" fails loudly.
 */

// `vi.hoisted` runs before the hoisted `vi.mock` + the imports, so the mock factory can close over this fn. The
// generic signature (not named params) types `mock.calls` as the (id, input, ctx) tuple with no unused bindings.
const { executeCommand } = vi.hoisted(() => ({
  executeCommand: vi.fn<(id: string, input: unknown, ctx: unknown) => Promise<number>>(() =>
    Promise.resolve(0),
  ),
}));
vi.mock('./dispatch.js', () => ({ executeCommand }));

/** Parse `argv` through the real commander program (with a live context) and return the dispatched (id, input). */
function drive(argv: readonly string[]): { id: unknown; input: unknown } {
  executeCommand.mockClear();
  const io = captureIo().io;
  const context = {
    io,
    global: {
      json: false,
      color: false,
      cwd: process.cwd(),
      configPath: undefined,
      verbosity: 'normal' as const,
    },
    result: {},
  };
  const program = buildProgram(io, { context });
  program.exitOverride();
  // `.parse` (sync) invokes the action, which calls executeCommand synchronously BEFORE its first await — so the
  // mock has recorded the call by the time parse returns, even though the action's promise is not awaited here.
  program.parse(['node', 'relavium', ...argv]);
  const call = executeCommand.mock.calls[0];
  if (call === undefined) throw new Error('executeCommand was not called');
  return { id: call[0], input: call[1] };
}

describe('commander action → executeCommand forwarding (S10)', () => {
  it('provider add forwards BOTH --base-url AND --pricing-url (the dropped-opt regression)', () => {
    const { id, input } = drive([
      'provider',
      'add',
      'openai',
      '--base-url',
      'https://proxy.example/v1',
      '--pricing-url',
      'https://wiki.internal/prices',
    ]);
    expect(id).toBe('provider.add');
    expect(input).toMatchObject({
      positionals: ['openai'],
      options: { baseUrl: 'https://proxy.example/v1', pricingUrl: 'https://wiki.internal/prices' },
    });
  });

  it('run and agent run forward --allow-mcp-stdio (ADR-0084 §6)', () => {
    // The same dropped-opt regression this file exists for, in a security flag: the option was registered,
    // parsed by commander, and then never named in the action's destructured `opts`, so it reached
    // `buildRunArgs` as `undefined`. Every unit test still passed because they call the gate directly —
    // measured end to end on the built binary, the flag did nothing and the refusal repeated verbatim,
    // leaving ADR-0084 §6's CI escape hatch inoperative on an ephemeral runner that has no other way in.
    const run = drive([
      'run',
      'wf.relavium.yaml',
      '--allow-mcp-stdio',
      'v1:aa',
      '--allow-mcp-stdio',
      'v1:bb',
    ]);
    expect(run.id).toBe('run');
    expect(run.input).toMatchObject({
      positionals: ['wf.relavium.yaml'],
      options: { allowMcpStdio: ['v1:aa', 'v1:bb'] },
    });

    const agentRun = drive(['agent', 'run', 'helper', '--allow-mcp-stdio', 'v1:cc']);
    expect(agentRun.id).toBe('agent.run');
    expect(agentRun.input).toMatchObject({
      positionals: ['helper'],
      options: { allowMcpStdio: ['v1:cc'] },
    });
  });

  it('provider list forwards --verify (2.5.G S11)', () => {
    const { id, input } = drive(['provider', 'list', '--verify']);
    expect(id).toBe('provider.list');
    expect(input).toMatchObject({ positionals: [], options: { verify: true } });
  });

  it('models pricing forwards the MEDIA rates too (the CR-55 media-only invocation)', () => {
    // The three media flags were declared as Commander options but omitted from the action's forwarded
    // payload, so a media-only invocation — the one a `strict_cost_cap` refusal tells the user to run —
    // arrived at the dispatch with no rates and failed "missing required option --input". The existing
    // test above said "all four options" and checked exactly four, so it could not see the gap.
    const { id, input } = drive([
      'models',
      'pricing',
      'my-model',
      '--provider',
      'openai',
      '--image',
      '0.04',
      '--audio',
      '0.002',
      '--video',
      '0.5',
    ]);
    expect(id).toBe('models.pricing');
    expect(input).toMatchObject({
      positionals: ['my-model'],
      options: { provider: 'openai', image: '0.04', audio: '0.002', video: '0.5' },
    });
  });

  it('models pricing forwards the model positional + all four options', () => {
    const { id, input } = drive([
      'models',
      'pricing',
      'my-model',
      '--provider',
      'openai',
      '--input',
      '3',
      '--output',
      '9',
      '--cached',
      '0.1',
    ]);
    expect(id).toBe('models.pricing');
    expect(input).toMatchObject({
      positionals: ['my-model'],
      options: { provider: 'openai', input: '3', output: '9', cached: '0.1' },
    });
  });

  it('models pricing forwards --clear (the ADR-0071 §5 retire path)', () => {
    const { id, input } = drive([
      'models',
      'pricing',
      'my-model',
      '--provider',
      'openai',
      '--clear',
    ]);
    expect(id).toBe('models.pricing');
    expect(input).toMatchObject({
      positionals: ['my-model'],
      options: { provider: 'openai', clear: true },
    });
  });

  it('models refresh forwards --providers (the ADR-0071 §4a axis flag)', () => {
    const { id, input } = drive(['models', 'refresh', '--providers']);
    expect(id).toBe('models.refresh');
    expect(input).toMatchObject({ positionals: [], options: { providers: true } });
  });

  it('models refresh forwards --catalog (the ADR-0071 §4a axis flag)', () => {
    const { id, input } = drive(['models', 'refresh', '--catalog']);
    expect(id).toBe('models.refresh');
    expect(input).toMatchObject({ positionals: [], options: { catalog: true } });
  });
});
