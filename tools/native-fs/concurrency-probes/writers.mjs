// K concurrent writers on one operator home, each doing M sequential new-file writes through the native addon's
// real prepare, stage, publish and release calls. The writers run in one process on separate file descriptions,
// which conflict under `flock` exactly as separate processes do (ADR-0135). Optionally a recovery loop runs
// beside them.
//
//   node tools/native-fs/concurrency-probes/writers.mjs [writers=2] [writesEach=30] [--recover]
//
// Prints one JSON line. With the allocation claim waited for, every write completes (`ok` equals `total`);
// with the claim reduced to one nonblocking attempt about half of the writes of two writers fail at stage
// (`changed:not_needed`) and a few end `possibly_published:uncertain`.
import { Buffer } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { integerArgument, loadAddon, scratchHome } from './addon.mjs';

const writers = integerArgument(2, 2);
const writesEach = integerArgument(3, 30);
const withRecover = process.argv.includes('--recover');
const addon = loadAddon();
const scratch = scratchHome();
const phases = { prepare: 0, stage: 0, publish: 0, release: 0, ok: 0 };
const messages = new Map();
const recoveries = { ok: 0, fail: 0 };
let stopRecovery = false;

function note(phase, error) {
  phases[phase]++;
  const key = `${phase}:${error.message}`;
  messages.set(key, (messages.get(key) ?? 0) + 1);
}

async function recoveryLoop() {
  while (!stopRecovery) {
    try {
      await addon.recoverMetadataStaging(scratch.home, addon.createWriteCancellation());
      recoveries.ok++;
    } catch {
      recoveries.fail++;
    }
  }
}

async function writer(index) {
  for (let round = 0; round < writesEach; round++) {
    const target = join(scratch.destination, `w${index}-${round}.txt`);
    const cancellation = addon.createWriteCancellation();
    let prepared;
    let stage;
    try {
      prepared = await addon.prepareNewMetadata(target, undefined);
    } catch (error) {
      note('prepare', error);
      continue;
    }
    try {
      stage = await addon.stageNewMetadata(
        prepared,
        scratch.home,
        Buffer.from(`w${index}-${round}`),
        randomBytes(16).toString('hex'),
        undefined,
        cancellation,
      );
    } catch (error) {
      note('stage', error);
      continue;
    }
    try {
      await addon.publishMetadata(stage, undefined, cancellation);
    } catch (error) {
      note('publish', error);
    }
    try {
      await addon.releaseMetadataStage(stage);
      if (existsSync(target)) phases.ok++;
    } catch (error) {
      note('release', error);
    }
  }
}

const started = Date.now();
const recovering = withRecover ? recoveryLoop() : Promise.resolve();
await Promise.all(Array.from({ length: writers }, (_, index) => writer(index)));
stopRecovery = true;
await recovering;
const leftover = existsSync(scratch.index) ? readdirSync(scratch.index).length - 1 : 0;
console.log(
  JSON.stringify({
    writers,
    writesEach,
    total: writers * writesEach,
    withRecover,
    phases,
    recoveries,
    ms: Date.now() - started,
    messages: [...messages],
    leftover,
  }),
);
scratch.remove();
