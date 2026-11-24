/**
 * What `import`, `create`, `export` and `chat-export` say and do about PATHS (PR #102 review H2, H3 and the P2 rows on success lines):
 *
 * - each command reads the operator home it is HANDED (the program hands none and the command resolves the process's own, once, at its
 *   boundary), so a test or a caller that names a home gets that home's rules and never the real one;
 * - `export --out` is the person's own selection and keeps the contract the reference gives it (an explicit path is no automatic
 *   target), but it shares every write's final-component rule: a link or a special file there is refused (`write-authored-file.test.ts`
 *   holds that rule's cases);
 * - the success lines print a destination spelled from directory names under the project, which a link inside the project can make
 *   anything, so they print it through the terminal floor.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CreatePrompter, CreateSpec } from '../authoring/authoring.js';
import { PROJECT_DIRECTORY_REMEDY } from '../config/project-directory.js';
import type { OpenedSessionStore } from '../history/session-open.js';
import { isCliError } from '../process/errors.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo } from '../test-support.js';
import { chatExportCommand } from './chat-export.js';
import { createCommand } from './create.js';
import { exportCommand } from './export.js';
import { importCommand } from './import.js';

const AGENT = `id: reviewer
provider: anthropic
model: claude-sonnet-4-6
system_prompt: Review the code.
`;
const AGENT_CANONICAL =
  'id: reviewer\nmodel: claude-sonnet-4-6\nprovider: anthropic\nsystem_prompt: Review the code.\n';
const SPEC: CreateSpec = {
  kind: 'agent',
  name: 'Reviewer',
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  systemPrompt: 'Review the code.',
  tools: [],
};
const prompter = (): CreatePrompter => ({ gather: () => Promise.resolve(SPEC) });

/** Whatever a terminal would act on: ESC, the other C0/C1 controls, and the bidirectional overrides and isolates. */
// eslint-disable-next-line no-control-regex
const TERMINAL_ACTIVE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
/** A directory name that carries a colour escape, a title-change introducer and a right-to-left override. */
const HOSTILE = 'evil\u001b[31m\u001b]0;pwned\u0007‮gpj';

let root = '';
let project = '';
let home = '';
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'relavium-authored-paths-')));
  project = join(root, 'project');
  home = join(root, 'home');
  mkdirSync(join(project, '.relavium'), { recursive: true });
  mkdirSync(join(home, '.relavium'), { recursive: true });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const global = (cwd: string, json = false): GlobalOptions => ({
  json,
  color: false,
  cwd,
  configPath: undefined,
  verbosity: 'normal',
});

async function refusalOf(run: () => unknown): Promise<string | undefined> {
  try {
    await run();
    return undefined;
  } catch (cause) {
    if (!isCliError(cause)) throw cause;
    return cause.message;
  }
}

