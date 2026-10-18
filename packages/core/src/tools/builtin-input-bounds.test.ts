import { utf8ByteLength } from '@relavium/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { BUILTIN_TOOLS } from './builtins.js';
import type { ToolDef } from './types.js';

// Observe the existing platform-pure byte authority, retaining its actual implementation. No shipping
// injection point is needed, and direct parse avoids unrelated event/output byte measurements.
vi.mock('@relavium/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@relavium/shared')>();
  return { ...actual, utf8ByteLength: vi.fn(actual.utf8ByteLength) };
});

afterEach(() => vi.clearAllMocks());

function tool(id: string): ToolDef {
  const found = BUILTIN_TOOLS.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing built-in fixture: ${id}`);
  return found;
}

const STRING_FIELDS = [
  { id: 'write_file', field: 'content', cap: 8 * 1024 * 1024, base: { path: 'out.txt' } },
  { id: 'http_request', field: 'body', cap: 1024 * 1024, base: { url: 'https://api.example/x' } },
  { id: 'git_commit', field: 'message', cap: 16 * 1024, base: {} },
] satisfies ReadonlyArray<{
  id: string;
  field: string;
  cap: number;
  base: Record<string, unknown>;
}>;

const PATTERNS = [
  { label: 'ASCII', text: 'a', bytes: 1 },
  { label: 'two-byte', text: 'é', bytes: 2 },
  { label: 'three-byte', text: '€', bytes: 3 },
  { label: 'surrogate-pair', text: '😀', bytes: 4 },
  { label: 'lone-high-surrogate', text: '\ud800', bytes: 3 },
  { label: 'lone-low-surrogate', text: '\udc00', bytes: 3 },
  // The high surrogate must not consume the following non-low unit: 3 + 1 bytes per pattern.
  { label: 'high-surrogate-before-ASCII', text: '\ud800b', bytes: 4 },
];

function atBytes(cap: number, pattern: (typeof PATTERNS)[number]): string {
  return pattern.text.repeat(Math.floor(cap / pattern.bytes)) + 'a'.repeat(cap % pattern.bytes);
}

describe('built-in executable UTF-8 input admission', () => {
  for (const { id, field, cap, base } of STRING_FIELDS) {
    for (const pattern of PATTERNS) {
      it(`[BYTE-CAP] ${id}.${field} accepts ${cap} and refuses ${cap + 1} bytes (${pattern.label})`, () => {
        // Expected byte sizes come from the literal pattern arithmetic, not the production helper.
        const exact = atBytes(cap, pattern);
        const raw = { ...base, [field]: exact };
        expect(tool(id).parseArgs(raw), 'inclusive byte cap preserves the accepted value').toEqual(
          raw,
        );
        expect(
          () => tool(id).parseArgs({ ...base, [field]: `${exact}a` }),
          'one byte over the cap must be refused',
        ).toThrow(z.ZodError);
      });
    }

    it(`[CHEAP-STRING] ${id}.${field} rejects impossible UTF-16 length before byte scanning`, () => {
      const byteLength = vi.mocked(utf8ByteLength);
      byteLength.mockClear();
      expect(() => tool(id).parseArgs({ ...base, [field]: 'a'.repeat(cap + 1) })).toThrow(
        z.ZodError,
      );
      expect(
        byteLength,
        'cheap character lower bound must precede byte measurement',
      ).not.toHaveBeenCalled();
    });

    it(`[REAL-BYTES] ${id}.${field} measures plausible multibyte overflow and exact cap`, () => {
      const byteLength = vi.mocked(utf8ByteLength);
      const exact = 'é'.repeat(cap / 2);
      byteLength.mockClear();
      expect(() => tool(id).parseArgs({ ...base, [field]: `${exact}a` })).toThrow(z.ZodError);
      expect(
        byteLength,
        'UTF-16-plausible overflow must use the shared byte authority',
      ).toHaveBeenCalledWith(`${exact}a`);
      byteLength.mockClear();
      expect(tool(id).parseArgs({ ...base, [field]: exact })).toEqual({ ...base, [field]: exact });
      expect(byteLength).toHaveBeenCalledWith(exact);
    });
  }

  for (const pattern of PATTERNS) {
    it(`[ARG-BYTE-CAP] run_command entry accepts 16384 and refuses 16385 bytes (${pattern.label})`, () => {
      const exact = atBytes(16 * 1024, pattern);
      expect(tool('run_command').parseArgs({ command: 'echo', args: [exact] })).toEqual({
        command: 'echo',
        args: [exact],
      });
      expect(() => tool('run_command').parseArgs({ command: 'echo', args: [`${exact}a`] })).toThrow(
        z.ZodError,
      );
    });
  }

  it('[ARG-COUNT] accepts 256 empty entries and refuses 257 before member byte scans', () => {
    expect(
      tool('run_command').parseArgs({ command: 'echo', args: Array<string>(256).fill('') }),
    ).toEqual({
      command: 'echo',
      args: Array<string>(256).fill(''),
    });
    const byteLength = vi.mocked(utf8ByteLength);
    byteLength.mockClear();
    expect(() =>
      tool('run_command').parseArgs({ command: 'echo', args: Array<string>(257).fill('é') }),
    ).toThrow(z.ZodError);
    expect(byteLength, 'count refusal precedes all member byte scans').not.toHaveBeenCalled();
  });

  it('[ARG-AGGREGATE] accepts exactly 65536 bytes and refuses an extra individually valid entry', () => {
    const args = Array<string>(4).fill('a'.repeat(16 * 1024));
    expect(tool('run_command').parseArgs({ command: 'echo', args })).toEqual({
      command: 'echo',
      args,
    });
    expect(() => tool('run_command').parseArgs({ command: 'echo', args: [...args, 'a'] })).toThrow(
      z.ZodError,
    );
  });

  it('[ARG-DENSE-AGGREGATE] counts every multibyte member, not UTF-16 units or the largest member', () => {
    const args = Array<string>(256).fill('é'.repeat(128)); // 256 * 128 * 2 = 65536 bytes.
    expect(tool('run_command').parseArgs({ command: 'echo', args })).toEqual({
      command: 'echo',
      args,
    });
    args[255] = `${args[255] ?? ''}a`;
    expect(() => tool('run_command').parseArgs({ command: 'echo', args })).toThrow(z.ZodError);
  });

  it('[CHEAP-ARG-ENTRY] refuses impossible member length before byte measurement', () => {
    expect(() =>
      tool('run_command').parseArgs({ command: 'echo', args: ['a'.repeat(16 * 1024 + 1)] }),
    ).toThrow(z.ZodError);
    expect(vi.mocked(utf8ByteLength)).not.toHaveBeenCalled();
  });

  it('[CHEAP-ARG-TOTAL] refuses impossible aggregate UTF-16 length before byte measurement', () => {
    expect(() =>
      tool('run_command').parseArgs({
        command: 'echo',
        args: Array<string>(5).fill('a'.repeat(16 * 1024)),
      }),
    ).toThrow(z.ZodError);
    expect(vi.mocked(utf8ByteLength)).not.toHaveBeenCalled();
  });

  it('[OPTIONAL-EMPTY] preserves empty content/body, omitted body/args and empty args', () => {
    for (const raw of [
      { path: 'out.txt', content: '' },
      { path: 'out.txt', content: 'hello' },
    ]) {
      expect(tool('write_file').parseArgs(raw)).toEqual(raw);
    }
    for (const raw of [
      { url: 'https://api.example/x' },
      { url: 'https://api.example/x', body: '' },
    ]) {
      expect(tool('http_request').parseArgs(raw)).toEqual(raw);
    }
    for (const raw of [
      { command: 'echo' },
      { command: 'echo', args: [] },
      { command: 'echo', args: ['ordinary', 'two words', ''] },
    ]) {
      expect(tool('run_command').parseArgs(raw)).toEqual(raw);
    }
    expect(() => tool('git_commit').parseArgs({ message: '' })).toThrow(z.ZodError);
    expect(tool('git_commit').parseArgs({ message: 'ordinary commit' })).toEqual({
      message: 'ordinary commit',
    });
  });

  it('[STRICT-SHAPE] preserves type and unknown-key refusal on bounded fields', () => {
    for (const { id, field, base } of STRING_FIELDS) {
      expect(() => tool(id).parseArgs({ ...base, [field]: 1 })).toThrow(z.ZodError);
      expect(() => tool(id).parseArgs({ ...base, [field]: 'ok', extra: true })).toThrow(z.ZodError);
    }
    expect(() => tool('run_command').parseArgs({ command: 'echo', args: [1] })).toThrow(z.ZodError);
    expect(() => tool('run_command').parseArgs({ command: 'echo', args: [], extra: true })).toThrow(
      z.ZodError,
    );
  });
});
