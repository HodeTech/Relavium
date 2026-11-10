import process from 'node:process';
import { MarkdownStream } from '../stream.ts';

const repeats = Number(process.argv[2]);
if (!Number.isSafeInteger(repeats) || repeats < 1 || typeof globalThis.gc !== 'function') {
  throw new Error('Expected a positive repetition count and --expose-gc');
}
globalThis.gc();
const before = process.memoryUsage().heapUsed;
const stream = new MarkdownStream();
const source = '*' + 'x'.repeat(4500) + '[a*](url)\t'.repeat(repeats);
for (let at = 0; at < source.length; at += 13) stream.append(source.slice(at, at + 13));
globalThis.gc();
const bytes = process.memoryUsage().heapUsed - before;
// Read the live stream after measuring so GC cannot discard the measured owner.
process.stdout.write(JSON.stringify({ bytes, retained: stream.checkpointWork.retained }));
