/**
 * A resume that verifies its own identity
 * ([ADR-0083](../../../../docs/decisions/0083-input-admission-and-a-resume-that-verifies-its-own-identity.md)
 * §5, §6, §8; acceptance 9.10, 9.11, 9.13, 9.15).
 *
 * Two levels, because the decision has two halves. The unit tests pin what `verifyResumeIdentity` decides;
 * the engine tests pin that `resumeFromCheckpoint` acts on it — refuses with the right code, and **releases
 * the lease** it acquired before it could know it would refuse (ADR-0079 §4).
 */

import type { RunEvent } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { parseWorkflow, type WorkflowDefinition } from '../parser.js';
import { deepStructuralEquals } from './deep-equal.js';
import { WorkflowEngine } from './engine.js';
import { EngineStateError, isTransientEngineStateError } from './errors.js';
import { createInMemoryHost, createInMemoryRunLeases, InMemoryRunStore } from './execution-host.js';
import type { NodeExecContext, NodeExecutor, NodeOutcome } from './node-executor.js';
import { verifyFrozenWorkflowContent, verifyResumeIdentity } from './resume-identity.js';

function workflowWith(inputs: string, id = 'identity-fixture'): WorkflowDefinition {
  return parseWorkflow(
    `schema_version: '1.0'
workflow:
  id: ${id}
  inputs:
${inputs}
  nodes:
    - { id: a, type: input }
    - { id: g, type: human_gate, gate_type: approval }
    - { id: b, type: output }
  edges:
    - { from: a, to: g }
    - { from: g, to: b }
`,
  );
}

