/**
 * Tooling-only preload for symbolication (ADR-0111, Step 9a.2a; the 2026-10-24 frame ruling). It runs
 * with `node --import` around the packed CLI while it imports a canary workflow, and adds no product
 * surface: the packed bytes are untouched. It wraps the external `yaml` package's `parse` — the one
 * instance the CLI's import and require both reach — and records V8's structured call sites for the
 * canary document alone, so one synchronous stack crosses the CLI and the inlined `@relavium/core`. It
 * writes one owner-only record when the process exits; the producer refuses unless exactly one stack
 * was captured. The keyring binding is replaced by a refusing module, no module may resolve outside
 * the candidate (frame-capture-hooks.mjs), and any native module load refuses.
 */
import { closeSync, openSync, realpathSync, writeSync } from 'node:fs';
import { createRequire, registerHooks } from 'node:module';
import { dirname, resolve } from 'node:path';
import { confinedResolve } from './frame-capture-hooks.mjs';

const log = process.env.RELAVIUM_FRAME_CAPTURE_LOG;
const manifest = process.env.RELAVIUM_FRAME_CAPTURE_PACKAGE;
const canary = process.env.RELAVIUM_FRAME_CAPTURE_CANARY;
if (!log || !manifest || !canary) throw new Error('The symbolication preload is not configured');
if (typeof registerHooks !== 'function') {
  throw new Error('The symbolication preload needs module.registerHooks');
}

// The candidate root holds `apps/cli/package.json`; pnpm installs the CLI's dependencies below it.
registerHooks({
  resolve: confinedResolve(realpathSync.native(resolve(dirname(manifest), '..', '..'))),
});
// The import route needs no native module; any addon load refuses instead of running native code
// beside the private staging.
process.dlopen = () => {
  throw new Error('The symbolication run refuses native modules');
};

/** @type {{file: string | null, line: number | null, column: number | null, async: boolean}[][]} */
const captures = [];

/** Structured call sites above `skip`, with the stack trace limit and formatter restored after. */
function callSites(skip) {
  const prepare = Error.prepareStackTrace;
  const limit = Error.stackTraceLimit;
  try {
    Error.stackTraceLimit = 64;
    Error.prepareStackTrace = (_error, sites) => sites;
    const holder = {};
    Error.captureStackTrace(holder, skip);
    return holder.stack.map((site) => ({
      file: site.getFileName() ?? null,
      line: site.getLineNumber(),
      column: site.getColumnNumber(),
      async: site.isAsync(),
    }));
  } finally {
    Error.prepareStackTrace = prepare;
    Error.stackTraceLimit = limit;
  }
}

const yaml = createRequire(manifest)('yaml');
const parse = yaml.parse;
if (typeof parse !== 'function') throw new Error('The yaml package has no parse export');
yaml.parse = function capturedParse(text, ...rest) {
  if (typeof text === 'string' && text.includes(canary)) captures.push(callSites(capturedParse));
  return Reflect.apply(parse, this, [text, ...rest]);
};

process.on('exit', () => {
  const descriptor = openSync(log, 'wx', 0o600);
  try {
    writeSync(descriptor, JSON.stringify({ version: 1, captures }));
  } finally {
    closeSync(descriptor);
  }
});
