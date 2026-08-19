/**
 * The prepare/settle bracket at the dispatch chokepoint
 * ([ADR-0080](../../../../docs/decisions/0080-durable-effect-journal-and-the-tiered-effect-contract.md) §7;
 * canonical contract in [effect-journal.md](../../../../docs/reference/shared-core/effect-journal.md) §7,
 * and crash-matrix points 1-3, 6 and 8 of §12).
 *
 * **Why this file exists.** A review measured that the ENTIRE bracket could be deleted — `prepare`, both
 * settles and the retryable stamping — and all 3,594 tests in the repository stayed green. The fixtures that
 * were handed a journal only satisfied a type requirement; nothing ever looked at a row. Every test here
 * asserts on what was actually journaled, or on the classification a journaled failure produces.
 */

import { isEffectConflictError, type EffectState } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import {
  createInMemoryEffectJournal,
  createInMemoryEffectJournalStore,
} from '../engine/execution-host.js';
import { BUILTIN_TOOLS } from './builtins.js';
import { ToolExecutionError } from './errors.js';
import { createToolRegistry } from './registry.js';
import { z } from 'zod';

import type { ToolDef, ToolDispatchContext, ToolHost } from './types.js';

/** A recording journal that also reports the ORDER of calls relative to the dispatch. */
function recordingJournal(): {
  port: ToolDispatchContext['effects'];
  rows: () => readonly { slot: number; toolId: string; state: EffectState }[];
  order: string[];
} {
  const inner = createInMemoryEffectJournal({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 });
  const order: string[] = [];
  return {
    port: {
      prepare: async (slot, toolId, tier, redacted, key) => {
        order.push('prepare');
        return inner.prepare(slot, toolId, tier, redacted, key);
      },
      settle: async (slot, toolId, state, result) => {
        order.push(`settle:${state}`);
        await inner.settle(slot, toolId, state, result);
      },
    },
    rows: () => inner.rows(),
    order,
  };
}

function ctxWith(journal: ReturnType<typeof recordingJournal>): ToolDispatchContext {
  return {
    nodeId: 'n1',
    grantedToolIds: new Set(['http_request', 'read_file']),
    config: {},
    toolPolicy: { allowedDomains: ['api.example'] },
    fsScope: 'sandboxed',
    gateApproved: false,
    effects: journal.port,
    effectSlot: 0,
  };
}

/** A host whose egress arm behaves as the test asks — the only capability these tools need. */
function hostWith(egress: (() => Promise<unknown>) | undefined): ToolHost {
  return {
    ...(egress === undefined ? {} : { egress: { fetch: () => egress() } }),
  } as ToolHost;
}

const TOOLS: readonly ToolDef[] = BUILTIN_TOOLS;
const POST = {
  type: 'tool_call' as const,
  name: 'http_request',
  id: 'c1',
  args: { url: 'https://api.example/x', method: 'POST' },
};

