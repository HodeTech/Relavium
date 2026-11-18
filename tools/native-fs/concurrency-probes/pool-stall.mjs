// What a claim that another process holds and never lets go does to unrelated async work in this process:
// N writers wait for the allocation claim, and 200 ms later an `fs.stat`, a `dns.lookup` and a
// `crypto.randomBytes` are timed (ADR-0135). Every native call runs on Node's shared worker pool, which serves
// those too. The holder is a small `perl` process (POSIX only).
//
//   node tools/native-fs/concurrency-probes/pool-stall.mjs [writers=4]
//
// Measured on macOS with the default pool of four: 0 ms with up to four writers, about 0.1 s with six and
// about 0.3 s with eight; the first version of the wait, with no waiter limit, stalled them 1.8 s with four
// writers and 3.8 s with eight.
import { spawn } from 'node:child_process';
import { Buffer } from 'node:buffer';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { lookup } from 'node:dns';
import { join } from 'node:path';
import { stat } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { integerArgument, loadAddon, scratchHome } from './addon.mjs';

const writers = integerArgument(2, 4);
const addon = loadAddon();
const scratch = scratchHome();

async function oneWrite(name) {
  const cancellation = addon.createWriteCancellation();
  const prepared = await addon.prepareNewMetadata(join(scratch.destination, name), undefined);
  const stage = await addon.stageNewMetadata(
    prepared,
    scratch.home,
    Buffer.from(name),
    randomBytes(16).toString('hex'),
    undefined,
    cancellation,
  );
  await addon.publishMetadata(stage, undefined, cancellation);
  await addon.releaseMetadataStage(stage);
}

function holdClaim(lockPath) {
  const program =
    'use Fcntl ":flock"; open(F,"+<",$ARGV[0]) or die; flock(F,LOCK_EX) or die; $|=1; print "HELD\\n"; sleep(120);';
  return new Promise((resolve, reject) => {
    const child = spawn('perl', ['-e', program, lockPath], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    child.stdout.once('data', () => resolve(child));
    child.once('error', reject);
  });
}

async function timeUnrelatedWork() {
  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  const [fsStat, dnsLookup, cryptoBytes] = await Promise.all([
    stat('/').then(elapsed),
    new Promise((resolve) => lookup('localhost', () => resolve(elapsed()))),
    new Promise((resolve) => randomBytes(16, () => resolve(elapsed()))),
  ]);
  return { fsStat, dnsLookup, cryptoBytes };
}

await oneWrite('warm-up'); // creates the index and its lock file
const holder = await holdClaim(join(scratch.index, 'inventory.lock'));
const began = Date.now();
const settled = Array.from({ length: writers }, (_, index) => {
  const started = Date.now();
  return oneWrite(`writer-${index}`).then(
    () => `writer ${index}: ok after ${Date.now() - started} ms`,
    (error) => `writer ${index}: refused after ${Date.now() - started} ms (${error.message})`,
  );
});
await delay(200);
console.log(JSON.stringify({ writers, unrelatedAsyncWorkMs: await timeUnrelatedWork() }));
for (const line of await Promise.all(settled)) console.log(line);
console.log(`all writers settled after ${Date.now() - began} ms`);
holder.kill('SIGKILL');
scratch.remove();
