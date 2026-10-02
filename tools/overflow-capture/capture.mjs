#!/usr/bin/env node
/** Thin maintainer runner; typed construction/refusal lives in @relavium/llm's adapter zone. */
import { openSync, closeSync, writeFileSync, fstatSync, lstatSync, fsyncSync } from 'node:fs';
import { setTimeout, clearTimeout } from 'node:timers';

import {
  CaptureError,
  captureResponse,
  parseCaptureArguments,
  validateCaptureKey,
  validateCaptureInput,
} from '../../packages/llm/dist/adapters/overflow-capture.js';

const HELP = `Usage: node tools/overflow-capture/capture.mjs --provider <anthropic|openai|deepseek|gemini>
  --model <official-model-id> --input-chars <1024..8388608> --out <new-file.json>
  [--max-output <1..4096>] [--purpose <overflow|context-stop-probe>]

Pipe one API key on stdin (never an argument). One synthetic request; no retries or redirects.
Default output cap: 64. context-stop-probe is Anthropic-only; choose near-window input and output cap.
The capture can be billed if accepted. A captured response is evidence to review, not an overflow verdict.
See tools/overflow-capture/README.md for capture and fixture acceptance.\n`;

async function readKey() {
  if (process.stdin.isTTY) throw new CaptureError('invalid_key');
  process.stdin.setEncoding('utf8');
  const timer = setTimeout(() => process.stdin.destroy(new CaptureError('timeout')), 60_000);
  try {
    let key = '';
    for await (const chunk of process.stdin) {
      if (typeof chunk !== 'string' || key.length + chunk.length > 1024) {
        throw new CaptureError('invalid_key');
      }
      key += chunk;
    }
    key = key.trim();
    validateCaptureKey(key);
    return key;
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    process.stdout.write(HELP);
    return;
  }
  const options = parseCaptureArguments(args);
  const key = await readKey();
  validateCaptureInput(options, key); // Validate metadata/key separation before creating even a filename.
  // Reserve before egress: an existing file, symlink or bad destination must never cause a paid call.
  const fd = openSync(options.out, 'wx', 0o600);
  let identity;
  const caller = new globalThis.AbortController();
  const abort = () => caller.abort();
  process.on('SIGINT', abort);
  process.on('SIGTERM', abort);
  try {
    identity = fstatSync(fd);
    const artifact = await captureResponse(options, key, {
      fetch,
      newAbortController: () => new globalThis.AbortController(),
      setTimer: (ms, fire) => {
        const timer = setTimeout(fire, ms);
        return () => clearTimeout(timer);
      },
      now: () => new Date().toISOString(),
      signal: caller.signal,
    });
    const stillOwnsDestination = () => {
      const current = lstatSync(options.out, { throwIfNoEntry: false });
      return current?.dev === identity.dev && current.ino === identity.ino;
    };
    if (!stillOwnsDestination()) throw new CaptureError('destination_changed');
    writeFileSync(fd, JSON.stringify(artifact, null, 2) + '\n');
    fsyncSync(fd);
    if (!stillOwnsDestination()) throw new CaptureError('destination_changed');
    // No model, path, body, key, headers or arbitrary error text is ever printed.
    process.stdout.write(
      `capture saved (HTTP ${artifact.response.status}); review the fixture before use\n`,
    );
  } finally {
    process.off('SIGINT', abort);
    process.off('SIGTERM', abort);
    // Never delete the caller-selected pathname. A stat comparison followed by unlink is not atomic:
    // another process can replace the path between those operations. A failed capture may retain an
    // empty or partial reserved file; closing our fd cannot remove or overwrite a replacement.
    closeSync(fd);
  }
}

try {
  await main();
} catch (error) {
  const reason = error instanceof CaptureError ? error.code : 'local_io';
  process.stderr.write(
    `overflow capture refused (${reason}); destination may be empty or partial\n`,
  );
  process.exitCode = 1;
}
