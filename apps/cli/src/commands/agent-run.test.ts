import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver, textTurn, unresolvedResolver } from '../chat/test-support.js';
import type { ProviderResolver } from '../engine/providers.js';
import { isCliError } from '../process/errors.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { agentRunCommand, readAllStdin, type AgentRunCommandDeps } from './agent-run.js';

const AGENT_YAML =
  'id: coder\nprovider: anthropic\nmodel: claude-sonnet-4-6\nsystem_prompt: You are a coder.\ntools:\n  - read_file';
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

  it('emits a pure NDJSON session stream under --json (no human chrome, no key leak)', async () => {
    const { d, out, err } = deps('hi', {
      json: true,
      providers: scriptedResolver([textTurn('reply')]),
    });
    expect(await agentRunCommand({ agent: agentPath(), input: [] }, d)).toBe(EXIT_CODES.success);
    // Every stdout line is a valid SessionEvent object (parseNdjson throws on a leaked human line).
    const types = parseNdjson<{ type: string }>(out()).map((e) => e.type);
    expect(types[0]).toBe('session:started'); // the subscription is wired before start() — first line
    expect(types).toContain('session:turn_completed');
    expect(err()).not.toContain('session:'); // no event leaks onto stderr
    expect(out()).not.toContain('test-key'); // the dummy provider key never reaches the stream
  });

  it('--json + a tool-calling --fixture cassette replays the tool loop, offline, with no key leak', async () => {
    // A 2-call cassette: a tool_use turn (forcing a 2nd stream() call) then the text turn. Drives the full
    // replay through the fail-closed tool host; the NDJSON stream carries agent:tool_call and the answer.
    const toolCassette = {
      schema_version: '1.0',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      calls: [
        [
          { type: 'tool_call_start', id: 'tc-1', name: 'read_file' },
          { type: 'tool_call_end', id: 'tc-1' },
          { type: 'stop', stopReason: 'tool_use', usage: { inputTokens: 4, outputTokens: 2 } },
        ],
        [
          { type: 'text_delta', text: 'the answer' },
          { type: 'stop', stopReason: 'stop', usage: { inputTokens: 5, outputTokens: 3 } },
        ],
      ],
    };
    writeFileSync(join(cwd, 'tool.json'), JSON.stringify(toolCassette));
    const { d, out } = deps('read it', { json: true }); // no providers ⇒ pure offline cassette path
    expect(await agentRunCommand({ agent: agentPath(), input: [], fixture: 'tool.json' }, d)).toBe(
      EXIT_CODES.success,
    );
    const types = parseNdjson<{ type: string }>(out()).map((e) => e.type);
    expect(types).toContain('agent:tool_call'); // the recorded tool call is replayed onto the stream
    expect(types).toContain('session:turn_completed');
    expect(out()).not.toContain('fixture-key'); // the cassette's offline marker never reaches the stream
  });

  it('--fixture takes precedence over an injected resolver (the cassette wins)', async () => {
    writeFileSync(join(cwd, 'c.json'), JSON.stringify(CASSETTE));
    // Pass BOTH a fixture and an injected resolver; the cassette must win (offline determinism beats the seam).
    const { d, out } = deps('hi', { providers: scriptedResolver([textTurn('INJECTED')]) });
    expect(await agentRunCommand({ agent: agentPath(), input: [], fixture: 'c.json' }, d)).toBe(
      EXIT_CODES.success,
    );
    expect(out()).toContain('cassette reply');
    expect(out()).not.toContain('INJECTED');
  });

  it('maps an under-recorded cassette (an unscripted stream call) to exit 1, never a crash', async () => {
    // A cassette with zero recorded calls: the first turn's stream() is unscripted ⇒ the replay throws ⇒ the
    // chain classifies it into a turn error ⇒ the command RESOLVES to exit 1 (it must not reject/crash).
    writeFileSync(join(cwd, 'empty.json'), JSON.stringify({ ...CASSETTE, calls: [] }));
    const { d } = deps('hi', {});
    expect(await agentRunCommand({ agent: agentPath(), input: [], fixture: 'empty.json' }, d)).toBe(
      EXIT_CODES.workflowFailed,
    );
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

  it('rejects --input as not-yet-supported (session prompt interpolation is a pending engine change)', async () => {
    // --input is RESERVED: a session does not interpolate {{ctx.*}} into the prompt yet, so exposing it as a
    // working flag would mislead. It fails loud (exit 2) — before reading stdin — until interpolation lands.
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('x')]) });
    await expect(
      agentRunCommand({ agent: agentPath(), input: ['file=./x.ts'] }, d),
    ).rejects.toThrow(/`--input` is not supported yet/);
  });

  it('rejects an empty stdin prompt as a clean exit-2 fault', async () => {
    const { d } = deps('   ', { providers: scriptedResolver([]) });
    await expect(agentRunCommand({ agent: agentPath(), input: [] }, d)).rejects.toThrow(
      /no input message/,
    );
  });

  it('rejects an unknown agent as a clean exit-2 (typed invalid_invocation) fault', async () => {
    const { d } = deps('hi', { providers: scriptedResolver([textTurn('x')]) });
    let thrown: unknown;
    await agentRunCommand({ agent: join(cwd, 'ghost.agent.yaml'), input: [] }, d).catch((e) => {
      thrown = e;
    });
    expect(isCliError(thrown)).toBe(true); // a typed CliError (exit 2), not a raw provider/parse crash
    expect(isCliError(thrown) && thrown.code).toBe('invalid_invocation'); // pins exit 2, not exit 1
  });

  it('rejects a bad --fixture cassette as a clean exit-2 fault', async () => {
    writeFileSync(join(cwd, 'bad.json'), '{ not json');
    const { d } = deps('hi', {});
    await expect(
      agentRunCommand({ agent: agentPath(), input: [], fixture: 'bad.json' }, d),
    ).rejects.toThrow(/not valid JSON/);
  });
});

describe('readAllStdin (2.Q)', () => {
  it('decodes a multi-byte UTF-8 character split ACROSS a chunk boundary (StringDecoder buffering)', async () => {
    // Split the UTF-8 bytes of a multi-byte string mid-character into two Buffers; a per-chunk decode would
    // mangle the boundary char into replacement chars (�), the StringDecoder buffers it across writes.
    const bytes = Buffer.from('şağ🚀', 'utf8');
    const mid = Math.floor(bytes.length / 2);
    const stream = Readable.from([bytes.subarray(0, mid), bytes.subarray(mid)]);
    expect(await readAllStdin(stream)).toBe('şağ🚀');
  });

  it('reads a string-yielding stream (the test fallback) verbatim', async () => {
    expect(await readAllStdin(Readable.from(['hel', 'lo']))).toBe('hello');
  });
});
