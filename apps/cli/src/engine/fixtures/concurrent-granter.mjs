/**
 * One REAL process appending one grant, run twice concurrently by `mcp-consent.test.ts`.
 *
 * [ADR-0084](../../../../../docs/decisions/0084-consent-before-a-local-mcp-spawn.md) §10.13 requires actual
 * processes rather than two calls in one, "because that is the race the protocol exists for": two in-process
 * calls prove only that `appendFileSync` appends, and exercise neither the interleaving `wx`/`EEXIST` create
 * nor the single-write atomicity the no-lock design rests on.
 *
 * Usage: `node --experimental-strip-types concurrent-granter.mjs <store-path> <digest>`
 */

/* global process -- a Node child-process fixture (not TS source); it uses only this Node global. */

import { register } from 'node:module';

register('./ts-resolve-hook.mjs', import.meta.url);

const { appendGrant } = await import('../mcp-consent.ts');

const [storePath, digest] = process.argv.slice(2);
appendGrant(storePath, {
  v: 1,
  digest,
  command: '/usr/bin/true',
  args: [],
  envNames: [],
  cwd: '/w',
  grantedAt: '2026-08-20T00:00:00.000Z',
});
