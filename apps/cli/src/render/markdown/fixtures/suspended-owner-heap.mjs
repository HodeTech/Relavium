import process from 'node:process';
import { MarkdownStream } from '../stream.ts';

const repeats = Number(process.argv[2]);
if (!Number.isSafeInteger(repeats) || repeats < 1 || typeof globalThis.gc !== 'function') {
  throw new Error('Expected a positive repetition count and --expose-gc');
}
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const stream = new MarkdownStream();
const source = '**' + 'a* [c](u/**r**)'.repeat(repeats);
for (let at = 0; at < source.length; at += 7) stream.append(source.slice(at, at + 7));
globalThis.gc();
const bytes = process.memoryUsage().heapUsed - before;
process.stdout.write(JSON.stringify({ bytes, retained: stream.checkpointWork.retained }));
