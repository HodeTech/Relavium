import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createClient, createSessionStore, runMigrations, type DbClient } from '@relavium/db';
import { AgentSchema, type AgentSessionRecord, type SessionMessage } from '@relavium/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenedSessionStore } from '../history/session-open.js';
import { CliError } from '../process/cli-error.js';
import { EXIT_CODES } from '../process/exit-codes.js';
import type { GlobalOptions } from '../process/options.js';
import { captureIo, parseNdjson } from '../test-support.js';
import { chatExportCommand, type ChatExportCommandDeps } from './chat-export.js';

const ISO = '2026-06-25T00:00:00.000Z';
const AGENT = AgentSchema.parse({
  id: 'coder',
  model: 'claude-opus-4-8',
  provider: 'anthropic',
  system_prompt: 'You are concise.',
});

function globalOptions(cwd: string, json = false): GlobalOptions {
  return { json, color: false, cwd, configPath: undefined, verbosity: 'normal' };
}

const record = (overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  id: 's1',
  agentSlug: AGENT.id,
  agentSnapshot: AGENT,
  title: 'My Session',
  context: { workingDir: '/workspace', fsScopeTier: 'sandboxed' },
  status: 'active',
  totalInputTokens: 0,
  totalOutputTokens: 0,
  totalCostMicrocents: 0,
  totalConservativeMicrocents: 0,
  createdAt: ISO,
  updatedAt: ISO,
  ...overrides,
});

const message = (seq: number, role: 'user' | 'assistant', text: string): SessionMessage => ({
  id: `m${seq}`,
  sessionId: 's1',
  sequenceNumber: seq,
  role,
  content: [{ type: 'text', text }],
  timestamp: ISO,
});

