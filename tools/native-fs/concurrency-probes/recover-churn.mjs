// Recovery passes against an index that a lock-less churner keeps changing: the churner creates and removes
// `.reserved` entries, which is what a producer's pin does to its reservation without holding any claim
// (ADR-0135). A scan that lists such an entry and then finds it gone must skip it, not call the index changed.
//
//   node tools/native-fs/concurrency-probes/recover-churn.mjs [fillers=120] [passes=200] [--no-churn]
//
// Prints one JSON line. With the scan fixed every pass succeeds (`fail` is 0); with the old scan about half of
// the passes fail under churn, and none fail with `--no-churn`.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { closeSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { integerArgument, loadAddon, scratchHome } from './addon.mjs';

const reservation = () => `${randomBytes(16).toString('hex')}.reserved`;

if (!isMainThread) {
  const end = Date.now() + workerData.ms;
  let announced = false;
  while (Date.now() < end) {
    const path = join(workerData.index, reservation());
    closeSync(openSync(path, 'wx', 0o600));
    unlinkSync(path);
    if (!announced) {
      // The first completed create and remove: from here on the index really is churning.
      parentPort.postMessage('churning');
      announced = true;
    }
  }
  process.exit(0);
}

const fillers = integerArgument(2, 120);
const passes = integerArgument(3, 200);
const churn = !process.argv.includes('--no-churn');
const addon = loadAddon();
const scratch = scratchHome();
// One genuine write builds the real index hierarchy.
const seed = await addon.prepareNewMetadata(join(scratch.destination, 'seed.txt'), undefined);
const cancellation = addon.createWriteCancellation();
const stage = await addon.stageNewMetadata(
  seed,
  scratch.home,
  Buffer.from('seed'),
  'b'.repeat(32),
  undefined,
  cancellation,
);
await addon.publishMetadata(stage, undefined, cancellation);
await addon.releaseMetadataStage(stage);
for (let index = 0; index < fillers; index++)
  closeSync(openSync(join(scratch.index, reservation()), 'wx', 0o600));
const worker = churn
  ? new Worker(fileURLToPath(import.meta.url), {
      workerData: { index: scratch.index, ms: 60_000 },
    })
  : undefined;
// Worker start-up takes time: do not count recovery passes that ran before the churn began.
if (worker) await once(worker, 'message');
let ok = 0;
let fail = 0;
const messages = new Map();
let last;
for (let pass = 0; pass < passes; pass++) {
  try {
    last = await addon.recoverMetadataStaging(scratch.home, addon.createWriteCancellation());
    ok++;
  } catch (error) {
    fail++;
    messages.set(error.message, (messages.get(error.message) ?? 0) + 1);
  }
}
await worker?.terminate();
console.log(JSON.stringify({ fillers, passes, churn, ok, fail, messages: [...messages], last }));
scratch.remove();