const WF = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }`);

class Stub implements NodeExecutor {
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    return Promise.resolve({ kind: 'completed', output: ctx.vertex.id });
  }
}

/** An {@link InMemoryRunStore} whose snapshot READ rejects — the async throw the helper used to miss. */
class FailingSnapshotStore extends InMemoryRunStore {
  override readWorkflowSnapshot(): Promise<string | undefined> {
    return Promise.reject(new Error('the disk went away'));
  }
}

/** A {@link Stub} that records the `inputs` scope each node was executed with. */
class CapturingStub implements NodeExecutor {
  constructor(private readonly seen: Record<string, unknown>[]) {}
  execute(ctx: NodeExecContext): Promise<NodeOutcome> {
    this.seen.push({ ...ctx.inputs });
    return Promise.resolve({ kind: 'completed', output: ctx.vertex.id });
  }
}

// --- the decision ------------------------------------------------------------------------------

describe('verifyResumeIdentity — the record is the authority (ADR-0083 §5)', () => {
  const verify = (
    over: Partial<Parameters<typeof verifyResumeIdentity>[0]>,
  ): ReturnType<typeof verifyResumeIdentity> =>
    verifyResumeIdentity({
      workflow: WF,
      recordedInputs: { topic: 'the report', depth: 3 },
      recordedExecutionMode: 'local',
      suppliedInputs: undefined,
      suppliedExecutionMode: undefined,
      ...over,
    });

  it('an OMITTED caller copy takes the record — not a `{}` and not a `local` default', () => {
    // The two bugs this replaces, both live before it: `inputs: input.inputs ?? {}` dropped every input a
    // caller did not re-pass, and `executionMode: input.executionMode ?? 'local'` turned an omission into a
    // mode change on any run that started in `cloud` or `managed`.
    const result = verify({ recordedExecutionMode: 'cloud' });
    expect(result.ok).toBe(true);
    expect(result.ok && result.inputs).toEqual({ topic: 'the report', depth: 3 });
    expect(result.ok && result.executionMode).toBe('cloud');
  });

  it('a MATCHING caller copy is accepted, and the record is what comes back', () => {
    const result = verify({
      suppliedInputs: { topic: 'the report', depth: 3 },
      suppliedExecutionMode: 'local',
    });
    expect(result.ok).toBe(true);
    // The RECORD's map, built fresh — not the caller's object. §7's guarantee holds on this path too.
    expect(result.ok && Object.getPrototypeOf(result.inputs)).toBeNull();
  });

  it('a DIFFERENT input value is `input_mismatch`, and the message carries no value', () => {
    const result = verify({ suppliedInputs: { topic: 'a different report', depth: 3 } });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.refusal.code).toBe('input_mismatch');
    expect(!result.ok && result.refusal.message).toContain('topic');
    // VALUE-FREE: these are the run's own data, and an error message reaches every log sink.
    expect(!result.ok && result.refusal.message).not.toContain('a different report');
    expect(!result.ok && result.refusal.message).not.toContain('the report');
  });

  it('a caller input the run never had is `input_mismatch`', () => {
    // Accepting it would let a resume INTRODUCE an input — the run would continue under a map its own
    // `run:started` never recorded.
    const wf = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }
    - { name: extra, type: string }`);
    const result = verify({ workflow: wf, suppliedInputs: { extra: 'new' } });
    expect(!result.ok && result.refusal.code).toBe('input_mismatch');
  });

  it('a DIFFERENT executionMode is its own code — the fix is not the same fix', () => {
    const result = verify({ suppliedExecutionMode: 'cloud' });
    expect(!result.ok && result.refusal.code).toBe('execution_mode_mismatch');
    // Both sides are members of a closed enum, so naming them is safe and is the actionable part.
    expect(!result.ok && result.refusal.message).toContain('local');
    expect(!result.ok && result.refusal.message).toContain('cloud');
  });

  it('a `secret` slot must be RE-SUPPLIED — never substituted, defaulted, or dropped (§6)', () => {
    const wf = workflowWith(`    - { name: api_key, type: secret }`);
    const recorded = { api_key: { secret: true, ref: 'inputs.api_key' } };
    const missing = verify({ workflow: wf, recordedInputs: recorded, suppliedInputs: {} });
    expect(!missing.ok && missing.refusal.code).toBe('secret_input_missing');
    // An own `undefined` is an omission at admission and stays one here — it does not satisfy the slot.
    const undef = verify({
      workflow: wf,
      recordedInputs: recorded,
      suppliedInputs: { api_key: undefined },
    });
    expect(!undef.ok && undef.refusal.code).toBe('secret_input_missing');

    // …and neither does the PLACEHOLDER itself, which is what a caller rebuilding its map from the durable
    // record holds — `relavium gate` reads `runs.input_json`, where the value is exactly this shape.
    // Accepting it would continue the run with the mask as its credential.
    const placeholder = verify({
      workflow: wf,
      recordedInputs: recorded,
      suppliedInputs: { api_key: { secret: true, ref: 'inputs.api_key' } },
    });
    expect(!placeholder.ok && placeholder.refusal.code).toBe('secret_input_missing');

    const supplied = verify({
      workflow: wf,
      recordedInputs: recorded,
      suppliedInputs: { api_key: 'sk-live-value' },
    });
    expect(supplied.ok).toBe(true);
    // The SLOT is verified, not the credential (§6) — so the re-supplied value is what the run continues
    // with. Proving it is the same key would need the value persisted, which is the whole point of not.
    expect(supplied.ok && supplied.inputs).toEqual({ api_key: 'sk-live-value' });
  });

  it('a `secret` supplied for a slot the record does not carry is its own code', () => {
    const wf = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }
    - { name: api_key, type: secret }`);
    const result = verify({ workflow: wf, suppliedInputs: { api_key: 'sk-live' } });
    expect(!result.ok && result.refusal.code).toBe('secret_input_unexpected');
  });

  it('a record and a workflow that DISAGREE about secrecy refuse rather than guess', () => {
    // Either the record holds a raw value where a masked slot belongs — which this engine has never
    // emitted — or it holds a slot for an input no longer declared secret. Both are content divergence.
    const asSecret = workflowWith(`    - { name: topic, type: secret }
    - { name: depth, type: number }`);
    expect(!verify({ workflow: asSecret }).ok).toBe(true);

    const asPlain = verify({
      recordedInputs: { topic: { secret: true, ref: 'inputs.topic' }, depth: 3 },
    });
    expect(!asPlain.ok && asPlain.refusal.code).toBe('input_mismatch');
  });

  it('a LEGACY record keeps its own semantics — the default is not invented (§8, acceptance 9.15)', () => {
    // A run admitted before ADR-0083 landed applied no defaults, because nothing applied them. Resume
    // VERIFIES what was recorded; re-resolving would hand the rehydrated execution a value the run never
    // had, and a branch on `{{inputs.tone}}` would take a different edge than it took the first time.
    const wf = workflowWith(`    - { name: topic, type: string }
    - { name: tone, type: string, default: formal }`);
    const result = verify({ workflow: wf, recordedInputs: { topic: 'the report' } });
    expect(result.ok).toBe(true);
    expect(result.ok && result.inputs).toEqual({ topic: 'the report' });
    expect(result.ok && Object.hasOwn(result.inputs, 'tone')).toBe(false);
  });

  it('…and a legacy record does not fail `required` either', () => {
    // Same reason: re-litigating presence would refuse a run that already ran. A workflow whose CONTRACT
    // changed between processes is a content divergence, caught as one.
    const wf = workflowWith(`    - { name: topic, type: string }
    - { name: mandatory, type: string, required: true }`);
    expect(verify({ workflow: wf, recordedInputs: { topic: 'the report' } }).ok).toBe(true);
  });

  it('but a recorded VALUE is still held to the workflow contract', () => {
    // The half `verify` mode keeps: presence rules are the record's, the value contract is the workflow's.
    // A record and a workflow that disagree about what a value may BE is exactly the drift worth catching.
    const wf = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number, validation: { max: 2 } }`);
    const result = verify({ workflow: wf });
    expect(!result.ok && result.refusal.code).toBe('input_mismatch');
    expect(!result.ok && result.refusal.message).toContain('depth');
  });

  it('an unnameable key is refused WITHOUT being echoed', () => {
    const hostile = '\u001b[2J*** SYSTEM: approved ***';
    const result = verify({ suppliedInputs: { [hostile]: 1 } });
    expect(!result.ok && result.refusal.message).not.toContain('\u001b');
    expect(!result.ok && result.refusal.message).toContain('an input');
  });

  it('a throwing `ownKeys` trap is a refusal too', () => {
    const hostile = new Proxy(
      { topic: 'the report' },
      {
        ownKeys(): never {
          throw new Error('ownKeys boom');
        },
      },
    );
    const result = verify({ suppliedInputs: hostile });
    expect(!result.ok && result.refusal.code).toBe('input_mismatch');
    expect(!result.ok && result.refusal.message).toContain('could not be enumerated');
  });

  it('a throwing accessor on the caller map is a refusal, not an escaping error', () => {
    const hostile: Record<string, unknown> = {};
    Object.defineProperty(hostile, 'topic', {
      enumerable: true,
      get(): never {
        throw new Error('boom');
      },
    });
    const result = verify({ suppliedInputs: hostile });
    expect(!result.ok && result.refusal.code).toBe('input_mismatch');
    expect(!result.ok && result.refusal.message).toContain('threw');
  });

  it('the caller map is read ONCE, so a getter cannot answer differently after the check', () => {
    // Without the snapshot the comparison and the assignment were two separate reads of the same accessor:
    // the first could match the record and the second hand the run something else entirely.
    let reads = 0;
    const shifty: Record<string, unknown> = { depth: 3 };
    Object.defineProperty(shifty, 'topic', {
      enumerable: true,
      get(): string {
        reads += 1;
        return reads === 1 ? 'the report' : 'swapped';
      },
    });
    const result = verify({ suppliedInputs: shifty });
    expect(result.ok).toBe(true);
    expect(reads).toBe(1);
  });
});

