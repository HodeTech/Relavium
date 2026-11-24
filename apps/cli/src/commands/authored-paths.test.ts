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
import { createExportPort } from '../home/defined-port.js';
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
const TERMINAL_ACTIVE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u;
/** A directory name that carries a colour escape, a title-change introducer and a right-to-left override. */
const HOSTILE = 'evil\u001b[31m\u001b]0;pwned\u0007\u202egpj';

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

describe('a Windows device name is no id for an authored file, on any platform', () => {
  // `con.agent.yaml` cannot be added to git on Windows and may open the device there; the repository is shared across platforms, so the
  // refusal is the same everywhere. The in-chat export has always skipped these ids (`chat/export-project.test.ts`); import and create
  // share its predicate (`isWindowsDeviceName`).
  const SENTENCE = (id: string): string =>
    `'${id}' is a device name on Windows, so no file can be named after it — choose another id.`;
  const agentNamed = (id: string): string => AGENT.replace('id: reviewer', `id: ${id}`);

  it.each(['con', 'prn', 'aux', 'nul', 'com0', 'com1', 'com9', 'lpt0', 'lpt1', 'lpt9'])(
    'import refuses %s, with or without --force, and writes nothing',
    async (id) => {
      writeFileSync(join(project, 'incoming.agent.yaml'), agentNamed(id));
      for (const force of [false, true]) {
        const { io, out } = captureIo();
        expect(
          await refusalOf(() =>
            importCommand(
              { path: 'incoming.agent.yaml', force },
              { io, global: global(project), homeDir: home },
            ),
          ),
          `force=${String(force)}`,
        ).toBe(SENTENCE(id));
        expect(out()).toBe('');
      }
      expect(readdirSync(join(project, '.relavium'))).toEqual([]);
    },
  );

  it('create refuses a name that makes one, before any file is written', async () => {
    const { io } = captureIo();
    const named = (name: string): CreatePrompter => ({
      gather: () => Promise.resolve({ ...SPEC, name }),
    });
    expect(
      await refusalOf(() =>
        createCommand(
          { force: true },
          { io, global: global(project), prompter: named('Aux'), homeDir: home },
        ),
      ),
    ).toBe(SENTENCE('aux'));
    expect(readdirSync(join(project, '.relavium'))).toEqual([]);
  });

  it('a name that only CONTAINS one, or goes past the reserved range, is an ordinary id', () => {
    for (const id of ['console', 'com10', 'lpt10', 'auxiliary', 'nul-device']) {
      writeFileSync(join(project, 'incoming.agent.yaml'), agentNamed(id));
      const { io } = captureIo();
      importCommand(
        { path: 'incoming.agent.yaml', force: false },
        { io, global: global(project), homeDir: home },
      );
      expect(existsSync(join(project, '.relavium', 'agents', `${id}.agent.yaml`)), id).toBe(true);
    }
  });

  describe('export names its default destination after the id, so it refuses these too', () => {
    // The id comes from a file in the repository (`workflow.id: aux` in `serial.relavium.yaml`), and the default destination is
    // `<cwd>/<id>.relavium.yaml`: a file name that cannot be added to git on Windows and may open the device. `--out` is the person's own path.
    const workflowNamed = (id: string): string =>
      `schema_version: '1.0'\nworkflow:\n  id: ${id}\n  nodes:\n    - { id: s, type: input }\n    - { id: o, type: output }\n  edges:\n    - { from: s, to: o }\n`;
    const SENTENCE_EXPORT = (id: string): string =>
      `'${id}' is a device name on Windows, so no file can be named after it — name the file yourself with relavium export <id> --out <path>.`;

    beforeEach(() => {
      mkdirSync(join(project, '.relavium', 'workflows'), { recursive: true });
    });

    it.each(['aux', 'com0', 'lpt0', 'nul'])(
      '%s: refused with nothing written, with or without --force',
      async (id) => {
        writeFileSync(
          join(project, '.relavium', 'workflows', 'serial.relavium.yaml'),
          workflowNamed(id),
        );
        for (const force of [false, true]) {
          const { io, out } = captureIo();
          expect(
            await refusalOf(() =>
              exportCommand({ id, force }, { io, global: global(project), homeDir: home }),
            ),
            `force=${String(force)}`,
          ).toBe(SENTENCE_EXPORT(id));
          expect(out()).toBe('');
        }
        expect(readdirSync(project).filter((name) => name.startsWith(id))).toEqual([]);
      },
    );

    it('an explicit --out is the person’s own path, and is the way out', () => {
      writeFileSync(
        join(project, '.relavium', 'workflows', 'serial.relavium.yaml'),
        workflowNamed('aux'),
      );
      const { io } = captureIo();
      exportCommand(
        { id: 'aux', out: 'serial-copy.relavium.yaml', force: false },
        { io, global: global(project), homeDir: home },
      );
      expect(readFileSync(join(project, 'serial-copy.relavium.yaml'), 'utf8')).toContain('id: aux');
    });

    it('the Home’s export card refuses it before it asks, in the same words', () => {
      writeFileSync(
        join(project, '.relavium', 'workflows', 'serial.relavium.yaml'),
        workflowNamed('aux'),
      );
      const prepared = createExportPort({ global: global(project), homeDir: home }).prepare('aux');
      expect(prepared).toEqual({ ok: false, reason: SENTENCE_EXPORT('aux') });
      expect(readdirSync(project).filter((name) => name.startsWith('aux'))).toEqual([]);
    });
  });
});
