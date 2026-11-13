import { unwiredEffectJournal } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';

import { BUILTIN_TOOLS } from './builtins.js';
import { ToolArgsInvalidError, ToolPolicyError, ToolUnavailableError } from './errors.js';
import { createToolRegistry } from './registry.js';
import type { FileRead, FsCapability, ToolDispatchContext, ToolHost } from './types.js';

const source: FileRead = {
  content: 'observed',
  mimeType: 'text/plain',
  sizeBytes: 8,
  lastModified: 't',
};
const stats = {
  entriesVisited: 1,
  filesScanned: 1,
  bytesScanned: 8,
  skippedBinary: 0,
  skippedOversize: 0,
  unreadable: 0,
  incomplete: false,
};

function context(overrides: Partial<ToolDispatchContext> = {}): ToolDispatchContext {
  return {
    nodeId: 'n',
    grantedToolIds: new Set(['read_file', 'search_files', 'find_files']),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: unwiredEffectJournal(),
    effectSlot: 0,
    readScope: {},
    ...overrides,
  };
}

function filesystem(overrides: Partial<FsCapability> = {}): FsCapability {
  return {
    readFile: () => Promise.resolve(source),
    writeFile: () => {
      throw new Error('unexpected write');
    },
    listDirectory: () => Promise.resolve({ entries: [] }),
    ...overrides,
  };
}

describe('bounded file tools at the actual registry boundary', () => {
  it('forwards exact source ranges without approval or effect work', async () => {
    const readFile = vi.fn<FsCapability['readFile']>(() => Promise.resolve(source));
    const registry = createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: { fs: filesystem({ readFile }) },
    });
    const range = { unit: 'bytes', start: 0, end: 8 } as const;
    await registry.dispatch(
      { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'a', range } },
      context(),
    );
    expect(readFile).toHaveBeenCalledWith('a', { glob: undefined, range }, undefined);
  });

  it.each([
    { range: { unit: 'lines', start: 0, end: 1 } },
    { range: { unit: 'bytes', start: 3, end: 2 } },
    { range: { unit: 'bytes', start: -1, end: 2 } },
    { range: { unit: 'bytes', start: 0.5, end: 2 } },
    { glob: true, range: { unit: 'lines', start: 1, end: 2 } },
  ])('refuses an invalid range before host work: %j', async (args) => {
    const readFile = vi.fn<FsCapability['readFile']>(() => Promise.resolve(source));
    const registry = createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: { fs: filesystem({ readFile }) },
    });
    await expect(
      registry.dispatch(
        { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'a', ...args } },
        context(),
      ),
    ).rejects.toBeInstanceOf(ToolArgsInvalidError);
    expect(readFile).not.toHaveBeenCalled();
  });

  it('passes a hostile-looking literal as data and retains discovery metadata', async () => {
    const result = { matches: [{ path: 'a', line: 1, content: '(a+)+$', omittedBytes: 0 }], stats };
    const searchFiles = vi.fn<NonNullable<FsCapability['searchFiles']>>(() =>
      Promise.resolve(result),
    );
    const registry = createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: { fs: filesystem({ searchFiles }) },
    });
    const outcome = await registry.dispatch(
      {
        type: 'tool_call',
        id: 's',
        name: 'search_files',
        args: { pattern: '(a+)+$', wholeWord: true },
      },
      context(),
    );
    expect(searchFiles).toHaveBeenCalledWith(
      '.',
      { pattern: '(a+)+$', wholeWord: true, caseSensitive: undefined, glob: undefined },
      undefined,
    );
    expect(outcome.output).toBe(result);
    expect(outcome.truncated).toBe(false);
  });

  it.each(['find_files', 'search_files'])('keeps the grant authoritative for %s', async (name) => {
    const searchFiles = vi.fn<NonNullable<FsCapability['searchFiles']>>(() =>
      Promise.resolve({ matches: [], stats }),
    );
    const findFiles = vi.fn<NonNullable<FsCapability['findFiles']>>(() =>
      Promise.resolve({ files: [], stats }),
    );
    const registry = createToolRegistry({
      tools: BUILTIN_TOOLS,
      host: { fs: filesystem({ searchFiles, findFiles }) },
    });
    await expect(
      registry.dispatch(
        { type: 'tool_call', id: 's', name, args: { pattern: 'x', glob: '*' } },
        context({ grantedToolIds: new Set() }),
      ),
    ).rejects.toBeInstanceOf(ToolPolicyError);
    expect(searchFiles).not.toHaveBeenCalled();
    expect(findFiles).not.toHaveBeenCalled();
  });

  it.each([
    ['find_files', { glob: '**/*' }],
    ['search_files', { pattern: 'x' }],
  ])('refuses an unwired filesystem sub-capability: %s', async (name, args) => {
    const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { fs: filesystem() } });
    await expect(
      registry.dispatch({ type: 'tool_call', id: 's', name, args }, context()),
    ).rejects.toBeInstanceOf(ToolUnavailableError);
  });

  it('stages only exact untruncated read objects and explicitly releases their scope', async () => {
    const acknowledgeReadResult = vi.fn();
    const promoteReadScope = vi.fn();
    const releaseReadScope = vi.fn();
    const host: ToolHost = {
      fs: filesystem({ acknowledgeReadResult, promoteReadScope, releaseReadScope }),
    };
    const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host });
    const scope = {};
    const ctx = context({ readScope: scope });
    await registry.dispatch(
      { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'a' } },
      ctx,
    );
    expect(acknowledgeReadResult).toHaveBeenCalledExactlyOnceWith(scope, source);
    expect(promoteReadScope).not.toHaveBeenCalled();
    acknowledgeReadResult.mockClear();
    await registry.dispatch(
      { type: 'tool_call', id: 'r2', name: 'read_file', args: { path: 'a' } },
      { ...ctx, limits: { maxBytes: 4, maxLines: 1 } },
    );
    expect(acknowledgeReadResult).not.toHaveBeenCalled();
    registry.promoteReadScope?.(scope);
    registry.releaseReadScope?.(scope);
    expect(promoteReadScope).toHaveBeenCalledExactlyOnceWith(scope);
    expect(releaseReadScope).toHaveBeenCalledExactlyOnceWith(scope);
  });
});