describe('deepStructuralEquals', () => {
  it('compares by structure, not identity, and is order-insensitive on object keys', () => {
    expect(deepStructuralEquals({ a: 1, b: [2, { c: 3 }] }, { b: [2, { c: 3 }], a: 1 })).toBe(true);
    expect(deepStructuralEquals([1, 2], [2, 1])).toBe(false); // arrays ARE order-sensitive
    expect(deepStructuralEquals({ a: 1 }, { a: 1, b: undefined })).toBe(false); // key count differs
  });

  it('compares a null-prototype map against a plain one — the engine builds the former', () => {
    // §7 builds every admitted map with `Object.create(null)`, so requiring `Object.prototype` here would
    // make the record and a caller's literal unequal and refuse every single resume.
    const built: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    built['topic'] = 'x';
    expect(deepStructuralEquals(built, { topic: 'x' })).toBe(true);
  });

  it('uses `Object.is`, matching the enum rule', () => {
    expect(deepStructuralEquals({ n: Number.NaN }, { n: Number.NaN })).toBe(true);
    expect(deepStructuralEquals({ n: 0 }, { n: -0 })).toBe(false);
  });

  it('does not treat an inherited property as a value the object carries', () => {
    // An object with a NON-standard prototype is refused outright, before key comparison — a caller map
    // built on `Object.create({ topic: 'x' })` is not a plain map and is not treated as one.
    expect(deepStructuralEquals({ topic: 'x' }, Object.create({ topic: 'x' }))).toBe(false);

    // The narrow case `Object.hasOwn` is actually there for: both sides ARE plain objects, the key counts
    // match, and the inherited member comes from `Object.prototype` itself. Under `key in b` these compare
    // EQUAL — measured — because `b.toString` resolves through the prototype to the very function `a`
    // carries as data. Contrived, and pinned anyway: this function decides whether a resume proceeds.
    // Read through the descriptor rather than `Object.prototype.toString`, which lint flags as an unbound
    // method — the reference is what matters, not how it is obtained.
    const inherited: unknown = Object.getOwnPropertyDescriptor(Object.prototype, 'toString')?.value;
    expect(deepStructuralEquals({ toString: inherited, x: 2 }, { x: 2, y: 3 })).toBe(false);
  });

  it('fails CLOSED on a shape parsed data never contains', () => {
    // A `Date`, a `Map`, a class instance: compared by `Object.is`, so two separately-constructed ones are
    // unequal. For an identity check that is the safe direction — it refuses rather than assuming.
    expect(deepStructuralEquals(new Map([['a', 1]]), new Map([['a', 1]]))).toBe(false);
    expect(deepStructuralEquals({ d: new Date(0) }, { d: new Date(0) })).toBe(false);
  });

  it('terminates on a self-referential structure instead of recursing forever', () => {
    const a: Record<string, unknown> = { name: 'x' };
    a['self'] = a;
    const b: Record<string, unknown> = { name: 'x' };
    b['self'] = b;
    expect(deepStructuralEquals(a, b)).toBe(true);
  });
});

