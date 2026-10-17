import { createHash } from 'node:crypto';

import {
  BUILTIN_TOOLS,
  createToolRegistry,
  type ToolDef,
  type ToolDispatchContext,
  type ToolHost,
} from '@relavium/core';
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
  return `v3:${createHash('sha256').update(text).digest('hex')}`;
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
        for (const row of rows) expect(row.args_digest).toMatch(/^v3:[0-9a-f]{64}$/);
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

describe('PR #95 full redacted journal digest', () => {
  it('PHYSICAL_LONG_ARGS hashes the non-secret tail, preserves replay and refuses changed same-slot args', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      let ids = 0;
      const store = createEffectJournalStore(client.db, {
        uuid: () => `long-${++ids}`,
        now: () => 6,
      });
      const effects = recordingPort(
        createEffectJournalPort(
          store,
          { kind: 'run', runId: 'r-long', nodeId: 'n', attempt: 1 },
          { providerAttempt: 1, toolCallId: 'long-call' },
        ),
      );
      const h = registryFixture(effects);
      const context = { ...h.context, secretArgKeys: new Set(['confidentialNote']) };
      const prefix = 'x'.repeat(20 * 1024);
      const payload = (tail: string, credential: string) => ({
        text: `${prefix}${tail} Bearer ${credential}`,
        password: credential,
        confidentialNote: credential,
      });
      const firstPayload = payload('first', 'SYNTHETIC_LONG_SECRET_ONE');
      const otherPayload = payload('other', 'SYNTHETIC_LONG_SECRET_TWO');
      expect(firstPayload.text.length).toBe(otherPayload.text.length);
      const first = await h.registry.dispatch(call(firstPayload), context);
      const replay = await h.registry.dispatch(
        call(payload('first', 'SYNTHETIC_LONG_SECRET_TWO')),
        context,
      );
      expect(replay.output).toEqual(first.output);
      expect(h.received).toHaveLength(1);
      await expect(
        h.registry.dispatch(call(otherPayload), context),
        'PHYSICAL_LONG_ARGS_CONFLICT',
      ).rejects.toMatchObject({ name: 'ToolEffectConflictError', retryable: false });
      expect(h.received).toHaveLength(1);
      await h.registry.dispatch(call(otherPayload), { ...context, effectSlot: 1 });
      expect(h.received).toEqual([firstPayload, otherPayload]);

      const rows = PhysicalRowsSchema.parse(
        client.sqlite
          .prepare('SELECT slot, state, args_digest FROM run_effects ORDER BY slot')
          .all(),
      );
      // Independent canonical bytes, including the entire non-secret tail, not the display preview.
      const expected = (tail: string) =>
        sha256(`{"payload":{"password":"[redacted]","text":"${prefix}${tail} Bearer [redacted]"}}`);
      expect(rows, 'PHYSICAL_LONG_ARGS_DIGEST').toEqual([
        { slot: 0, state: 'committed', args_digest: expected('first') },
        { slot: 1, state: 'committed', args_digest: expected('other') },
      ]);
      expect(rows[0]?.args_digest).not.toBe(rows[1]?.args_digest);
      for (const args of effects.prepare.mock.calls) {
        const projection = JSON.stringify(args[3]);
        expect(projection).not.toContain('SYNTHETIC_LONG_SECRET');
        expect(projection).not.toContain('confidentialNote');
        expect(projection).toContain('Bearer [redacted]');
      }
      expect(JSON.stringify(first.events.call.toolInput).length).toBeLessThan(17 * 1024);
      expect(
        JSON.stringify(client.sqlite.prepare('SELECT * FROM run_effects').all()),
      ).not.toContain('SYNTHETIC_LONG_SECRET');
    } finally {
      client.sqlite.close();
    }
  });

  it.each(['original', 'literal-preview'] as const)(
    'PHYSICAL_LEGACY_LONG_ARGS refuses the %s against an old truncated digest',
    async (kind) => {
      const client = createClient(':memory:');
      try {
        runMigrations(client.db);
        const store = createEffectJournalStore(client.db, {
          uuid: () => 'legacy-long',
          now: () => 6,
        });
        const effects = createEffectJournalPort(
          store,
          { kind: 'run', runId: 'r-legacy-long', nodeId: 'n', attempt: 1 },
          { providerAttempt: 1, toolCallId: 'legacy-call' },
        );
        const text = `${'x'.repeat(20 * 1024)}first`;
        const preview = `${text.slice(0, 16 * 1024)}…[${String(text.length)} chars total]`;
        // Seed actual pre-correction bytes, never through the current digest-producing port.
        const legacyDigest = createHash('sha256')
          .update(JSON.stringify({ payload: { text: preview } }))
          .digest('hex');
        store.prepare(
          { scope: 'run:r-legacy-long:n', slot: 0, toolId: 'alias_publish' },
          { kind: 'run', runId: 'r-legacy-long', nodeId: 'n', attempt: 1 },
          { providerAttempt: 1, toolCallId: 'legacy-call' },
          3,
          legacyDigest,
        );
        await effects.settle(0, 'alias_publish', 'committed', { receipt: 'legacy result' });
        const h = registryFixture(effects);
        await expect(
          h.registry.dispatch(call({ text: kind === 'original' ? text : preview }), h.context),
          'PHYSICAL_LEGACY_LONG_ARGS_REFUSAL',
        ).rejects.toMatchObject({ name: 'ToolEffectConflictError', retryable: false });
        expect(h.received).toEqual([]);
        expect(
          store.recordsFor({ kind: 'run', runId: 'r-legacy-long', nodeId: 'n', attempt: 1 }),
        ).toHaveLength(1);
      } finally {
        client.sqlite.close();
      }
    },
  );
});

