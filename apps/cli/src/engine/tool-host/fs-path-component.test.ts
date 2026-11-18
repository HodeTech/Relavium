import { expect, it } from 'vitest';
import { foldPathComponent } from './fs-path-component.js';

it.each([
  ['.RELAVIUM. .:stream', '.relavium'],
  ['file::$DATA', 'file'],
  [':stream', ''],
  ['C:', 'c'],
  ['A\u00a0', 'a\u00a0'],
  ['İ. ', 'i\u0307'],
  ['...   ', ''],
  ['ordinary', 'ordinary'],
])('preserves filesystem policy folding for %s', (source, expected) => {
  expect(foldPathComponent(source)).toBe(expected);
});

it.each([' ', '.'])(
  'bounds normalization work for a 64 KiB %s prefix before a non-suffix character',
  (fill) => {
    const source = `${fill.repeat(64 * 1024 - 1)}X`;
    const start = performance.now();
    const result = foldPathComponent(source);
    const elapsed = performance.now() - start;
    expect(result).toBe(`${fill.repeat(64 * 1024 - 1)}x`);
    // This pure string operation needs no I/O; allow ample scheduling headroom over its linear work.
    expect(elapsed, 'MVP3_STAGE_COMPONENT_LINEAR').toBeLessThan(500);
  },
);
