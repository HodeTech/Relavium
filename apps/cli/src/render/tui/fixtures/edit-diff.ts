import type { ToolPreview } from '@relavium/core';

/**
 * A replacement of some lines of an LF file, as the engine's line diff delivers it (context lines with both spans,
 * a removed line then its added line for each edit) — built by hand so a review test needs no engine. Line `n` of
 * the original reads `line n`; `edits` maps a 1-based line number to its new text.
 */
export function editedFilePreview(
  lines: number,
  edits: Readonly<Record<number, string>>,
  target = 'src/app.ts',
): ToolPreview {
  const before = Array.from({ length: lines }, (_, index) => `line ${index + 1}`);
  const after = before.map((text, index) => edits[index + 1] ?? text);
  const sides = { before: 0, after: 0 };
  const span = (side: 'before' | 'after', line: number, text: string) => {
    const start = sides[side];
    sides[side] += text.length + 1;
    return { line, start, end: sides[side] };
  };
  const diffLines: NonNullable<ToolPreview['diff']>['lines'][number][] = [];
  let changed = 0;
  before.forEach((text, index) => {
    const replacement = after[index] ?? text;
    if (replacement === text) {
      diffLines.push({
        kind: 'context',
        text,
        ending: 'lf',
        before: span('before', index + 1, text),
        after: span('after', index + 1, text),
      });
      return;
    }
    changed++;
    diffLines.push({
      kind: 'removed',
      text,
      ending: 'lf',
      before: span('before', index + 1, text),
    });
    diffLines.push({
      kind: 'added',
      text: replacement,
      ending: 'lf',
      after: span('after', index + 1, replacement),
    });
  });
  const bytes = (rows: readonly string[]): number =>
    new TextEncoder().encode(`${rows.join('\n')}\n`).byteLength;
  return {
    kind: 'operation',
    target,
    fields: [],
    diff: {
      before: `${before.join('\n')}\n`,
      after: `${after.join('\n')}\n`,
      beforeEndings: 'lf',
      afterEndings: 'lf',
      stats: {
        addedLines: changed,
        removedLines: changed,
        beforeBytes: bytes(before),
        afterBytes: bytes(after),
      },
      lines: diffLines,
    },
  };
}
