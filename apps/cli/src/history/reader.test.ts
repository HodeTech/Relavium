import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { DbOpenError } from '@relavium/db';
import { openHistoryReader } from './reader.js';
import { openSessionStore } from './session-open.js';
import { openLocalDb } from '../db/open.js';
import { globalConfigDir } from '../config/paths.js';
import { CLI_ERROR_POLICY } from '../process/cli-error.js';
import { toUserFacing } from '../process/errors.js';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'relavium-history-origins-'));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

for (const [name, open] of [
  ['reader', openHistoryReader],
  ['session', openSessionStore],
  ['local', openLocalDb],
] as const) {
  it(`${name}: projects actual corrupt DB setup to fixed storage 1`, () => {
    mkdirSync(globalConfigDir(home));
    writeFileSync(join(globalConfigDir(home), 'history.db'), 'PRIVATE_CORRUPT_DB_BYTES');
    let failure: unknown;
    try {
      open(home);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'storage_unavailable', exitCode: 1 });
    expect(toUserFacing(failure).message).toBe(CLI_ERROR_POLICY.storage_unavailable.fixedMessage);
    expect(JSON.stringify(toUserFacing(failure))).not.toContain(home);
    expect(JSON.stringify(toUserFacing(failure))).not.toContain('PRIVATE_');
  });
}

it.each([
  Object.assign(new Error('PRIVATE_FOREIGN_ERRNO'), { code: 'EACCES' }),
  new DbOpenError('open_failed', 'PRIVATE_ADDON_ABI', '/PRIVATE_PATH', {
    cause: Object.assign(new Error('PRIVATE_CAUSE'), { code: 'ERR_DLOPEN_FAILED' }),
  }),
])('reader: injected opener cannot manufacture storage provenance', (cause) => {
  let failure: unknown;
  try {
    openHistoryReader(home, () => {
      throw cause;
    });
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'cli_internal', exitCode: 9, cause });
  expect(toUserFacing(failure).message).toBe(CLI_ERROR_POLICY.cli_internal.fixedMessage);
});
