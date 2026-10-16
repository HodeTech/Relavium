import { createHash } from 'node:crypto';

import { createToolRegistry, type ToolDef, type ToolDispatchContext } from '@relavium/core';
import {
  createClient,
  createEffectJournalPort,
  createEffectJournalStore,
  runMigrations,
} from '@relavium/db';
import type { EffectDispatchPort } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

function selection(which: 'alice' | 'bob') {
  const alice = { label: 'alice' };
  const bob = { label: 'bob' };
  return { catalog: [alice, bob], selected: which === 'alice' ? alice : bob };
}

// Independently spelled canonical bytes: sorted object keys, ordered arrays, no whitespace.
// Do not use the production canonicalJson helper to derive the expected digest.
const EXPECTED_CANONICAL = {
  alice: '{"payload":{"catalog":[{"label":"alice"},{"label":"bob"}],"selected":{"label":"alice"}}}',
  bob: '{"payload":{"catalog":[{"label":"alice"},{"label":"bob"}],"selected":{"label":"bob"}}}',
};

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function registryFixture(effects: EffectDispatchPort) {
  const received: unknown[] = [];
  const tool: ToolDef = {
    id: 'alias_publish',
    source: 'mcp',
    description: 'Offline registry and native journal alias fixture',
    llmVisibleParams: { type: 'object' },
    parseArgs: (raw) => z.object({ payload: z.unknown() }).strict().parse(raw),
    policy: { fsScoped: false, spawnsProcess: false, requiresGateApproval: false },
    effect: () => 3,
    dispatch: (args) => {
      const parsed = z.object({ payload: z.unknown() }).strict().parse(args);
      received.push(parsed.payload);
      return Promise.resolve({ receipt: 'published' });
    },
  };
  const context: ToolDispatchContext = {
    nodeId: 'n',
    grantedToolIds: new Set([tool.id]),
    config: {},
    toolPolicy: {},
    fsScope: 'sandboxed',
    gateApproved: false,
    effects,
    effectSlot: 0,
  };
  return { registry: createToolRegistry({ tools: [tool], host: {} }), received, context };
}

function call(payload: unknown) {
  return { type: 'tool_call', id: 'alias-call', name: 'alias_publish', args: { payload } } as const;
}

function recordingPort(inner: EffectDispatchPort) {
  return {
    prepare: vi.fn((...args: Parameters<EffectDispatchPort['prepare']>) => inner.prepare(...args)),
    settle: vi.fn((...args: Parameters<EffectDispatchPort['settle']>) => inner.settle(...args)),
    discard: vi.fn((...args: Parameters<EffectDispatchPort['discard']>) => inner.discard(...args)),
  } satisfies EffectDispatchPort;
}

const PhysicalRowsSchema = z.array(
  z.object({ slot: z.number(), state: z.string(), args_digest: z.string() }).strict(),
);
const METADATA = [
  { name: 'absent', keys: undefined },
  { name: 'empty', keys: new Set<string>() },
  { name: 'nonempty', keys: new Set(['confidentialNote']) },
];

describe.each(METADATA)(
  'W3S5 #94 public registry and native SQLite with $name external metadata',
  ({ keys }) => {
    it('PHYSICAL_ALIAS_DIGEST commits distinct correct SHA-256 values for different selections', async () => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        let ids = 0;
        const store = createEffectJournalStore(client.db, {
          uuid: () => `alias-${++ids}`,
          now: () => 6,
        });
        const effects = recordingPort(
          createEffectJournalPort(
            store,
            { kind: 'run', runId: 'r-alias', nodeId: 'n', attempt: 1 },
            { providerAttempt: 1, toolCallId: 'alias-call' },
          ),
        );
        const h = registryFixture(effects);
        const context = { ...h.context, ...(keys === undefined ? {} : { secretArgKeys: keys }) };
        const alice = selection('alice');
        const bob = selection('bob');
        const aliceOutcome = await h.registry.dispatch(call(alice), context);
        const bobOutcome = await h.registry.dispatch(call(bob), { ...context, effectSlot: 1 });
        const rows = PhysicalRowsSchema.parse(
          client.sqlite
            .prepare('SELECT slot, state, args_digest FROM run_effects ORDER BY slot')
            .all(),
        );
        expect(rows).toHaveLength(2);
        expect(rows.map((row) => row.state)).toEqual(['committed', 'committed']);
        for (const row of rows) expect(row.args_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(rows[0]?.args_digest, 'PHYSICAL_ALIAS_DIGEST_DISTINCT').not.toBe(
          rows[1]?.args_digest,
        );
        expect(rows[0]?.args_digest, 'PHYSICAL_ALIAS_DIGEST_ALICE').toBe(
          sha256(EXPECTED_CANONICAL.alice),
        );
        expect(rows[1]?.args_digest, 'PHYSICAL_ALIAS_DIGEST_BOB').toBe(
          sha256(EXPECTED_CANONICAL.bob),
        );
        for (const [index, outcome] of [aliceOutcome, bobOutcome].entries()) {
          const expected: unknown = JSON.parse(
            index === 0 ? EXPECTED_CANONICAL.alice : EXPECTED_CANONICAL.bob,
          );
          expect(outcome.events.call.toolInput, 'PHYSICAL_ALIAS_EVENT').toEqual(expected);
          expect(effects.prepare.mock.calls[index]?.[3], 'PHYSICAL_ALIAS_PREPARE').toEqual(
            expected,
          );
        }
        expect(h.received[0]).toBe(alice);
        expect(h.received[1]).toBe(bob);
        expect(alice.selected).toBe(alice.catalog[0]);
        expect(bob.selected).toBe(bob.catalog[1]);
      } finally {
        client.sqlite.close();
      }
    });

    it('PHYSICAL_ALIAS_REPLAY replays equal selection and conflicts on changed same-slot selection', async () => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        let ids = 0;
        const store = createEffectJournalStore(client.db, {
          uuid: () => `replay-${++ids}`,
          now: () => 6,
        });
        const effects = recordingPort(
          createEffectJournalPort(
            store,
            { kind: 'run', runId: 'r-alias-replay', nodeId: 'n', attempt: 1 },
            { providerAttempt: 1, toolCallId: 'alias-call' },
          ),
        );
        const h = registryFixture(effects);
        const context = { ...h.context, ...(keys === undefined ? {} : { secretArgKeys: keys }) };
        const first = await h.registry.dispatch(call(selection('alice')), context);
        const replay = await h.registry.dispatch(call(selection('alice')), context);
        expect(replay.output).toEqual(first.output);
        expect(h.received).toHaveLength(1);
        await expect(
          h.registry.dispatch(call(selection('bob')), context),
          'PHYSICAL_ALIAS_CHANGED_SELECTION_CONFLICT',
        ).rejects.toMatchObject({
          name: 'ToolEffectConflictError',
          code: 'effect_conflict',
          retryable: false,
        });
        expect(h.received, 'PHYSICAL_ALIAS_NO_DUPLICATE_DISPATCH').toHaveLength(1);
        const rows = PhysicalRowsSchema.parse(
          client.sqlite
            .prepare('SELECT slot, state, args_digest FROM run_effects ORDER BY slot')
            .all(),
        );
        expect(rows, 'PHYSICAL_ALIAS_REPLAY_ROW').toEqual([
          { slot: 0, state: 'committed', args_digest: sha256(EXPECTED_CANONICAL.alice) },
        ]);
      } finally {
        client.sqlite.close();
      }
    });
  },
);

