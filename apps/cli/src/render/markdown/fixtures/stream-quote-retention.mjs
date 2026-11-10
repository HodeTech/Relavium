import assert from 'node:assert/strict';
import process from 'node:process';
import { layoutMarkdown } from '../layout.js';
import { parseMarkdown } from '../parser.js';
import { MarkdownStream } from '../stream.js';

const count = Number(process.argv[2] ?? 500);
assert.ok([300, 500, 600, 900].includes(count));
const cadence = count === 600 ? 2 : count === 900 ? 3 : 1;
const stream = new MarkdownStream();
const line = '> x *a*\tvalue\n';
for (let at = 0; at < count; at++) {
  stream.append(line);
  if ((at + 1) % cadence === 0) stream.tail(80, 8);
}
const source = line.repeat(count);
// Check causal resource bounds before geometry comparisons or new diagnostic
// fields, so the pre-fix full-prefix retention bug fails for its actual work.
assert.ok(stream.checkpointWork.decisions < count * 6);
assert.ok(stream.checkpointWork.retained < count * 6);
assert.ok(stream.checkpointWork.copied < count * 6);
const expected = layoutMarkdown(parseMarkdown(source), 100_000);
const actual = stream.tail(100_000, 8);
assert.deepEqual(actual.at(-1), expected.at(-1));
assert.ok(
  expected
    .map((row) => row.text)
    .join('')
    .endsWith(
      actual
        .map((row) => row.text)
        .join('')
        .slice(2),
    ),
);
assert.ok(stream.checkpointWork.indexed < source.length * 64);
assert.ok(stream.checkpointWork.indexRetained < source.length * 2);
assert.ok(stream.checkpointWork.cache < count * 6000);
assert.ok(stream.geometryWork.measuredUnits < source.length * 2);
assert.ok(stream.geometryWork.sourceUnits < source.length * 8);
// Each draw may traverse its bounded 4,000-unit visible source window.
assert.ok(stream.geometryWork.visits < count * 4000 * 8);
assert.ok(stream.geometryWork.constructedUnits < count * 4000 * 32);
assert.ok(stream.geometryWork.cacheKeyUnits < count * 4000 * 8);
assert.equal(stream.sourceTail(), source.slice(-4000));
const before = stream.tail(80, 8);
stream.tail(40, 8);
assert.deepEqual(stream.tail(80, 8), before);
globalThis.gc?.();
assert.ok(process.memoryUsage().heapUsed < 128 * 1024 * 1024);
process.stdout.write(`quote retention passed: ${count}\n`);
