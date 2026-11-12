import { describe, expect, it } from 'vitest';
import { diffLines, DiffLimitError } from './line-diff.js';

describe('bounded line diff', () => {
  it('reconstructs exact sources with UTF-16 offsets and endings', async () => {
    const before = '😀a\r\nrepeat\nrepeat\nlast';
    const after = '😀a\r\nrepeat\nnew\nlast!';
    const diff = await diffLines(before, after);
    expect(
      diff.lines
        .filter((op) => op.kind !== 'added')
        .map((op) => before.slice(op.before!.start, op.before!.end))
        .join(''),
    ).toBe(before);
    expect(
      diff.lines
        .filter((op) => op.kind !== 'removed')
        .map((op) => after.slice(op.after!.start, op.after!.end))
        .join(''),
    ).toBe(after);
    expect(diff.lines[0]).toMatchObject({
      kind: 'context',
      text: '😀a',
      ending: 'crlf',
      before: { start: 0, end: 5 },
    });
    expect(diff.stats.afterBytes).toBe(Buffer.byteLength(after));
    expect(diff.stats.beforeBytes).toBe(Buffer.byteLength(before));
  });
  it('distinguishes absent and empty files without synthetic lines', async () => {
    expect(await diffLines(null, '')).toMatchObject({ before: null, lines: [] });
    expect(await diffLines('', '\n')).toMatchObject({
      before: '',
      stats: { addedLines: 1, afterBytes: 1 },
    });
  });
  it('refuses input and adversarial work limits and honors cancellation', async () => {
    await expect(diffLines('x'.repeat(8 * 1024 * 1024 + 1), '')).rejects.toBeInstanceOf(
      DiffLimitError,
    );
    await expect(diffLines('a\n'.repeat(2000), 'b\n'.repeat(2000))).rejects.toBeInstanceOf(
      DiffLimitError,
    );
    await expect(
      diffLines('a', 'b', {
        checkCancelled: () => {
          throw new Error('cancelled');
        },
      }),
    ).rejects.toThrow('cancelled');
  });
});

it('reconstructs every short repeated-line pairing with a minimal edit count', async () => {
  const sources = ['', 'a\n', 'b\n', 'a\na\n', 'a\nb\n', 'b\na\n', 'b\nb\n'];
  for (const before of sources) {
    for (const after of sources) {
      const diff = await diffLines(before, after);
      expect(
        diff.lines
          .filter((line) => line.before !== undefined)
          .map((line) => before.slice(line.before!.start, line.before!.end))
          .join(''),
      ).toBe(before);
      expect(
        diff.lines
          .filter((line) => line.after !== undefined)
          .map((line) => after.slice(line.after!.start, line.after!.end))
          .join(''),
      ).toBe(after);
      const left = before === '' ? [] : before.trimEnd().split('\n');
      const right = after === '' ? [] : after.trimEnd().split('\n');
      const lcs = Array.from({ length: left.length + 1 }, () =>
        Array<number>(right.length + 1).fill(0),
      );
      for (let i = 1; i <= left.length; i++)
        for (let j = 1; j <= right.length; j++) {
          lcs[i]![j] =
            left[i - 1] === right[j - 1]
              ? lcs[i - 1]![j - 1]! + 1
              : Math.max(lcs[i - 1]![j]!, lcs[i]![j - 1]!);
        }
      expect(diff.stats.addedLines + diff.stats.removedLines).toBe(
        left.length + right.length - 2 * lcs[left.length]![right.length]!,
      );
      expect(Object.isFrozen(diff.lines)).toBe(true);
    }
  }
});
