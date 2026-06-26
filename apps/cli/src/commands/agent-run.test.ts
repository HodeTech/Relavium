import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver, textTurn, unresolvedResolver } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { agentRunCommand, type AgentRunCommandDeps } from './agent-run.js';

const AGENT_YAML =
  'id: coder\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: You are a coder.';
const CASSETTE = {
  schema_version: '1.0',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  calls: [
    [
      { type: 'text_delta', text: 'cassette reply' },
      { type: 'stop', stopReason: 'stop', usage: { inputTokens: 10, outputTokens: 5 } },
    ],
  ],
};
const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

function globalOptions(cwd: string, json = false): GlobalOptions {
  return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

describe('agentRunCommand (2.Q)', () => {
  let cwd: string;
  let home: string;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'relavium-agentrun-cwd-'));
    home = mkdtempSync(join(tmpdir(), 'relavium-agentrun-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
    writeFileSync(join(cwd, 'coder.agent.yaml'), AGENT_YAML);
  });
  afterEach(() => {
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  function deps(
    stdin: string,
    opts: { json?: boolean; providers?: ProviderResolver } = {},
  ): { d: AgentRunCommandDeps; out: () => string; err: () => string } {
    const { io, out, err } = captureIo();
    return {
      d: {
        io: { ...io, stdin: Readable.from([stdin]) },
        global: globalOptions(cwd, opts.json ?? false),
        now: () => 0,
        uuid: () => 'a-0',
        ...(opts.providers === undefined ? {} : { providers: opts.providers }),
      },
      out,
      err,
    };
  }

  const agentPath = (): string => join(cwd, 'coder.agent.yaml');

  it('runs one turn from a stdin prompt and prints the reply (exit 0)', async () => {
    const { d, out } = deps('summarize this', {
      providers: scriptedResolver([textTurn('the summary')]),
    });
    expect(await agentRunCommand({ agent: agentPath(), input: [] }, d)).toBe(EXIT_CODES.success);
    expect(out()).toContain('the summary');
  });

  it('emits the NDJSON session stream under --json', async () => {
    const { d, out } = deps('hi', { json: true, providers: scriptedResolver([textTurn('reply')]) });
    expect(await agentRunCommand({ agent: agentPath(), input: [] }, d)).toBe(EXIT_CODES.success);
    const types = parseNdjson<{ type: string }>(out()).map((e) => e.type);
    expect(types).toContain('session:started');
    expect(types).toContain('session:turn_completed');
  });

  it('replays a --fixture cassette deterministically with NO providers injected (offline)', async () => {
    writeFileSync(join(cwd, 'c.json'), JSON.stringify(CASSETTE));
    const { d, out } = deps('anything', {}); // no providers ⇒ the cassette resolver is built from the file
    expect(await agentRunCommand({ agent: agentPath(), input: [], fixture: 'c.json' }, d)).toBe(
      EXIT_CODES.success,
    );
    expect(out()).toContain('cassette reply'); // the recorded chunks were replayed
  });

  it('maps a turn failure to exit 1 (the turn outcome, not the command shell)', async () => {
    const { d } = deps('hi', { providers: unresolvedResolver() }); // every turn settles as an internal error
    expect(await agentRunCommand({ agent: agentPath(), input: [] }, d)).toBe(
      EXIT_CODES.workflowFailed,
    );
  });

  it('threads --input k=v into the session context variables (a value may contain =)', async () => {
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('ok')]) });
    expect(
      await agentRunCommand({ agent: agentPath(), input: ['file=./x.ts', 'expr=a=b'] }, d),
    ).toBe(EXIT_CODES.success);
  });

  it('rejects an empty stdin prompt as a clean exit-2 fault', async () => {
    const { d } = deps('   ', { providers: scriptedResolver([]) });
    await expect(agentRunCommand({ agent: agentPath(), input: [] }, d)).rejects.toThrow(
      /no input message/,
    );
  });

  it('rejects a malformed --input as a clean exit-2 fault', async () => {
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('x')]) });
    await expect(agentRunCommand({ agent: agentPath(), input: ['noequals'] }, d)).rejects.toThrow(
      /expected key=value/,
    );
  });

  it('rejects a duplicate --input key as a clean exit-2 fault', async () => {
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('x')]) });
    await expect(agentRunCommand({ agent: agentPath(), input: ['k=1', 'k=2'] }, d)).rejects.toThrow(
      /duplicate --input key/,
    );
  });

  it('rejects an unknown agent as a clean exit-2 fault', async () => {
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('x')]) });
    await expect(
      agentRunCommand({ agent: join(cwd, 'ghost.agent.yaml'), input: [] }, d),
    ).rejects.toThrow();
  });

  it('rejects a bad --fixture cassette as a clean exit-2 fault', async () => {
    writeFileSync(join(cwd, 'bad.json'), '{ not json');
    const { d } = deps('hi', {});
    await expect(
      agentRunCommand({ agent: agentPath(), input: [], fixture: 'bad.json' }, d),
    ).rejects.toThrow(/not valid JSON/);
  });
});
