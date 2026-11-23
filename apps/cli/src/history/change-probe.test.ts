/**
 * The change token of the Home's polls ([ADR-0140](../../../../docs/decisions/0140-management-browsers-the-run-drill-down-and-the-durable-run-detail.md)
 * §2): the pair (`PRAGMA data_version`, an in-process generation). Three claims: a token with nothing between two reads is the same token
 * (so a poll that compares them reads nothing), `bump()` always makes a different one, and `data_version` moves when ANOTHER connection
 * commits but not for the connection's own write, which is why the generation exists at all. The last claim needs two connections to one
 * file, so it uses a file under a temporary directory; every other test in this file needs no database.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createChangeProbe, dataVersionOf, tokensEqual } from './change-probe.js';

describe('the token is a value', () => {
  it('two reads with nothing between them are the same token, so a poll that compares them reads nothing', () => {
    const probe = createChangeProbe(() => 7);
    const first = probe.token();
    const second = probe.token();
    expect(first).toEqual({ dataVersion: 7, generation: 0 });
    expect(tokensEqual(first, second)).toBe(true);
  });

  it('is never equal to a missing token, so the first read always happens', () => {
    const token = createChangeProbe(() => 1).token();
    expect(tokensEqual(undefined, token)).toBe(false);
    expect(tokensEqual(token, undefined)).toBe(false);
    expect(tokensEqual(undefined, undefined)).toBe(false);
  });
});

describe('bump', () => {
  it('makes the next token differ from every earlier one, whatever data_version says', () => {
    const probe = createChangeProbe(() => 3);
    const before = probe.token();
    probe.bump();
    const after = probe.token();
    expect(tokensEqual(before, after)).toBe(false);
    expect(after.dataVersion).toBe(before.dataVersion);
    expect(after.generation).toBe(before.generation + 1);
    probe.bump();
    expect(tokensEqual(after, probe.token())).toBe(false);
  });

  it('is not a read: the version is asked for again at every token, never kept', () => {
    let version = 1;
    const probe = createChangeProbe(() => version);
    const before = probe.token();
    version = 2;
    expect(tokensEqual(before, probe.token())).toBe(false);
  });
});

describe('PRAGMA data_version, over two connections to one file', () => {
  let dir: string;
  let mine: DbClient;
  let theirs: DbClient;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'relavium-change-probe-'));
    const path = join(dir, 'history.db');
    mine = createClient(path);
    // A scratch table is all a write needs: the probe asks the file, not the schema.
    mine.sqlite.exec('CREATE TABLE scratch (id TEXT PRIMARY KEY)');
    theirs = createClient(path);
  });
  afterEach(() => {
    mine.sqlite.close();
    theirs.sqlite.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (client: DbClient, id: string): void => {
    client.sqlite.prepare('INSERT INTO scratch (id) VALUES (?)').run(id);
  };

  it('moves when another connection commits, and the probe sees it', () => {
    const probe = createChangeProbe(dataVersionOf(mine.db));
    const before = probe.token();
    write(theirs, 'w1');
    const after = probe.token();
    expect(after.dataVersion).not.toBe(before.dataVersion);
    expect(tokensEqual(before, after)).toBe(false);
  });

  it('does not move for the connection’s own write: that is what the generation is for', () => {
    const probe = createChangeProbe(dataVersionOf(mine.db));
    const before = probe.token();
    write(mine, 'w2');
    const own = probe.token();
    expect(own.dataVersion, 'the same connection’s write leaves data_version alone').toBe(
      before.dataVersion,
    );
    expect(tokensEqual(before, own), 'so, without a bump, the token would miss it').toBe(true);
    probe.bump();
    expect(tokensEqual(before, probe.token()), 'a bump from the event reader is seen').toBe(false);
  });

  it('is the same while nobody writes', () => {
    const probe = createChangeProbe(dataVersionOf(mine.db));
    const before = probe.token();
    expect(tokensEqual(before, probe.token())).toBe(true);
  });

  it('throws for a closed handle, which is how a poll learns to stop', () => {
    const closing = createClient(join(dir, 'closing.db'));
    const read = dataVersionOf(closing.db);
    expect(typeof read()).toBe('number');
    closing.sqlite.close();
    expect(() => read()).toThrow();
  });
});
