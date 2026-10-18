/** Inert, source-pinned editor child: readiness and release replace a scheduling-dependent sleep. */
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { clearInterval, clearTimeout, setInterval, setTimeout } from 'node:timers';

const marker = process.argv[2];
const release = process.argv[3];
if (marker === undefined || release === undefined) throw new Error('Missing editor fixture paths');
writeFileSync(marker, 'ready\n');
const watchdog = setTimeout(() => {
  appendFileSync(marker, 'watchdog\n');
  clearInterval(poll);
  process.exitCode = 2;
}, 5000);
const poll = setInterval(() => {
  if (!existsSync(release)) return;
  clearTimeout(watchdog);
  clearInterval(poll);
  appendFileSync(marker, 'released\n');
}, 5);