const CREDENTIAL_CASES = [
  {
    name: 'URL password with multiple @ separators',
    body: (suffix: string) =>
      `https://a:p@SYNTHETIC_USERINFO_TAIL_${suffix}@api.invalid;custom://u:second-password@two.invalid/path`,
    projected: 'https://[redacted]@api.invalid;custom://[redacted]@two.invalid/path',
    oldProjection: (suffix: string) =>
      `https://[redacted]@SYNTHETIC_USERINFO_TAIL_${suffix}@api.invalid;custom://[redacted]@two.invalid/path`,
  },
  {
    name: 'opaque query beyond the old 512-character match',
    body: (suffix: string) =>
      `https://public.invalid/?opaque=${'Q'.repeat(599)}${suffix}#public-fragment`,
    projected: 'https://public.invalid/?opaque=[redacted]#public-fragment',
    oldProjection: (suffix: string) =>
      `https://public.invalid/?opaque=[redacted]${'Q'.repeat(87)}${suffix}#public-fragment`,
  },
  {
    name: 'JSON password with an escaped quote',
    body: (suffix: string) =>
      JSON.stringify({ password: `ordinary"SYNTHETIC_SECRET_TAIL_${suffix}` }),
    projected: '{"[redacted]}',
    oldProjection: (suffix: string) => `{"[redacted]SYNTHETIC_SECRET_TAIL_${suffix}"}`,
  },
];

