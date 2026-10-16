import type { EffectDispatchPort } from '@relavium/shared';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createInMemoryEffectJournalStore } from '../engine/execution-host.js';
import { createToolRegistry } from './registry.js';
import type { ToolCallPart, ToolDef, ToolDispatchContext } from './types.js';

interface Person {
  readonly label: string;
  readonly confidentialNote: string;
}

function selection(which: 'alice' | 'bob') {
  const alice: Person = { label: 'alice', confidentialNote: 'SYNTHETIC_ALICE_NOTE' };
  const bob: Person = { label: 'bob', confidentialNote: 'SYNTHETIC_BOB_NOTE' };
  return { catalog: [alice, bob], selected: which === 'alice' ? alice : bob };
}

function expectedSelection(which: 'alice' | 'bob', omitDeclared: boolean) {
  const alice = {
    label: 'alice',
    ...(omitDeclared ? {} : { confidentialNote: 'SYNTHETIC_ALICE_NOTE' }),
  };
  const bob = { label: 'bob', ...(omitDeclared ? {} : { confidentialNote: 'SYNTHETIC_BOB_NOTE' }) };
  return { payload: { catalog: [alice, bob], selected: which === 'alice' ? alice : bob } };
}

function harness() {
  const store = createInMemoryEffectJournalStore();
  const inner = store.for({ kind: 'run', runId: 'r-alias', nodeId: 'n', attempt: 1 });
  const effects: EffectDispatchPort = {
    prepare: vi.fn((...args: Parameters<EffectDispatchPort['prepare']>) => inner.prepare(...args)),
    settle: vi.fn((...args: Parameters<EffectDispatchPort['settle']>) => inner.settle(...args)),
    discard: vi.fn((...args: Parameters<EffectDispatchPort['discard']>) => inner.discard(...args)),
  };
  const received: unknown[] = [];
  // z.unknown retains the payload graph; a recursive schema clone could hide the alias defect.
  const tool: ToolDef = {
    id: 'alias_publish',
    source: 'mcp',
    description: 'Offline alias-projection seam fixture',
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
  return {
    registry: createToolRegistry({ tools: [tool], host: {} }),
    context,
    received,
    store,
    effects,
  };
}

function call(payload: unknown): ToolCallPart {
  return { type: 'tool_call', id: 'alias-call', name: 'alias_publish', args: { payload } };
}

const METADATA = [
  { name: 'absent', keys: undefined, omitDeclared: false },
  { name: 'empty', keys: new Set<string>(), omitDeclared: false },
  { name: 'nonempty', keys: new Set(['confidentialNote']), omitDeclared: true },
];

describe.each(METADATA)(
  'W3S5 #94 actual registry joins with $name external metadata',
  ({ keys, omitDeclared }) => {
    it('REGISTRY_SELECTION preserves selected value in event and prepare copies without changing dispatch identity', async () => {
      const h = harness();
      const context = { ...h.context, ...(keys === undefined ? {} : { secretArgKeys: keys }) };
      for (const [slot, which] of ['alice', 'bob'].entries()) {
        if (which !== 'alice' && which !== 'bob') throw new TypeError('invalid fixture selection');
        const payload = selection(which);
        const outcome = await h.registry.dispatch(call(payload), { ...context, effectSlot: slot });
        expect(h.received[slot], 'REGISTRY_DISPATCH_IDENTITY').toBe(payload);
        expect(payload.selected).toBe(payload.catalog[slot]);
        expect(outcome.events.call.toolInput, 'REGISTRY_SELECTION_EVENT').toEqual(
          expectedSelection(which, omitDeclared),
        );
        expect(
          vi.mocked(h.effects.prepare).mock.calls[slot]?.[3],
          'REGISTRY_SELECTION_PREPARE',
        ).toEqual(expectedSelection(which, omitDeclared));
        expect(payload.selected.confidentialNote).toBe(
          which === 'alice' ? 'SYNTHETIC_ALICE_NOTE' : 'SYNTHETIC_BOB_NOTE',
        );
      }
      expect(h.store.rows()).toMatchObject([
        { state: 'committed', slot: 0 },
        { state: 'committed', slot: 1 },
      ]);
    });

    it('REGISTRY_REPLAY uses actual JSON argsKey equality and refuses changed selection at the same slot', async () => {
      const h = harness();
      const context = { ...h.context, ...(keys === undefined ? {} : { secretArgKeys: keys }) };
      const first = await h.registry.dispatch(call(selection('alice')), context);
      const replay = await h.registry.dispatch(call(selection('alice')), context);
      expect(replay.output, 'REGISTRY_REPLAY').toEqual(first.output);
      expect(h.received).toHaveLength(1);
      await expect(
        h.registry.dispatch(call(selection('bob')), context),
        'REGISTRY_CHANGED_SELECTION_CONFLICT',
      ).rejects.toMatchObject({
        name: 'ToolEffectConflictError',
        code: 'effect_conflict',
        retryable: false,
      });
      expect(h.received, 'REGISTRY_NO_DUPLICATE_DISPATCH').toHaveLength(1);
      expect(h.store.rows()).toHaveLength(1);
      await h.registry.dispatch(call(selection('bob')), { ...context, effectSlot: 1 });
      expect(h.received).toHaveLength(2);
      expect(h.store.rows()).toMatchObject([
        { slot: 0, state: 'committed' },
        { slot: 1, state: 'committed' },
      ]);
      expect(
        vi.mocked(h.effects.prepare).mock.calls.map((args) => args[3]),
        'REGISTRY_REPLAY_PROJECTIONS',
      ).toEqual([
        expectedSelection('alice', omitDeclared),
        expectedSelection('alice', omitDeclared),
        expectedSelection('bob', omitDeclared),
        expectedSelection('bob', omitDeclared),
      ]);
      // This reference journal owns JSON.stringify argsKey, not a physical SHA-256 digest.
    });

    it('REGISTRY_CYCLE keeps a finite ancestor marker and expands repeated cycle-bearing siblings', async () => {
      const h = harness();
      const shared: Record<string, unknown> = {
        label: 'cycle',
        confidentialNote: 'SYNTHETIC_CYCLE_NOTE',
      };
      const children: unknown[] = [shared];
      shared['children'] = children;
      const payload = { first: shared, second: shared };
      const outcome = await h.registry.dispatch(call(payload), {
        ...h.context,
        ...(keys === undefined ? {} : { secretArgKeys: keys }),
      });
      const branch = {
        label: 'cycle',
        ...(omitDeclared ? {} : { confidentialNote: 'SYNTHETIC_CYCLE_NOTE' }),
        children: ['[cyclic]'],
      };
      for (const projection of [
        outcome.events.call.toolInput,
        vi.mocked(h.effects.prepare).mock.calls[0]?.[3],
      ]) {
        expect(projection, 'REGISTRY_CYCLE').toEqual({
          payload: { first: branch, second: branch },
        });
      }
      expect(h.received[0]).toBe(payload);
      expect(shared['children']).toBe(children);
      expect(children[0]).toBe(shared);
    });

    it('REGISTRY_NATIVE unwinds repeated native early returns in both prewalk joins', async () => {
      const h = harness();
      const date = new Date('2026-10-16T00:00:00.000Z');
      const native = new Map([['label', 'native']]);
      const payload = { dates: [date, date], natives: [native, native] };
      const outcome = await h.registry.dispatch(call(payload), {
        ...h.context,
        ...(keys === undefined ? {} : { secretArgKeys: keys }),
      });
      for (const projection of [
        outcome.events.call.toolInput,
        vi.mocked(h.effects.prepare).mock.calls[0]?.[3],
      ]) {
        expect(projection, 'REGISTRY_NATIVE').toEqual({
          payload: { dates: [date, date], natives: [native, native] },
        });
      }
      expect(h.received[0]).toBe(payload);
      expect(payload.dates[0]).toBe(date);
      expect(payload.natives[1]).toBe(native);
      // The reference journal permits JSON-native rendering. Native objects are not a
      // canonical SQLite digest positive; that boundary intentionally refuses them.
    });

    it('REGISTRY_REDACTION keeps credential and media bytes out of both actual projection sinks', async () => {
      const h = harness();
      const shared = {
        label: 'clean',
        api_key: 'SYNTHETIC_OPAQUE_KEY',
        pin: 7319,
        Authorization: 'Bearer SYNTHETIC_BEARER_CANARY',
        argv: ['--token', 'SYNTHETIC_FLAG_CANARY', '-p', '2222'],
        image: { kind: 'base64', data: 'U1lOVEhFVElDX01FRElBX0NBTkFSWQ==' },
        confidentialNote: 'SYNTHETIC_DECLARED_CANARY',
      };
      const payload = { left: shared, right: shared };
      const outcome = await h.registry.dispatch(call(payload), {
        ...h.context,
        ...(keys === undefined ? {} : { secretArgKeys: keys }),
      });
      const branch = {
        label: 'clean',
        api_key: '[redacted]',
        pin: '[redacted]',
        Authorization: 'Bearer [redacted]',
        argv: ['--token', '[redacted]', '-p', '2222'],
        image: { kind: 'base64', base64Length: shared.image.data.length },
        ...(omitDeclared ? {} : { confidentialNote: 'SYNTHETIC_DECLARED_CANARY' }),
      };
      for (const projection of [
        outcome.events.call.toolInput,
        vi.mocked(h.effects.prepare).mock.calls[0]?.[3],
      ]) {
        expect(projection, 'REGISTRY_REDACTION').toEqual({
          payload: { left: branch, right: branch },
        });
        const text = JSON.stringify(projection);
        for (const canary of [
          'SYNTHETIC_OPAQUE_KEY',
          '7319',
          'SYNTHETIC_BEARER_CANARY',
          'SYNTHETIC_FLAG_CANARY',
          shared.image.data,
        ])
          expect(text).not.toContain(canary);
        if (omitDeclared) expect(text).not.toContain('SYNTHETIC_DECLARED_CANARY');
      }
      expect(h.received[0]).toBe(payload);
      expect(payload.right).toBe(payload.left);
      expect(shared.api_key).toBe('SYNTHETIC_OPAQUE_KEY');
    });
  },
);