describe('each command reads the home it is handed, never the process’s own', () => {
  // The working directory IS the handed home: global state, so every command refuses it in the rule's own words. With the process's
  // own home (a temporary one here, not this directory) nothing would refuse, so a command that ignored what it was handed fails.
  it('import', async () => {
    writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
    const { io, out } = captureIo();
    expect(
      await refusalOf(() =>
        importCommand(
          { path: 'incoming.agent.yaml', force: false },
          { io, global: global(project), homeDir: project },
        ),
      ),
    ).toBe(PROJECT_DIRECTORY_REMEDY);
    expect(out()).toBe('');
    expect(readdirSync(join(project, '.relavium'))).toEqual([]);
  });

  it('export', async () => {
    mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
    writeFileSync(join(project, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
    const { io, out } = captureIo();
    expect(
      await refusalOf(() =>
        exportCommand(
          { id: 'reviewer', force: false },
          { io, global: global(project), homeDir: project },
        ),
      ),
    ).toBe(PROJECT_DIRECTORY_REMEDY);
    expect(out()).toBe('');
    expect(existsSync(join(project, 'reviewer.agent.yaml'))).toBe(false);
  });

  it('create: refused before the wizard asks anything', async () => {
    let asked = false;
    const spy: CreatePrompter = {
      gather: () => {
        asked = true;
        return Promise.resolve(SPEC);
      },
    };
    const { io } = captureIo();
    expect(
      await refusalOf(() =>
        createCommand(
          { force: false },
          { io, global: global(project), prompter: spy, homeDir: project },
        ),
      ),
    ).toBe(PROJECT_DIRECTORY_REMEDY);
    expect(asked, 'the person was not asked for answers a refusal would discard').toBe(false);
    expect(readdirSync(join(project, '.relavium'))).toEqual([]);
  });
});

describe('export --out is the person’s own selection, and keeps its reference contract', () => {
  // docs/reference/cli/commands.md: "Explicit `--config` and `--out` paths retain their selected-file contracts; this automatic
  // boundary does not revoke those deliberate selections" (the boundary is the rule about home and global state). These cases pin
  // that reading, so a change to it is a decision and not an accident.
  beforeEach(() => {
    mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
    writeFileSync(join(project, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
  });

  it('an explicit --out may name a file under the global directory, or outside the working directory', () => {
    const { io } = captureIo();
    exportCommand(
      { id: 'reviewer', out: join(home, '.relavium', 'copy.agent.yaml'), force: false },
      { io, global: global(project), homeDir: home },
    );
    expect(readFileSync(join(home, '.relavium', 'copy.agent.yaml'), 'utf8')).toBe(AGENT_CANONICAL);
    exportCommand(
      { id: 'reviewer', out: '../elsewhere.agent.yaml', force: false },
      { io, global: global(project), homeDir: home },
    );
    expect(readFileSync(join(root, 'elsewhere.agent.yaml'), 'utf8')).toBe(AGENT_CANONICAL);
  });

  it('the DEFAULT destination keeps the rule about global state: a link at it that leads into global configuration is refused, nothing written', () => {
    if (process.platform === 'win32') return;
    const inGlobal = join(home, '.relavium', 'victim.agent.yaml');
    writeFileSync(inGlobal, 'precious\n');
    symlinkSync(inGlobal, join(project, 'reviewer.agent.yaml'));
    const { io, out } = captureIo();
    for (const force of [false, true]) {
      expect(
        (() => {
          try {
            exportCommand(
              { id: 'reviewer', force },
              { io, global: global(project), homeDir: home },
            );
            return undefined;
          } catch (cause) {
            return isCliError(cause) ? cause.message : String(cause);
          }
        })(),
        `force=${String(force)}`,
      ).toBe(
        'The project artifact resolves into home or global configuration. Use a project-owned path and remove links into global state.',
      );
    }
    expect(readFileSync(inGlobal, 'utf8')).toBe('precious\n');
    expect(out()).toBe('');
  });
});

describe.skipIf(process.platform === 'win32')(
  'a destination spelled from a link’s directory name reaches the terminal without controls',
  () => {
    /** `.relavium/agents` is a link to a directory INSIDE the project whose name is hostile: the link is followed and the name is shown. */
    function linkAgentsToHostileDirectory(): void {
      mkdirSync(join(project, '.relavium', HOSTILE), { recursive: true });
      symlinkSync(join(project, '.relavium', HOSTILE), join(project, '.relavium', 'agents'));
    }

    it('import: the success line is one row with no controls, and the file is where the name says', () => {
      linkAgentsToHostileDirectory();
      writeFileSync(join(project, 'incoming.agent.yaml'), AGENT);
      const { io, out, err } = captureIo();
      importCommand(
        { path: 'incoming.agent.yaml', force: false },
        { io, global: global(project), homeDir: home },
      );
      expect(readFileSync(join(project, '.relavium', HOSTILE, 'reviewer.agent.yaml'), 'utf8')).toBe(
        AGENT_CANONICAL,
      );
      expect(out()).not.toMatch(TERMINAL_ACTIVE);
      expect(out()).toMatch(
        /^Imported agent 'reviewer' to \.relavium\/evil.*reviewer\.agent\.yaml\n$/u,
      );
      expect(err()).not.toMatch(TERMINAL_ACTIVE);
    });

    it('create: the success line is one row with no controls', async () => {
      linkAgentsToHostileDirectory();
      const { io, out } = captureIo();
      await createCommand(
        { force: false },
        { io, global: global(project), prompter: prompter(), homeDir: home },
      );
      expect(existsSync(join(project, '.relavium', HOSTILE, 'reviewer.agent.yaml'))).toBe(true);
      expect(out()).not.toMatch(TERMINAL_ACTIVE);
      expect(out()).toMatch(
        /^Created agent 'reviewer' at \.relavium\/evil.*reviewer\.agent\.yaml\n$/u,
      );
    });

    it('export --out: the success line is one row with no controls, a tab or a line feed folded to a space', () => {
      mkdirSync(join(project, '.relavium', 'agents'), { recursive: true });
      writeFileSync(join(project, '.relavium', 'agents', 'reviewer.agent.yaml'), AGENT);
      const { io, out } = captureIo();
      exportCommand(
        { id: 'reviewer', out: `a\nb\t${HOSTILE}.agent.yaml`, force: false },
        { io, global: global(project), homeDir: home },
      );
      expect(out()).not.toMatch(TERMINAL_ACTIVE);
      expect(out().match(/\n/gu)?.length, 'one row').toBe(1);
      expect(out()).not.toContain('\t');
    });
  },
);

describe.skipIf(process.platform === 'win32')(
  'chat-export prints the path it wrote without terminal controls',
  () => {
    let client: DbClient;
    let opened: OpenedSessionStore;
    beforeEach(() => {
      client = createClient(':memory:');
      runMigrations(client.db);
      const store = createSessionStore(client.db);
      store.createSession({
        id: 's1',
        agentSlug: 'coder',
        title: 'My Session',
        context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
        status: 'active',
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCostMicrocents: 0,
        totalConservativeMicrocents: 0,
        createdAt: '2026-06-25T00:00:00.000Z',
        updatedAt: '2026-06-25T00:00:00.000Z',
      });
      opened = { store, db: client.db, close: () => undefined };
    });
    afterEach(() => {
      client.sqlite.close();
    });

    it.each([
      { json: false, label: 'human' },
      { json: true, label: 'json' },
    ])('the $label line and the note about a session with no stored agent', ({ json }) => {
      const { io, out, err } = captureIo();
      chatExportCommand(
        { sessionId: 's1', out: `${HOSTILE}.relavium.yaml`, force: false },
        {
          io,
          global: global(project, json),
          openSessionStore: () => opened,
          now: () => Date.parse('2026-06-25T00:00:00.000Z'),
        },
      );
      expect(existsSync(join(project, `${HOSTILE}.relavium.yaml`))).toBe(true);
      expect(err(), 'the note names the path too').toContain('set agent_ref in ');
      expect(err()).not.toMatch(TERMINAL_ACTIVE);
      if (!json) {
        expect(out()).not.toMatch(TERMINAL_ACTIVE);
        expect(out()).toMatch(/^Exported session s1 to .*evil.*\.relavium\.yaml\n$/u);
      }
    });
  },
);