describe('verifyFrozenWorkflowContent — the same slug is not the same graph (ADR-0083 §5)', () => {
  it('accepts the definition the run was frozen with, however it was formatted', () => {
    // Structural, not textual: the frozen column holds `JSON.stringify(definition)`, and re-serialising the
    // same object with different key order or whitespace must not read as a divergence. That is the whole
    // reason this is not a digest over the stored text.
    expect(verifyFrozenWorkflowContent(JSON.stringify(WF), WF)).toBeUndefined();
    expect(verifyFrozenWorkflowContent(JSON.stringify(WF, null, 2), WF)).toBeUndefined();
  });

  it('refuses the SAME slug with edited content — the drift the id guard cannot see', () => {
    // `resolveWorkflowId` maps a slug to a surrogate UUID, so an edited-but-same-slug workflow passes the
    // identity guard untouched. That is the gap ADR-0079 §4 deferred to a content hash and this closes.
    const edited = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }
    - { name: sneaked_in, type: string }`);
    expect(edited.workflow.id).toBe(WF.workflow.id); // same slug — the id guard is satisfied
    const refusal = verifyFrozenWorkflowContent(JSON.stringify(WF), edited);
    expect(refusal?.code).toBe('workflow_content_mismatch');
    // VALUE-FREE: naming the differing field means echoing authored graph content into every log sink.
    expect(refusal?.message).not.toContain('sneaked_in');
  });

  it('distinguishes an UNREADABLE record from a differing one — the remedies differ', () => {
    // "Your workflow changed" and "the stored definition is corrupt" send a user to different places.
    expect(verifyFrozenWorkflowContent('{not json', WF)?.code).toBe('admission_record_unreadable');
    expect(verifyFrozenWorkflowContent('null', WF)?.code).toBe('admission_record_unreadable');
    const junk = '{"marker_xyz":"a value from a file this process never wrote"}';
    expect(verifyFrozenWorkflowContent(junk, WF)?.code).toBe('admission_record_unreadable');
    // …and the unreadable message carries no content from the record it could not read.
    expect(verifyFrozenWorkflowContent(junk, WF)?.message).not.toContain('marker_xyz');
  });
});

// --- the engine acts on it ---------------------------------------------------------------------

describe('resumeFromCheckpoint — identity refusals release the lease (acceptance 9.11)', () => {
  async function seedPaused(store: InMemoryRunStore, runId: string): Promise<void> {
    const workflowId = await store.resolveWorkflowId(WF.workflow.id);
    const base = { runId, timestamp: '2026-01-01T00:00:00.000Z' } as const;
    const events: RunEvent[] = [
      {
        ...base,
        type: 'run:started',
        sequenceNumber: 0,
        workflowId,
        inputs: { topic: 'the report', depth: 3 },
        executionMode: 'local',
      },
      {
        ...base,
        type: 'human_gate:paused',
        sequenceNumber: 1,
        nodeId: 'g',
        gateId: 'gate-1',
        gateType: 'approval',
        message: 'approve?',
      },
      { ...base, type: 'run:paused', sequenceNumber: 2, gateIds: ['gate-1'], pendingGateCount: 1 },
    ];
    for (const event of events) await store.persistEvent(event);
  }

  async function refuse(
    over: Parameters<WorkflowEngine['resumeFromCheckpoint']>[0] extends infer T
      ? Partial<T>
      : never,
  ): Promise<EngineStateError> {
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    await seedPaused(store, 'run-id');
    const engine = new WorkflowEngine({ host, executor: new Stub() });
    let caught: unknown;
    try {
      await engine.resumeFromCheckpoint({ runId: 'run-id', workflow: WF, ...over });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(EngineStateError);
    // ADR-0079 §4: an acquire that leads nowhere must not leak. Every identity check sits AFTER ownership
    // was taken, so each one owns the release — and a stranded lease locks the run for a full TTL.
    expect(await leases.read('run-id')).toBeUndefined();
    return caught as EngineStateError;
  }

  it('refuses a resume whose inputs differ, and does not continue the run', async () => {
    const error = await refuse({ inputs: { topic: 'something else', depth: 3 } });
    expect(error.code).toBe('input_mismatch');
    expect(isTransientEngineStateError(error)).toBe(false); // permanent: the same call fails forever
  });

  it('refuses a resume whose executionMode differs', async () => {
    const error = await refuse({ executionMode: 'cloud' });
    expect(error.code).toBe('execution_mode_mismatch');
  });

  it('refuses a resume that omits a required `secret`', async () => {
    const store = new InMemoryRunStore();
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    const secretWf = workflowWith(`    - { name: api_key, type: secret }`, 'identity-fixture');
    const workflowId = await store.resolveWorkflowId(secretWf.workflow.id);
    await store.persistEvent({
      type: 'run:started',
      runId: 'run-secret',
      sequenceNumber: 0,
      timestamp: '2026-01-01T00:00:00.000Z',
      workflowId,
      // As the engine masks it at emit — the record holds the SLOT, never the credential.
      inputs: { api_key: { secret: true, ref: 'inputs.api_key' } },
      executionMode: 'local',
    });
    await store.persistEvent({
      type: 'human_gate:paused',
      runId: 'run-secret',
      sequenceNumber: 1,
      timestamp: '2026-01-01T00:00:00.000Z',
      nodeId: 'g',
      gateId: 'gate-1',
      gateType: 'approval',
      message: 'approve?',
    });
    await store.persistEvent({
      type: 'run:paused',
      runId: 'run-secret',
      sequenceNumber: 2,
      timestamp: '2026-01-01T00:00:00.000Z',
      gateIds: ['gate-1'],
      pendingGateCount: 1,
    });

    const engine = new WorkflowEngine({ host, executor: new Stub() });
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-secret', workflow: secretWf }),
    ).rejects.toMatchObject({ code: 'secret_input_missing' });
    expect(await leases.read('run-secret')).toBeUndefined();

    // …and supplying it proceeds. The persisted record still holds only the ref (acceptance 9.13).
    const engineB = new WorkflowEngine({ host, executor: new Stub() });
    const handle = await engineB.resumeFromCheckpoint({
      runId: 'run-secret',
      workflow: secretWf,
      inputs: { api_key: 'sk-live-value' },
      gateId: 'gate-1',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    for await (const event of handle.events) void event;
    const persisted = JSON.stringify(store.eventsFor('run-secret'));
    expect(persisted).not.toContain('sk-live-value');
    expect(persisted).toContain('inputs.api_key');
  });

  it('refuses a content-different workflow, and releases the lease (acceptance 9.11)', async () => {
    const store = new InMemoryRunStore(JSON.stringify(WF));
    const leases = createInMemoryRunLeases();
    const host = createInMemoryHost({ store, runLeases: leases });
    await seedPaused(store, 'run-content');
    const edited = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }
    - { name: sneaked_in, type: string }`);

    const engine = new WorkflowEngine({ host, executor: new Stub() });
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-content', workflow: edited }),
    ).rejects.toMatchObject({ code: 'workflow_content_mismatch' });
    expect(await leases.read('run-content')).toBeUndefined();
  });

  it('…and accepts the frozen one, so the check discriminates', async () => {
    const store = new InMemoryRunStore(JSON.stringify(WF));
    const host = createInMemoryHost({ store });
    await seedPaused(store, 'run-content-ok');
    const engine = new WorkflowEngine({ host, executor: new Stub() });
    const handle = await engine.resumeFromCheckpoint({
      runId: 'run-content-ok',
      workflow: WF,
      gateId: 'gate-1',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const seen: RunEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(seen.some((event) => event.type === 'run:completed')).toBe(true);
  });

  it('skips content verification when the store holds no frozen definition', async () => {
    // `undefined` means "this store keeps no snapshot for this run", which is the honest answer for a
    // fixture that was never given one — not a silently disabled check. Every other identity check still runs.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    await seedPaused(store, 'run-nosnap');
    const engine = new WorkflowEngine({ host, executor: new Stub() });
    const edited = workflowWith(`    - { name: topic, type: string }
    - { name: depth, type: number }
    - { name: sneaked_in, type: string }`);
    // The graph differs and is NOT refused on content — but the inputs still are, because that record exists.
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-nosnap', workflow: edited, inputs: { topic: 'x' } }),
    ).rejects.toMatchObject({ code: 'input_mismatch' });
  });

  it('releases the lease when the snapshot READ itself rejects', async () => {
    // `#releaseFenceOnThrow` returned its body un-awaited, so a rejecting async body skipped the catch and
    // stranded the claim for a full TTL. Latent while its only caller was the synchronous `buildRunPlan`.
    const store = new FailingSnapshotStore();
    const leases = createInMemoryRunLeases();
    await seedPaused(store, 'run-readfail');
    const host = createInMemoryHost({ store, runLeases: leases });
    const engine = new WorkflowEngine({ host, executor: new Stub() });
    await expect(
      engine.resumeFromCheckpoint({ runId: 'run-readfail', workflow: WF }),
    ).rejects.toThrow('the disk went away');
    expect(await leases.read('run-readfail')).toBeUndefined();
  });

  it('continues with the RECORDED inputs when the caller passes none', async () => {
    // The observable half of §5. `inputs: input.inputs ?? {}` meant a `relavium gate` that did not
    // reconstruct the map resumed the run with an EMPTY one — every `{{inputs.*}}` reference downstream of
    // the gate resolving against nothing, in a run whose own `run:started` recorded two values.
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    await seedPaused(store, 'run-carry');
    const seenInputs: Record<string, unknown>[] = [];
    const engine = new WorkflowEngine({ host, executor: new CapturingStub(seenInputs) });
    const handle = await engine.resumeFromCheckpoint({
      runId: 'run-carry',
      workflow: WF,
      gateId: 'gate-1',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    for await (const event of handle.events) void event;
    expect(seenInputs.length).toBeGreaterThan(0);
    expect(seenInputs[0]).toEqual({ topic: 'the report', depth: 3 });
  });

  it('resumes cleanly when the caller passes the same inputs it started with', async () => {
    const store = new InMemoryRunStore();
    const host = createInMemoryHost({ store });
    await seedPaused(store, 'run-ok');
    const engine = new WorkflowEngine({ host, executor: new Stub() });
    const handle = await engine.resumeFromCheckpoint({
      runId: 'run-ok',
      workflow: WF,
      inputs: { topic: 'the report', depth: 3 },
      executionMode: 'local',
      gateId: 'gate-1',
      decision: { decision: 'approved', decidedBy: 'tester' },
    });
    const seen: RunEvent[] = [];
    for await (const event of handle.events) seen.push(event);
    expect(seen.some((event) => event.type === 'run:completed')).toBe(true);
  });
});
