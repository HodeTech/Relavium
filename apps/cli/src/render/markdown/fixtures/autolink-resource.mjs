import assert from 'node:assert/strict';
import process from 'node:process';
import { wrapTranscript } from '../../tui/chat-projection.ts';
import { MarkdownStream } from '../stream.ts';

const mode = process.argv[2];
assert.ok(mode === 'cold' || mode === 'stream');
// Fixed input, never an unbounded stress loop. The paragraph prefix avoids the
// whole-line HTML fallback so both paths actually validate the malformed target.
const source = 'paragraph <a@' + '.'.repeat(200_000) + '@>';
if (mode === 'cold') {
  // A fresh real assistant entry cannot reuse a completed-entry parse/layout cache.
  const rows = wrapTranscript([{ role: 'assistant', text: source }], 80, true);
  assert.equal(rows.map((row) => row.text).join(''), source);
} else {
  const stream = new MarkdownStream();
  const body = source.slice(0, -1);
  for (let at = 0; at < body.length; at += 1024) stream.append(body.slice(at, at + 1024));
  // Validation is triggered when the actual closer arrives, not just at finish().
  stream.append('>');
  const rows = stream.tail(80, 12);
  assert.ok(
    rows
      .map((row) => row.text)
      .join('')
      .endsWith('@>'),
  );
  assert.equal(stream.sourceTail(), source.slice(-4000));
  assert.equal(stream.finish()[0]?.source, source);
}
process.stdout.write(`autolink resource passed: ${mode}\n`);
