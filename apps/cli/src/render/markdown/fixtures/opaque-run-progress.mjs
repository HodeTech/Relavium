import assert from 'node:assert/strict';
import process from 'node:process';
import { layoutMarkdown } from '../layout.ts';
import { parseMarkdown } from '../parser.ts';
import { MarkdownStream } from '../stream.ts';

const mode = process.argv[2];
assert.ok(mode === 'whole' || mode === 'split');
for (const count of [1, 2, 3, 16, 1024]) {
  const ticks = '`'.repeat(count);
  for (const suffix of ['](', '](url) ' + ticks + 'tail' + ticks]) {
    const source = '[\\' + ticks + suffix;
    const stream = new MarkdownStream();
    if (mode === 'whole') stream.append(source);
    else {
      for (const unit of source) stream.append(unit);
    }
    assert.deepEqual(stream.tail(100_000, 12), layoutMarkdown(parseMarkdown(source), 100_000));
    assert.equal(stream.sourceTail(), source);
    assert.deepEqual(stream.finish(), parseMarkdown(source));
    // Literal escaped runs must not be rescanned as each adjacent tick arrives.
    assert.ok(stream.checkpointWork.indexed < source.length * 350);
  }
}
process.stdout.write(`opaque run progress passed: ${mode}\n`);
