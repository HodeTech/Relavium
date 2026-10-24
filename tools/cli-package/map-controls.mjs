/**
 * Command-line entry point of the product map controls (`map-controls-core.mjs`; `pnpm
 * check:map-controls`): one real production at this checkout, every named control, one JSON summary.
 * It runs unconditionally, so it can never exit 0 without running the controls, and exits 1 unless
 * every expected control ran once with its expected outcome. A failure prints only fixed lines.
 */
import { fileURLToPath } from 'node:url';
import { report, runMapControls } from './map-controls-core.mjs';
import { productionFailure } from './production-failure.mjs';

const started = Date.now();
let outcome;
try {
  outcome = await runMapControls({
    repository: fileURLToPath(new URL('../../', import.meta.url)),
    environment: process.env,
  });
} catch (error) {
  for (const line of productionFailure(error)) console.error(line);
  process.exit(1);
}
process.exitCode = report(outcome, { seconds: Math.round((Date.now() - started) / 1000) });
