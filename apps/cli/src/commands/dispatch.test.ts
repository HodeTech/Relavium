import { describe, expect, it } from 'vitest';

import { captureIo } from '../test-support.js';
import {
  boolFlag,
  buildAgentRunArgs,
  buildChatArgs,
  buildChatExportArgs,
  buildExportArgs,
  buildGateArgs,
  buildImportArgs,
  buildProviderAddArgs,
  buildProviderListArgs,
  buildProviderTestArgs,
  buildRunArgs,
  DISPATCHABLE_COMMAND_IDS,
  executeCommand,
  optPositional,
  optString,
  reqPositional,
  stringList,
  type CommandInput,
  type DispatchContext,
} from './dispatch.js';
import { COMMAND_MANIFEST } from './manifest.js';

/**
 * Tests for the shared command dispatch ([ADR-0056](../../../../docs/decisions/0056-cli-in-app-slash-command-system-and-manifest.md),
 * 2.5.C). The behaviour-sensitive part of the refactor is the pure `build*Args` extraction (argv → the core's
 * typed args) — exercised exhaustively here, including the exactOptional "omit, don't pass undefined" contract —
 * plus the dispatch ↔ manifest coverage invariant (every command is dispatchable, no orphan executor).
 */

const input = (
  positionals: readonly string[],
  options: CommandInput['options'] = {},
): CommandInput => ({
  positionals,
  options,
});

const ctx: DispatchContext = {
  io: captureIo().io,
  global: { json: false, color: false, cwd: '/tmp', configPath: undefined, verbosity: 'normal' },
};

describe('input extractors (shared by every command)', () => {
  it('reqPositional returns the value or throws a clean invocation fault', () => {
    expect(reqPositional(input(['wf']), 0, 'workflow')).toBe('wf');
    expect(() => reqPositional(input([]), 0, 'workflow')).toThrow(/missing argument <workflow>/);
  });

  it('optPositional is the value or undefined', () => {
    expect(optPositional(input(['x']), 0)).toBe('x');
    expect(optPositional(input([]), 0)).toBeUndefined();
  });

  it('optString returns a string value, undefined for a boolean/list/absent', () => {
    expect(optString('v')).toBe('v');
    expect(optString(true)).toBeUndefined();
    expect(optString(['a'])).toBeUndefined();
    expect(optString(undefined)).toBeUndefined();
  });

  it('boolFlag is true only for present-and-true (false ≡ unset)', () => {
    expect(boolFlag(true)).toBe(true);
    expect(boolFlag(undefined)).toBe(false);
    expect(boolFlag('x')).toBe(false);
  });

  it('stringList returns the list, or [] for a string/boolean/absent', () => {
    expect(stringList(['a', 'b'])).toEqual(['a', 'b']);
    expect(stringList('a')).toEqual([]);
    expect(stringList(true)).toEqual([]);
    expect(stringList(undefined)).toEqual([]);
  });
});

