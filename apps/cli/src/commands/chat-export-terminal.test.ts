import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scriptedResolver, textTurn } from '../chat/test-support.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatCommand, driveJson, drivePlain } from './chat.js';

/**
 * A REPL command's output on the plain and `--json` drivers goes straight to the terminal's stderr, so it gets the
 * control floor the full-screen view's notice applies. `/export` reads the project configuration, and a refusal
 * names what it could not read: a project file's keys are text this process did not author.
 */

const HOME_ENV_VARS = ['HOME', 'USERPROFILE'] as const;

function globalOptions(cwd: string, json: boolean): GlobalOptions {
  return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

describe('/export output on the plain and --json drivers', () => {
  let client: DbClient;
  let cwd: string;
  let home: string;
  const savedHome = new Map<string, string | undefined>();

  beforeEach(() => {
    cwd = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-export-terminal-cwd-')));
    home = mkdtempSync(join(tmpdir(), 'relavium-export-terminal-home-'));
    for (const v of HOME_ENV_VARS) {
      savedHome.set(v, process.env[v]);
      process.env[v] = home;
    }
    client = createClient(':memory:');
    runMigrations(client.db);
  });
  afterEach(() => {
    client.sqlite.close();
    for (const v of HOME_ENV_VARS) {
      const prev = savedHome.get(v);
      if (prev === undefined) delete process.env[v];
      else process.env[v] = prev;
    }
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it.each([
    { mode: 'plain', json: false },
    { mode: 'json', json: true },
  ])(
    'strips terminal controls from a refusal that names a project file key ($mode)',
    async ({ json }) => {
      const projectToml = join(cwd, '.relavium', 'project.toml');
      mkdirSync(join(cwd, '.relavium'), { recursive: true });
      writeFileSync(projectToml, '[defaults]\nmax_tokens_estimate = 17\n');
      // Valid when the chat starts (an invalid one is refused there); replaced before `/export`, as a checkout of
      // another branch would, with a quoted key holding a title change, a bell and a screen clear.
      function* lines(): Generator<string> {
        yield 'hello\n';
        writeFileSync(projectToml, '[defaults]\n"\\u001b]0;PWNED\\u0007\\u001b[2J" = 1\n');
        yield '/export\n';
      }
      const { io, err } = captureIo();
      let tick = Date.parse('2026-11-05T00:00:00.000Z');
      let id = 0;
      const store = createSessionStore(client.db);
      await chatCommand(
        { agent: undefined },
        {
          io: { ...io, stdin: Readable.from(lines()) },
          global: globalOptions(cwd, json),
          providers: scriptedResolver([textTurn('hi there')]),
          openSessionStore: () => ({ store, db: client.db, close: () => undefined }),
          drive: json ? driveJson : drivePlain,
          now: () => tick++,
          uuid: () => `id-${id++}`,
        },
      );
      const refusal = err()
        .split('\n')
        .find((line) => line.startsWith('export failed:'));
      expect(refusal).toContain('unknown key(s)');
      expect(err().replaceAll('\n', '')).not.toMatch(/\p{Cc}/u);
    },
  );
});