describe('chatExportCommand (2.P)', () => {
  let client: DbClient;
  let opened: OpenedSessionStore;
  let cwd: string;

  beforeEach(() => {
    client = createClient(':memory:');
    runMigrations(client.db);
    const store = createSessionStore(client.db);
    store.createSession(record());
    store.appendMessage(message(0, 'user', 'hello'));
    store.appendMessage(message(1, 'assistant', 'hi there'));
    opened = { store, db: client.db, close: () => undefined };
    cwd = mkdtempSync(join(tmpdir(), 'relavium-export-cmd-'));
  });
  afterEach(() => {
    client.sqlite.close();
    rmSync(cwd, { recursive: true, force: true });
  });

  function deps(io: ReturnType<typeof captureIo>['io'], json = false): ChatExportCommandDeps {
    return {
      io,
      global: globalOptions(cwd, json),
      openSessionStore: () => opened,
      now: () => Date.parse(ISO),
    };
  }

  it.each([
    { mode: 'human', json: false },
    { mode: 'json', json: true },
  ])(
    'reports fixed continuity and review notice on stderr after successful $mode export',
    ({ json }) => {
      opened.store.updateSession(record({ title: 'PRIVATE_TITLE_SENTINEL' }));
      opened.store.appendMessage(message(2, 'user', 'PRIVATE_USER_SENTINEL'));
      opened.store.appendMessage(message(3, 'assistant', 'PRIVATE_ASSISTANT_SENTINEL'));
      const { io, out, err } = captureIo();
      expect(chatExportCommand({ sessionId: 's1', force: false }, deps(io, json))).toBe(
        EXIT_CODES.success,
      );
      const notice = err();
      expect(notice, 'W2_EXPORT_COMMAND_NOTICE').toMatch(
        /scaffold; conversation context is not reproduced/,
      );
      expect(notice, 'W2_EXPORT_COMMAND_NOTICE').toMatch(
        /Compaction summaries, trimming and omitted context may not transfer/,
      );
      expect(notice, 'W2_EXPORT_COMMAND_NOTICE').toMatch(
        /Review retained user\/assistant text, @-attached files, !-shell output and authored agent literals before committing/,
      );
      expect(notice.trim().split('\n')).toHaveLength(1);
      expect(`${out()}${notice}`).not.toContain('PRIVATE_');
      expect(err()).toContain(
        'Historical agent snapshots may require edits to pass current validation before running.',
      );
      expect(out()).not.toContain('scaffold;');
      expect(readFileSync(join(cwd, 's1.relavium.yaml'), 'utf8')).toContain(
        'PRIVATE_USER_SENTINEL',
      );
      if (json) {
        expect(parseNdjson(out())).toEqual([
          expect.objectContaining({
            type: 'session:exported',
            workflowPath: join(cwd, 's1.relavium.yaml'),
          }),
        ]);
      } else {
        expect(out()).toBe(`Exported session s1 to ${join(cwd, 's1.relavium.yaml')}\n`);
      }
    },
  );

  it.each([
    { mode: 'human', json: false },
    { mode: 'json', json: true },
  ])('does not report a successful $mode export notice after a refused write', ({ json }) => {
    const path = join(cwd, 's1.relavium.yaml');
    writeFileSync(path, 'existing artifact');
    const { io, out, err } = captureIo();
    expect(() => chatExportCommand({ sessionId: 's1', force: false }, deps(io, json))).toThrow(
      /already exists/,
    );
    expect(err(), 'W2_EXPORT_COMMAND_SUCCESS_ONLY').toBe('');
    expect(out()).toBe('');
    expect(readFileSync(path, 'utf8')).toBe('existing artifact');
    expect(opened.store.loadFull('s1')?.session.status).toBe('active');
  });

  it('preserves the written artifact but does not swallow a native invalid-timestamp fault as provenance refusal', () => {
    const { io, out, err } = captureIo();
    const update = vi.spyOn(opened.store, 'updateSession');
    expect(() =>
      chatExportCommand({ sessionId: 's1', force: false }, { ...deps(io), now: () => Number.NaN }),
    ).toThrow(RangeError);
    expect(update).not.toHaveBeenCalled();
    expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(true);
    expect(err()).not.toContain('could not mark the session exported');
    expect(out()).toBe('');
    update.mockRestore();
  });

  it('writes the scaffold, marks the session exported, and prints the path (exit 0)', () => {
    const { io, out } = captureIo();
    expect(chatExportCommand({ sessionId: 's1', force: false }, deps(io))).toBe(EXIT_CODES.success);

    const path = join(cwd, 's1.relavium.yaml'); // named from the unique session id
    expect(existsSync(path)).toBe(true);
    expect(out()).toBe(`Exported session s1 to ${path}\n`);

    // The session row is marked `exported` with the written path (provenance, ADR-0026).
    const loaded = opened.store.loadFull('s1');
    expect(loaded?.session.status).toBe('exported');
    expect(loaded?.session.exportedWorkflowPath).toBe(path);
  });

  it('emits a single session:exported event under --json (stdout pure)', () => {
    const { io, out } = captureIo();
    expect(chatExportCommand({ sessionId: 's1', force: false }, deps(io, true))).toBe(
      EXIT_CODES.success,
    );
    const records = parseNdjson(out());
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      type: 'session:exported',
      sessionId: 's1',
      sequenceNumber: 2,
      workflowPath: join(cwd, 's1.relavium.yaml'),
    });
    expect(out()).not.toContain('Exported session'); // no human chrome on the --json path
  });

  it('emits sequenceNumber 0 for an empty-session --json export', () => {
    // Replace the seeded transcript with a turn-less session so the seq fold's base case (−1+1=0) is pinned
    // at the boundary where it is observable (the event), not only in the export-core unit test.
    const fresh = createSessionStore(client.db);
    fresh.createSession(record({ id: 's-empty', title: 'Empty' }));
    opened = { store: fresh, db: client.db, close: () => undefined };
    const { io, out } = captureIo();
    expect(chatExportCommand({ sessionId: 's-empty', force: false }, deps(io, true))).toBe(
      EXIT_CODES.success,
    );
    expect(parseNdjson(out())[0]).toMatchObject({ sequenceNumber: 0 });
  });

  it('embeds the fixture agent without adding a provider credential field', () => {
    const { io } = captureIo();
    chatExportCommand({ sessionId: 's1', force: false }, deps(io));
    const yaml = readFileSync(join(cwd, 's1.relavium.yaml'), 'utf8');
    // The frozen agent is emitted into `agents:`, but it references the provider by id — no key field exists.
    expect(yaml).not.toMatch(/api_?key/i);
    expect(yaml).toContain('agents:'); // the snapshot WAS embedded (so the no-key assertion is meaningful)
  });

  it('rejects an unknown sessionId as exit-2 and closes the store', () => {
    let closed = false;
    opened = { ...opened, close: () => (closed = true) };
    const { io } = captureIo();
    expect(() => chatExportCommand({ sessionId: 'ghost', force: false }, deps(io))).toThrow(
      /no session found with id ghost/,
    );
    expect(closed).toBe(true);
  });

  it('honors --out at the command level (the args.out → outPath passthrough)', () => {
    const { io } = captureIo();
    expect(
      chatExportCommand({ sessionId: 's1', out: 'custom/out.yaml', force: false }, deps(io)),
    ).toBe(EXIT_CODES.success);
    expect(existsSync(join(cwd, 'custom/out.yaml'))).toBe(true);
  });

  it('preserves an unexpected provenance fault after the scaffold has been written', () => {
    const primary = new TypeError('PRIVATE_EXPORT_BUG');
    opened = {
      ...opened,
      store: {
        ...opened.store,
        updateSession: () => {
          throw primary;
        },
      },
    };
    const { io, err } = captureIo();
    expect(() => chatExportCommand({ sessionId: 's1', force: false }, deps(io))).toThrow(primary);
    expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(true);
    expect(err()).not.toContain('could not mark the session exported');
  });

  it('degrades a row-mark failure to a stderr warning — the scaffold still lands, exit 0', () => {
    // updateSession throws (e.g. a locked db): the file write is the durable contract, so the export still
    // succeeds (exit 0) with a stderr note rather than failing an export already on disk.
    opened = {
      ...opened,
      store: {
        ...opened.store,
        updateSession: () => {
          throw new CliError('storage_unavailable', '');
        },
      },
    };
    const { io, err } = captureIo();
    expect(chatExportCommand({ sessionId: 's1', force: false }, deps(io))).toBe(EXIT_CODES.success);
    expect(err()).toContain('could not mark the session exported');
    expect(existsSync(join(cwd, 's1.relavium.yaml'))).toBe(true);
  });

  it('refuses to overwrite an existing target without --force (exit-2 fault) and closes the store', () => {
    const { io } = captureIo();
    chatExportCommand({ sessionId: 's1', force: false }, deps(io)); // first export creates the file
    let closed = false;
    opened = { ...opened, close: () => (closed = true) };
    expect(() => chatExportCommand({ sessionId: 's1', force: false }, deps(io))).toThrow(
      /already exists — pass --force/,
    );
    expect(closed).toBe(true); // the store is closed on the file-exists throw path too
  });

  it.each([
    { mode: 'human', json: false },
    { mode: 'json', json: true },
  ])(
    'retains the missing agent snapshot warning beside the $mode continuity notice',
    ({ json }) => {
      const fresh = createSessionStore(client.db);
      fresh.createSession(record({ id: 's-nosnap', title: 'No Snap', agentSnapshot: undefined }));
      opened = { store: fresh, db: client.db, close: () => undefined };
      const { io, out, err } = captureIo();
      expect(chatExportCommand({ sessionId: 's-nosnap', force: false }, deps(io, json))).toBe(
        EXIT_CODES.success,
      );
      expect(err(), 'W2_EXPORT_MISSING_AGENT_POSITIVE').toContain('no stored agent');
      expect(err()).toContain('note: exported workflow is a scaffold');
      if (json) expect(parseNdjson(out())).toHaveLength(1);
    },
  );

  it('overwrites with --force', () => {
    const { io } = captureIo();
    chatExportCommand({ sessionId: 's1', force: false }, deps(io));
    expect(chatExportCommand({ sessionId: 's1', force: true }, deps(io))).toBe(EXIT_CODES.success);
  });
});