describe('build*Args (argv → typed core args)', () => {
  it('run: required workflow + repeatable input (empty list when absent)', () => {
    expect(buildRunArgs(input(['wf'], { input: ['a=1', 'b=2'] }))).toEqual({
      workflow: 'wf',
      input: ['a=1', 'b=2'],
    });
    expect(buildRunArgs(input(['wf']))).toEqual({ workflow: 'wf', input: [] });
  });

  it('chat: agent is undefined when absent (the built-in default)', () => {
    expect(buildChatArgs(input([], { agent: 'coder' }))).toEqual({ agent: 'coder' });
    // agent:undefined is kept (not omitted) to match the old register body — chatCommand reads `undefined` as
    // "no agent bound", so the field is present-but-undefined, unlike the exactOptional omit cases below.
    expect(buildChatArgs(input([]))).toEqual({ agent: undefined });
  });

  it('chat-export: omits `out` entirely when absent (exactOptional contract), force defaults false', () => {
    const withOut = buildChatExportArgs(input(['sess'], { out: 'x.yaml', force: true }));
    expect(withOut).toEqual({ sessionId: 'sess', force: true, out: 'x.yaml' });
    const without = buildChatExportArgs(input(['sess']));
    expect(without).toEqual({ sessionId: 'sess', force: false });
    expect('out' in without).toBe(false); // omitted, not set to undefined
  });

  it('export: id + optional out + force (defaults false, out omitted when absent)', () => {
    expect(buildExportArgs(input(['wf-1'], { force: true }))).toEqual({ id: 'wf-1', force: true });
    expect(buildExportArgs(input(['wf-1']))).toEqual({ id: 'wf-1', force: false });
    expect('out' in buildExportArgs(input(['wf-1']))).toBe(false);
  });

  it('import: path + force (defaults false)', () => {
    expect(buildImportArgs(input(['./x.yaml'], { force: true }))).toEqual({
      path: './x.yaml',
      force: true,
    });
    expect(buildImportArgs(input(['./x.yaml']))).toEqual({ path: './x.yaml', force: false });
  });

  it('agent.run: agent + repeatable input + optional fixture (omitted when absent)', () => {
    expect(buildAgentRunArgs(input(['a'], { input: ['k=v'], fixture: 'c.json' }))).toEqual({
      agent: 'a',
      input: ['k=v'],
      fixture: 'c.json',
    });
    const noFixture = buildAgentRunArgs(input(['a']));
    expect(noFixture).toEqual({ agent: 'a', input: [] });
    expect('fixture' in noFixture).toBe(false);
  });

  it('gate: definite booleans (false ≡ unset), optional strings omitted when absent', () => {
    expect(buildGateArgs(input(['run-1'], { approve: true, comment: 'lgtm' }))).toEqual({
      runId: 'run-1',
      approve: true,
      reject: false,
      comment: 'lgtm',
    });
    const bare = buildGateArgs(input(['run-1']));
    expect(bare).toEqual({ runId: 'run-1', approve: false, reject: false });
    expect('comment' in bare).toBe(false);
    expect('gate' in bare).toBe(false);
  });

  it('gate: reject + input + gate options pass through (input/gate omitted when absent)', () => {
    expect(buildGateArgs(input(['run-1'], { reject: true }))).toEqual({
      runId: 'run-1',
      approve: false,
      reject: true,
    });
    expect(buildGateArgs(input(['run-1'], { input: '{"ok":true}', gate: 'g-1' }))).toEqual({
      runId: 'run-1',
      approve: false,
      reject: false,
      input: '{"ok":true}',
      gate: 'g-1',
    });
    expect('input' in buildGateArgs(input(['run-1']))).toBe(false);
  });

  it('gate: a missing runId is the clean invocation fault (a bare `gate` without `list`)', () => {
    expect(() => buildGateArgs(input([]))).toThrow(/`relavium gate` requires a <runId>/);
  });

  it('provider.list: verify defaults false, true when the flag is present', () => {
    expect(buildProviderListArgs(input([], {}))).toEqual({ action: 'list', verify: false });
    expect(buildProviderListArgs(input([], { verify: true }))).toEqual({
      action: 'list',
      verify: true,
    });
  });

  it('provider.add: name + optional baseUrl + optional pricingUrl (each omitted when absent)', () => {
    expect(
      buildProviderAddArgs(
        input(['anthropic'], { baseUrl: 'https://x', pricingUrl: 'https://p' }),
      ),
    ).toEqual({
      action: 'add',
      name: 'anthropic',
      baseUrl: 'https://x',
      pricingUrl: 'https://p',
    });
    const noOpts = buildProviderAddArgs(input(['anthropic']));
    expect(noOpts).toEqual({ action: 'add', name: 'anthropic' });
    expect('baseUrl' in noOpts).toBe(false);
    expect('pricingUrl' in noOpts).toBe(false);
    // pricingUrl alone (no baseUrl) still extracts (the S10 flag is independent of --base-url).
    expect(buildProviderAddArgs(input(['openai'], { pricingUrl: 'https://p' }))).toEqual({
      action: 'add',
      name: 'openai',
      pricingUrl: 'https://p',
    });
  });

  it('provider.test: name + optional model (omitted when absent)', () => {
    expect(buildProviderTestArgs(input(['anthropic'], { model: 'haiku' }))).toEqual({
      action: 'test',
      name: 'anthropic',
      model: 'haiku',
    });
    const noModel = buildProviderTestArgs(input(['anthropic']));
    expect(noModel).toEqual({ action: 'test', name: 'anthropic' });
    expect('model' in noModel).toBe(false);
  });
});

describe('executeCommand', () => {
  it('an unknown command id is a clean invocation fault, surfaced as a rejection (never echoed — secret-safe)', async () => {
    await expect(executeCommand('definitely-not-a-command', input([]), ctx)).rejects.toThrow(
      /unknown command/,
    );
  });

  it('an arg-extraction fault surfaces as a rejection, unchanged (gate without a runId)', async () => {
    // `async` executeCommand turns the executor's synchronous build*Args throw into a clean rejection.
    await expect(executeCommand('gate', input([]), ctx)).rejects.toThrow(
      /`relavium gate` requires a <runId>/,
    );
  });

  it('routes a known id to its executor — a missing required positional faults from inside, not "unknown command"', async () => {
    // These executors call reqPositional in build*Args BEFORE any dep wiring, so an empty input faults with the
    // arg message (proving the id routed to the right executor). Provider commands are excluded — they open the
    // local db before validating, so testing them here would touch real I/O.
    const requirePositional = [
      'run',
      'chat-resume',
      'chat-export',
      'export',
      'import',
      'agent.run',
      'logs',
    ];
    for (const id of requirePositional) {
      await expect(executeCommand(id, input([]), ctx)).rejects.toThrow(/missing argument/);
    }
  });

  it('dispatch table ↔ manifest: every manifest command is dispatchable, and no executor is orphaned', () => {
    // The durable chain: commander ⊆ manifest (manifest.test.ts drift guard) AND manifest == dispatch (here) ⟹
    // every commander command is dispatchable. The in-REPL `/` palette + slash commands are a SEPARATE
    // REPL_COMMANDS registry (repl-commands.ts — ADR-0056 amendment), not executeCommand entries, so the manifest
    // stays exactly the shell command set and this remains an exact-cover invariant.
    expect(new Set(DISPATCHABLE_COMMAND_IDS)).toEqual(
      new Set(COMMAND_MANIFEST.map((entry) => entry.id)),
    );
  });
});