describe.each(CREDENTIAL_CASES)('PR #95 complete recognized credential: $name', (fixture) => {
  it('PHYSICAL_CREDENTIAL_EQUALITY keeps credential changes out of actual HTTP journal digests', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      let ids = 0;
      const store = createEffectJournalStore(client.db, {
        uuid: () => `credential-${++ids}`,
        now: () => 6,
      });
      const effects = recordingPort(
        createEffectJournalPort(
          store,
          { kind: 'run', runId: 'r-credential', nodeId: 'n', attempt: 1 },
          { providerAttempt: 1, toolCallId: 'credential-call' },
        ),
      );
      const fetch = vi.fn<NonNullable<ToolHost['egress']>['fetch']>(() =>
        Promise.resolve({ status: 200, headers: {}, body: 'receipt' }),
      );
      const registry = createToolRegistry({ tools: BUILTIN_TOOLS, host: { egress: { fetch } } });
      const context: ToolDispatchContext = {
        nodeId: 'n',
        grantedToolIds: new Set(['http_request']),
        config: {},
        toolPolicy: { allowedDomains: ['service.invalid'] },
        fsScope: 'sandboxed',
        gateApproved: false,
        effects,
        effectSlot: 0,
      };
      const prefix = `${'x'.repeat(20 * 1024)}\n`;
      const args = (body: string) => ({ body, method: 'POST', url: 'https://service.invalid/x' });
      const request = (suffix: string, publicTail = '\npublic-tail') =>
        ({
          type: 'tool_call',
          id: 'credential-call',
          name: 'http_request',
          args: args(`${prefix}${fixture.body(suffix)}${publicTail}`),
        }) as const;
      const first = await registry.dispatch(request('A'), context);
      const replay = await registry.dispatch(request('B'), context).then(
        (result) => ({ output: result.output }),
        (failure: unknown) => ({ failure }),
      );
      expect(replay, 'PHYSICAL_CREDENTIAL_EQUALITY').toEqual({ output: first.output });
      expect(fetch).toHaveBeenCalledOnce();
      expect(fetch.mock.calls[0]?.[0]).toMatchObject(request('A').args);
      await registry.dispatch(request('B'), { ...context, effectSlot: 1 });
      expect(fetch).toHaveBeenCalledTimes(2);
      const projected = args(`${prefix}${fixture.projected}\npublic-tail`);
      // Independent sorted-key bytes; no production redactor/canonical helper supplies the oracle.
      const expectedDigest = sha256(JSON.stringify(projected));
      const rows = PhysicalRowsSchema.parse(
        client.sqlite
          .prepare('SELECT slot, state, args_digest FROM run_effects ORDER BY slot')
          .all(),
      );
      expect(rows, 'PHYSICAL_CREDENTIAL_EQUALITY').toEqual([
        { slot: 0, state: 'committed', args_digest: expectedDigest },
        { slot: 1, state: 'committed', args_digest: expectedDigest },
      ]);
      for (const callArgs of effects.prepare.mock.calls) {
        expect(callArgs[3], 'PHYSICAL_CREDENTIAL_PROJECTION').toEqual(projected);
      }
      await expect(
        registry.dispatch(request('B', '\nchanged-public-tail'), context),
        'PHYSICAL_CREDENTIAL_PUBLIC_TAIL_CONFLICT',
      ).rejects.toMatchObject({ name: 'ToolEffectConflictError', retryable: false });
      expect(fetch).toHaveBeenCalledTimes(2);
      expect(
        JSON.stringify(client.sqlite.prepare('SELECT * FROM run_effects').all()),
      ).not.toContain('SYNTHETIC_SECRET_TAIL_');
    } finally {
      client.sqlite.close();
    }
  });

  it('PHYSICAL_PARTIAL_V2_REFUSAL refuses a literal equal to an old partially redacted projection', async () => {
    const client = createClient(':memory:');
    try {
      runMigrations(client.db);
      const store = createEffectJournalStore(client.db, { uuid: () => 'partial-v2', now: () => 6 });
      const correlation = { kind: 'run', runId: 'r-v2', nodeId: 'n', attempt: 1 } as const;
      const body = `${'x'.repeat(20 * 1024)}\n${fixture.oldProjection('A')}`;
      const args = { body, method: 'POST', url: 'https://service.invalid/x' };
      const identity = { scope: 'run:r-v2:n', slot: 0, toolId: 'http_request' };
      const v2 = `v2:${createHash('sha256').update(JSON.stringify(args)).digest('hex')}`;
      store.prepare(identity, correlation, { providerAttempt: 1, toolCallId: 'old' }, 3, v2);
      store.settle(identity, 'committed', { receipt: 'old result' });
      const effects = createEffectJournalPort(store, correlation, {
        providerAttempt: 1,
        toolCallId: 'new',
      });
      const attempt = await effects.prepare(0, 'http_request', 3, args).then(
        (value) => ({ value }),
        (failure: unknown) => ({ failure }),
      );
      expect(attempt, 'PHYSICAL_PARTIAL_V2_REFUSAL').toMatchObject({
        failure: { name: 'EffectConflictError' },
      });
      expect(store.recordsFor(correlation)).toHaveLength(1);
    } finally {
      client.sqlite.close();
    }
  });
});