it('keeps opaque output references out of built-in read display projections', async () => {
  const ref = 'output://session/private';
  const readFile = vi.fn<FsCapability['readFile']>(() => Promise.resolve(source));
  const events: unknown[] = [];
  const registry = createToolRegistry({
    tools: BUILTIN_TOOLS,
    host: { fs: filesystem({ readFile }) },
  });
  const result = await registry.dispatch(
    { type: 'tool_call', id: 'r', name: 'read_file', args: { path: ref } },
    context({ onToolLiveEvent: (event) => events.push(event) }),
  );
  expect(readFile).toHaveBeenCalledWith(ref, { glob: undefined, range: undefined }, undefined);
  expect(JSON.stringify(events)).not.toContain(ref);
  expect(JSON.stringify(result.events.call.toolInput)).not.toContain(ref);
});

it('keeps filesystem paths and same-named non-builtin tool inputs visible', async () => {
  const ref = 'output://session/private';
  const builtin = BUILTIN_TOOLS.find((tool) => tool.id === 'read_file');
  if (builtin === undefined) throw new Error('missing read_file');
  const events: unknown[] = [];
  const host = { fs: filesystem() };
  const ordinary = createToolRegistry({ tools: [builtin], host });
  const result = await ordinary.dispatch(
    { type: 'tool_call', id: 'r', name: 'read_file', args: { path: 'file.txt' } },
    context({ onToolLiveEvent: (event) => events.push(event) }),
  );
  expect(JSON.stringify(events)).toContain('file.txt');
  expect(result.events.call.toolInput['path']).toBe('file.txt');
  const other = createToolRegistry({ tools: [{ ...builtin, source: 'mcp' }], host });
  const otherResult = await other.dispatch(
    { type: 'tool_call', id: 'r', name: 'read_file', args: { path: ref } },
    context(),
  );
  expect(otherResult.events.call.toolInput['path']).toBe(ref);
});

it('bounds write, edit and list path and glob in UTF-8 bytes', () => {
  const cases = [
    { id: 'write_file', args: { path: 'a', content: '' } },
    { id: 'edit_file', args: { path: 'a', old_string: 'x', new_string: '' } },
    { id: 'list_directory', args: { path: 'a', glob: '' } },
  ];
  for (const { id, args } of cases) {
    const tool = BUILTIN_TOOLS.find((entry) => entry.id === id);
    if (tool === undefined) throw new Error('missing tool');
    expect(() => tool.parseArgs({ ...args, path: 'é'.repeat(2048) })).not.toThrow();
    expect(() => tool.parseArgs({ ...args, path: 'é'.repeat(2048) + 'x' })).toThrow();
    if (id === 'list_directory') {
      expect(() => tool.parseArgs(args)).not.toThrow();
      expect(() => tool.parseArgs({ ...args, glob: 'é'.repeat(2048) })).not.toThrow();
      expect(() => tool.parseArgs({ ...args, glob: 'é'.repeat(2048) + 'x' })).toThrow();
    }
  }
});
