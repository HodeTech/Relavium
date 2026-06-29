import { describe, expect, it } from 'vitest';

import { captureIo } from '../test-support.js';
import {
  buildAgentRunArgs,
  buildChatArgs,
  buildChatExportArgs,
  buildExportArgs,
  buildGateArgs,
  buildImportArgs,
  buildRunArgs,
  DISPATCHABLE_COMMAND_IDS,
  executeCommand,
  reqPositional,
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

describe('input extractors', () => {
  it('reqPositional returns the value or throws a clean invocation fault', () => {
    expect(reqPositional(input(['wf']), 0, 'workflow')).toBe('wf');
    expect(() => reqPositional(input([]), 0, 'workflow')).toThrow(/missing argument <workflow>/);
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
    expect(buildChatArgs(input([]))).toEqual({ agent: undefined });
  });

  it('chat-export: omits `out` entirely when absent (exactOptional contract), force defaults false', () => {
    const withOut = buildChatExportArgs(input(['sess'], { out: 'x.yaml', force: true }));
    expect(withOut).toEqual({ sessionId: 'sess', force: true, out: 'x.yaml' });
    const without = buildChatExportArgs(input(['sess']));
    expect(without).toEqual({ sessionId: 'sess', force: false });
    expect('out' in without).toBe(false); // omitted, not set to undefined
  });

  it('export: id + optional out + force', () => {
    expect(buildExportArgs(input(['wf-1'], { force: true }))).toEqual({ id: 'wf-1', force: true });
    expect('out' in buildExportArgs(input(['wf-1']))).toBe(false);
  });

  it('import: path + force', () => {
    expect(buildImportArgs(input(['./x.yaml'], { force: true }))).toEqual({
      path: './x.yaml',
      force: true,
    });
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

  it('gate: a missing runId is the clean invocation fault (a bare `gate` without `list`)', () => {
    expect(() => buildGateArgs(input([]))).toThrow(/`relavium gate` requires a <runId>/);
  });
});

describe('executeCommand', () => {
  it('an unknown command id is a clean invocation fault (never echoed — secret-safe)', () => {
    expect(() => executeCommand('definitely-not-a-command', input([]), ctx)).toThrow(
      /unknown command/,
    );
  });

  it('dispatch table ↔ manifest: every manifest command is dispatchable, and no executor is orphaned', () => {
    // In S2 the manifest covers exactly the commander commands, and each is dispatchable. (When 2.5.C adds
    // slash-only entries with their own executors, both sets grow together; this stays an exact-cover invariant.)
    expect(new Set(DISPATCHABLE_COMMAND_IDS)).toEqual(
      new Set(COMMAND_MANIFEST.map((entry) => entry.id)),
    );
  });
});