describe('the effect journal brackets a dispatch (ADR-0080 §7)', () => {
  it('prepares BEFORE the call and settles committed after it — in that order', async () => {
    const journal = recordingJournal();
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });

    await registry.dispatch(POST, ctxWith(journal));

    // The ORDER is the guarantee: a prepare after the call would record an effect that may already have
    // happened, which is the crash window the journal exists to close.
    expect(journal.order).toEqual(['prepare', 'settle:committed']);
    expect(journal.rows()).toEqual([
      expect.objectContaining({
        slot: 0,
        toolId: 'http_request',
        tier: 3,
        state: 'committed',
        result: expect.anything() as unknown,
      }),
    ]);
  });

  it('settles AMBIGUOUS when the call throws — the effect may have landed', async () => {
    // §12 point 3. "We do not know what the target did" is the honest record, and it is what a resumed run
    // needs in order to refuse rather than silently re-fire.
    const journal = recordingJournal();
    const host = hostWith(() => Promise.reject(new Error('ECONNRESET mid-POST')));
    const registry = createToolRegistry({ tools: TOOLS, host });

    await expect(registry.dispatch(POST, ctxWith(journal))).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
    expect(journal.order).toEqual(['prepare', 'settle:ambiguous']);
    expect(journal.rows()[0]?.state).toBe('ambiguous');
  });

  it('a dispatch throw on a journaled effect is NOT node-retryable', async () => {
    // THE blocker this file was written for. `tool_failed` is in RETRYABLE_ERROR_CODES, and the engine gates
    // purely on `error.retryable` — so a `true` here re-dispatches the node after a possibly-landed effect.
    // A timed-out POST is the canonical case, and it was reported as retryable until this was pinned.
    const journal = recordingJournal();
    const host = hostWith(() => Promise.reject(new Error('timeout')));
    const registry = createToolRegistry({ tools: TOOLS, host });

    await expect(registry.dispatch(POST, ctxWith(journal))).rejects.toMatchObject({
      retryable: false,
    });
  });

  it('a NON-journaled tool keeps its ordinary retryable classification — the negative control', async () => {
    // Without this the assertion above passes for an implementation that made everything non-retryable,
    // which would silently disable the node-retry budget for every transient read failure.
    const journal = recordingJournal();
    const host = hostWith(() => Promise.reject(new Error('timeout')));
    const registry = createToolRegistry({ tools: TOOLS, host });
    const GET = {
      type: 'tool_call' as const,
      name: 'http_request',
      id: 'c2',
      args: { url: 'https://api.example/x' },
    };

    await expect(registry.dispatch(GET, ctxWith(journal))).rejects.toMatchObject({
      retryable: true,
    });
    expect(journal.rows()).toEqual([]); // …and a GET is journaled at all
  });

  it('a prepare CONFLICT refuses the dispatch, and is not retryable either', async () => {
    // §12 point 7's engine half. A retry would re-collide on the same identity, burn the whole node budget
    // and report `tool_failed` — the wrong cause for "another attempt owns this effect".
    let dispatched = 0;
    const host = hostWith(() => {
      dispatched += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      });
    });
    const registry = createToolRegistry({ tools: TOOLS, host });
    // An UNRESOLVED prior row is the true collision: a live attempt holds the identity and has not said what
    // the target did. (A *committed* row with the same args is the REPLAY case, tested separately — that one
    // deliberately does NOT refuse.)
    const journalWithHeldRow = recordingJournal();
    await journalWithHeldRow.port.prepare(0, 'http_request', 3, {});

    await expect(registry.dispatch(POST, ctxWith(journalWithHeldRow))).rejects.toMatchObject({
      retryable: false,
      runErrorCode: 'effect_needs_attention',
    });

    expect(dispatched).toBe(0); // the refused attempt never reached the target
  });

  it('a prepare that FAILS refuses the dispatch — no journal row means no way to tell resume anything', async () => {
    // §12 point 1. Fail-closed: if the intent cannot be recorded, the effect must not happen.
    let dispatched = 0;
    const host = hostWith(() => {
      dispatched += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      });
    });
    const registry = createToolRegistry({ tools: TOOLS, host });
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: {
        prepare: () => Promise.reject(new Error('history.db is locked')),
        settle: () => Promise.resolve(),
      },
    };

    await expect(registry.dispatch(POST, ctx)).rejects.toBeDefined();
    expect(dispatched).toBe(0);
  });

  it('two effects in one node get two rows at two slots', async () => {
    // §12 point 6, end to end through the registry rather than at the store.
    const journal = recordingJournal();
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const ctx = ctxWith(journal);

    await registry.dispatch(POST, ctx);
    await registry.dispatch({ ...POST, id: 'c2' }, { ...ctx, effectSlot: 1 });

    expect(journal.rows().map((r) => r.slot)).toEqual([0, 1]);
  });

  it('a MISSING capability is not ambiguous — it demonstrably never left the process', async () => {
    // Recording a wiring gap as `ambiguous` would leave a permanently unresolved row for a call that
    // provably never happened, and (once the gate lands) block the node on a human for a config error.
    const journal = recordingJournal();
    const registry = createToolRegistry({ tools: TOOLS, host: hostWith(undefined) });

    await expect(registry.dispatch(POST, ctxWith(journal))).rejects.toBeDefined();
    expect(journal.order).toEqual(['prepare']); // prepared, then NOT settled ambiguous
    expect(journal.rows()[0]?.state).toBe('prepared');
  });

  it('two turns of ONE session do not collide — the correlation carries the turn', async () => {
    // The bug this pins was found by RUNNING it: the CLI froze the session correlation at `turn: 0` for the
    // session's whole life while the slot ordinal restarts each turn, so a user's second effectful request
    // in one chat collided with their first and was refused — permanently, since nothing sweeps the row.
    // One SHARED store, because that is what a `history.db` is; a fresh journal per correlation would make
    // the collision unreachable and the test vacuous.
    const store = createInMemoryEffectJournalStore();
    const turnOne = store.for({ kind: 'session', sessionId: 's1', turn: 0 });
    const turnTwo = store.for({ kind: 'session', sessionId: 's1', turn: 1 });

    await turnOne.prepare(0, 'run_command', 3, {});
    await expect(turnTwo.prepare(0, 'run_command', 3, {})).resolves.toEqual({ outcome: 'proceed' });
    expect(store.rows().map((r) => r.scope)).toEqual(['session:s1:0', 'session:s1:1']);

    // …and the same turn twice at one slot IS a collision — the property that makes the above meaningful.
    await expect(turnOne.prepare(0, 'run_command', 3, {})).rejects.toSatisfy(isEffectConflictError);
  });

  it('a `!`-command and a model tool call never collide, whatever their counters do', async () => {
    // They share one correlation, so a shared ordinal collides them: `!`-command 1 and the model's second
    // tool call of that turn would both be slot 1 on the journal's UNIQUE identity, and the second to arrive
    // would be refused as a duplicate of an unrelated effect. The shell uses NEGATIVE ordinals, which cannot
    // meet the model's non-negative ones however either counter advances.
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'session', sessionId: 's1', turn: 0 });

    await port.prepare(0, 'run_command', 3, {}); // the model's first tool call
    await port.prepare(1, 'run_command', 3, {}); // …its second
    await expect(port.prepare(-1, 'run_command', 3, {})).resolves.toEqual({ outcome: 'proceed' }); // `!` 1
    await expect(port.prepare(-2, 'run_command', 3, {})).resolves.toEqual({ outcome: 'proceed' }); // `!` 2

    expect(
      store
        .rows()
        .map((r) => r.slot)
        .sort((a, b) => a - b),
    ).toEqual([-2, -1, 0, 1]);
  });

  it('journals the SANITIZED args, never the raw ones', async () => {
    // ADR-0080 §11. The digest is durable and never swept, so a secret hashed into it is a permanent offline
    // oracle — strictly worse than the same string in an ephemeral event. A review measured this by swapping
    // the sanitized projection for the raw `effective` args: 1,209 core tests stayed green.
    const captured: unknown[] = [];
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      secretArgKeys: new Set(['authorization']),
      effects: {
        prepare: (_slot, _toolId, _tier, redacted) => {
          captured.push(redacted);
          return Promise.resolve({ outcome: 'proceed' });
        },
        settle: () => Promise.resolve(),
      },
    };

    await registry.dispatch(
      {
        ...POST,
        args: {
          url: 'https://api.example/x',
          method: 'POST',
          // The URL itself cannot carry userinfo — `http_request`'s own guardrail rejects that before
          // dispatch. A BODY can, and does: this is what registering a webhook or seeding a config looks like.
          body: '{"dsn":"postgres://admin:hunter2pass@db.internal:5432/app"}',
          headers: { authorization: 'Bearer sk-live-abcdefghijklmnop' },
        },
      },
      ctx,
    );

    const serialized = JSON.stringify(captured[0]);
    expect(serialized).not.toContain('hunter2pass'); // URL userinfo — the shape a connection string takes
    expect(serialized).not.toContain('sk-live-abcdefghijklmnop'); // a declared secret arg key
    expect(serialized).toContain('api.example'); // …and the diagnostic half survives
  });

  it('journals the sanitized args through the REAL call site, not the primitive in isolation', async () => {
    // **The test this file's first digest assertion should have been.** That one called
    // `redactSecretShapedValue({password: …})` directly — the primitive, handed a whole object — and passed
    // while the production path leaked. `sanitizeInput` looped per key and passed each VALUE to the walker,
    // so a TOP-LEVEL secretish key never reached the key rule at all: only nested members did, because only
    // there does `Object.entries` still have the key attached. A review measured it end to end through
    // `createToolRegistry` and recovered `api_key` verbatim from the digest input.
    //
    // Both sinks are covered by asserting on the value handed to `prepare`: that same projection is what
    // `agent:tool_call.toolInput` carries onto the `--json`/event/log stream.
    const captured: unknown[] = [];
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: {
        prepare: (_slot, _toolId, _tier, redacted) => {
          captured.push(redacted);
          return Promise.resolve({ outcome: 'proceed' });
        },
        settle: () => Promise.resolve(),
      },
    };

    // A tool whose OWN top-level parameter is secretish — the shape an MCP server declares freely, and the
    // one that leaked. `http_request`'s fixed schema cannot express it, so the def is local to this test.
    const mcpish = {
      id: 'vendor_publish',
      source: 'mcp',
      description: '',
      policy: { requiresGateApproval: false },
      parseArgs: (v: unknown) =>
        z.object({ endpoint: z.string(), api_key: z.string() }).strict().parse(v),
      llmVisibleParams: { type: 'object' },
      effect: () => 3,
      dispatch: () => Promise.resolve({ ok: true }),
    } as unknown as ToolDef;
    const withMcp = createToolRegistry({ tools: [...TOOLS, mcpish], host });

    const outcome = await withMcp.dispatch(
      {
        type: 'tool_call',
        name: 'vendor_publish',
        id: 'c9',
        args: { endpoint: 'https://api.example/x', api_key: 'hunter2-l0w-entropy' },
      },
      {
        ...ctx,
        grantedToolIds: new Set(['vendor_publish']),
        secretArgKeys: new Set<string>(),
      },
    );

    for (const projection of [captured[0], outcome.events.call.toolInput]) {
      expect(JSON.stringify(projection)).not.toContain('hunter2-l0w-entropy');
      expect(JSON.stringify(projection)).toContain('api.example'); // …the diagnostic half survives
    }
  });

  it('a settle that FAILS is reported as needing attention, not as an ordinary tool failure', async () => {
    // §7 step 4: the effect provably landed and the record does not say so. Falling into the generic ladder
    // made it `tool_failed`, which on the chat surface routes to "fix the target and resend" — the one
    // instruction that could make a human repeat a real external effect.
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: {
        prepare: () => Promise.resolve({ outcome: 'proceed' }),
        settle: () => Promise.reject(new Error('history.db went away')),
      },
    };

    await expect(registry.dispatch(POST, ctx)).rejects.toMatchObject({
      runErrorCode: 'effect_needs_attention',
      retryable: false,
    });
  });

  it('a REPLAY re-delivers the stored result and never touches the target (§4)', async () => {
    // §4's one forward path for a resumed node. Same identity, same args digest, result retained → the
    // stored result stands in for the call. Re-running it is precisely the duplicate the journal prevents.
    const store = createInMemoryEffectJournalStore();
    let dispatched = 0;
    const host = hostWith(() => {
      dispatched += 1;
      return Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      });
    });
    const registry = createToolRegistry({ tools: TOOLS, host });
    const correlation = { kind: 'run' as const, runId: 'r1', nodeId: 'n1', attempt: 1 };
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: store.for(correlation),
    };

    const first = await registry.dispatch(POST, ctx);
    // The second dispatch is the RESUME: a new attempt, same scope (the attempt is dropped), same args.
    const second = await registry.dispatch(POST, {
      ...ctx,
      effects: store.for({ ...correlation, attempt: 2 }),
    });

    expect(dispatched).toBe(1); // …the target was hit exactly once
    expect(second.output).toEqual(first.output); // …and the model sees the same result
    expect(store.rows()).toHaveLength(1); // …with no second row invented for the replay
  });

  it('a replay re-delivers the ORIGINAL output_mapping, even when the result was truncated', async () => {
    // A review's probe, turned into a regression. Settling only `bounded.value` meant the replay re-ran
    // `output_mapping` over the TRUNCATION PREVIEW: the first dispatch put `200` into workflow state and the
    // replay put `undefined` — silently, and only above the bounding ceiling. §4 promises to RE-DELIVER what
    // the original produced, so the projections are recorded rather than re-derived.
    const store = createInMemoryEffectJournalStore();
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'x'.repeat(4000), // comfortably past the tiny ceiling below
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const correlation = { kind: 'run' as const, runId: 'r1', nodeId: 'n1', attempt: 1 };
    const base: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      config: { outputMapping: { code: 'status' } },
      limits: { maxBytes: 200, maxLines: 20 },
      effects: store.for(correlation),
    };

    const first = await registry.dispatch(POST, base);
    const second = await registry.dispatch(POST, {
      ...base,
      effects: store.for({ ...correlation, attempt: 2 }),
    });

    expect(first.output).toEqual({ code: 200 });
    expect(second.output).toEqual(first.output); // …NOT `{}` re-derived from the preview
    expect(second.truncated).toBe(first.truncated);
    expect(second.events.result.outputSummary).toBe(first.events.result.outputSummary);
  });

  it('a replay is refused when the node’s `output_mapping` CONFIG changed in the crash window', async () => {
    // The same failure class as replaying a different call's result, reached from the other direction: the
    // recorded projection is not what the CURRENT config asks for. A review reproduced both — a mapping
    // configured at write and removed at read (workflow state gets the stale mapped value where the config
    // now wants the full result), and the reverse (it gets the raw blob where the config wants an extract).
    const store = createInMemoryEffectJournalStore();
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const correlation = { kind: 'run' as const, runId: 'r1', nodeId: 'n1', attempt: 1 };
    const base: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: store.for(correlation),
    };

    await registry.dispatch(POST, { ...base, config: { outputMapping: { code: 'status' } } });
    await expect(
      registry.dispatch(POST, {
        ...base,
        config: {}, // the YAML lost its mapping between the crash and the resume
        effects: store.for({ ...correlation, attempt: 2 }),
      }),
    ).rejects.toMatchObject({ runErrorCode: 'effect_needs_attention', retryable: false });
  });

  it('a replay is refused when the ARGS differ at the same slot', async () => {
    // The same slot with different args is a DIFFERENT call that happens to land in the same ordinal — the
    // model answered differently on the re-run. Re-delivering the old result would silently answer the new
    // question with the old answer, so this is `needs_attention`, not a replay.
    const store = createInMemoryEffectJournalStore();
    const host = hostWith(() =>
      Promise.resolve({
        status: 200,
        headers: {},
        body: 'ok',
        truncated: false,
        url: 'https://api.example/x',
      }),
    );
    const registry = createToolRegistry({ tools: TOOLS, host });
    const correlation = { kind: 'run' as const, runId: 'r1', nodeId: 'n1', attempt: 1 };
    const ctx: ToolDispatchContext = {
      ...ctxWith(recordingJournal()),
      effects: store.for(correlation),
    };

    await registry.dispatch(POST, ctx);
    await expect(
      registry.dispatch(
        { ...POST, args: { url: 'https://api.example/DIFFERENT', method: 'POST' } },
        { ...ctx, effects: store.for({ ...correlation, attempt: 2 }) },
      ),
    ).rejects.toMatchObject({ runErrorCode: 'effect_needs_attention', retryable: false });
  });

  it('a committed row with NO retained result is refused, not replayed', async () => {
    // "A committed row is not a green light" at the dispatch site. Without the result there is nothing to
    // re-deliver, so waving the call through would re-fire the effect to obtain a result we failed to keep.
    const store = createInMemoryEffectJournalStore();
    const port = store.for({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 1 });
    await port.prepare(0, 'http_request', 3, { url: 'https://api.example/x' });
    await port.settle(0, 'http_request', 'committed'); // …settled with no result

    await expect(
      store
        .for({ kind: 'run', runId: 'r1', nodeId: 'n1', attempt: 2 })
        .prepare(0, 'http_request', 3, { url: 'https://api.example/x' }),
    ).rejects.toSatisfy(isEffectConflictError);
  });

  it('the in-memory reference refuses a duplicate identity, exactly as the real store does', async () => {
    // The reference exists so a core test proves something. One that accepted what SQLite rejects would make
    // every test above vacuous — this repo has been bitten by exactly that divergence before.
    const journal = createInMemoryEffectJournal({
      kind: 'run',
      runId: 'r1',
      nodeId: 'n1',
      attempt: 1,
    });
    await journal.prepare(0, 'http_request', 3, {});
    await expect(journal.prepare(0, 'http_request', 3, {})).rejects.toSatisfy(
      isEffectConflictError,
    );
  });
});