describe('W3S5 #94 physical journal deliberate secret-projection equality', () => {
  it('PHYSICAL_SECRET_EQUALITY varies only credentials and keeps actual event and prepare copies scrubbed', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      let ids = 0;
      const store = createEffectJournalStore(client.db, {
        uuid: () => `secret-${++ids}`,
        now: () => 6,
      });
      const effects = recordingPort(
        createEffectJournalPort(
          store,
          { kind: 'run', runId: 'r-alias-secret', nodeId: 'n', attempt: 1 },
          { providerAttempt: 1, toolCallId: 'alias-call' },
        ),
      );
      const h = registryFixture(effects);
      const context = { ...h.context, secretArgKeys: new Set(['confidentialNote']) };
      const media = 'U1lOVEhFVElDX01FRElBX0NBTkFSWQ==';
      const projected = {
        payload: {
          left: {
            label: 'clean',
            password: '[redacted]',
            media: { kind: 'base64', base64Length: media.length },
          },
          right: {
            label: 'clean',
            password: '[redacted]',
            media: { kind: 'base64', base64Length: media.length },
          },
        },
      };
      const canonical =
        '{"payload":{"left":{"label":"clean","media":{"base64Length":32,"kind":"base64"},"password":"[redacted]"},"right":{"label":"clean","media":{"base64Length":32,"kind":"base64"},"password":"[redacted]"}}}';
      expect(media.length, 'PHYSICAL_SECRET_FIXTURE_LENGTH').toBe(32);
      for (const [slot, suffix] of ['ONE', 'TWO'].entries()) {
        const shared = {
          label: 'clean',
          password: `SYNTHETIC_PASSWORD_${suffix}`,
          media: { kind: 'base64', data: media },
          confidentialNote: `SYNTHETIC_NOTE_${suffix}`,
        };
        const payload = { left: shared, right: shared };
        const outcome = await h.registry.dispatch(call(payload), { ...context, effectSlot: slot });
        for (const projection of [
          outcome.events.call.toolInput,
          effects.prepare.mock.calls[slot]?.[3],
        ]) {
          expect(projection, 'PHYSICAL_SECRET_PROJECTION').toEqual(projected);
          const text = JSON.stringify(projection);
          for (const canary of ['SYNTHETIC_PASSWORD_', 'SYNTHETIC_NOTE_', media])
            expect(text).not.toContain(canary);
        }
        expect(h.received[slot]).toBe(payload);
        expect(payload.left).toBe(payload.right);
        expect(shared.password).toBe(`SYNTHETIC_PASSWORD_${suffix}`);
      }
      const rows = PhysicalRowsSchema.parse(
        client.sqlite
          .prepare('SELECT slot, state, args_digest FROM run_effects ORDER BY slot')
          .all(),
      );
      expect(rows, 'PHYSICAL_SECRET_EQUALITY').toEqual([
        { slot: 0, state: 'committed', args_digest: sha256(canonical) },
        { slot: 1, state: 'committed', args_digest: sha256(canonical) },
      ]);
      expect(h.received).toHaveLength(2);
    } finally {
      client.sqlite.close();
    }
  });
});
