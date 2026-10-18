import { WorkflowSchema, type Workflow } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { WorkflowContextError } from '../errors.js';
import {
  createWorkflowContextProjection,
  createWorkflowProvenance,
  ownSecretInputNames,
} from './provenance.js';
import { resolveContext } from './resolve.js';

const CANARY = 'provenance-value-canary-0113';

function workflow(): Workflow {
  return WorkflowSchema.parse({
    schema_version: '1.0',
    workflow: {
      id: 'provenance',
      inputs: [
        { name: 'token', type: 'secret' },
        { name: 'public_text', type: 'string' },
      ],
      context: [
        { key: 'first', value: '{{inputs.token}}' },
        { key: 'public', value: '{{inputs.public_text}}' },
        { key: 'second', value: 'nested={{ctx.first}}' },
        { key: 'third', value: '{{ctx.second | length}}' },
        { key: 'literal', value: CANARY },
      ],
      nodes: [{ id: 'start', type: 'input' }],
      edges: [],
    },
  });
}

function expectInvalid(action: () => unknown): void {
  try {
    action();
  } catch (error) {
    if (!(error instanceof WorkflowContextError)) throw error;
    expect(error.code).toBe('validation');
    expect(error.retryable).toBe(false);
    expect(error.message).toBe('workflow context provenance is missing or invalid');
    for (const field of ['cause', 'detail', 'source', 'issues']) {
      expect(Object.hasOwn(error, field)).toBe(false);
    }
    expect(JSON.stringify(error)).not.toContain(CANARY);
    return;
  }
  throw new Error('expected fixed provenance validation failure');
}

describe('createWorkflowProvenance — declared-source authority', () => {
  it('refuses undeclared resolved keys before reading their values', () => {
    const authority = createWorkflowProvenance(workflow());
    expectInvalid(() => authority.qualifyContext({ public: 'safe', undeclared: CANARY }));
    let reads = 0;
    const resolved: Record<string, string> = { public: 'safe' };
    Object.defineProperty(resolved, 'undeclared', {
      enumerable: true,
      get() {
        reads += 1;
        return CANARY;
      },
    });
    expectInvalid(() => authority.qualifyContext(resolved));
    expect(reads).toBe(0);
    // A refused external projection cannot taint the owned authority's next valid resolution.
    expect(authority.qualifyContext({ public: 'safe' }).values).toEqual({ public: 'safe' });
  });
  it('removes direct and transitive derived values while preserving trusted raw resolution', async () => {
    const definition = workflow();
    const authority = createWorkflowProvenance(definition);
    const raw = await resolveContext(definition, { token: CANARY, public_text: 'hello' });
    expect(raw).toMatchObject({
      first: CANARY,
      second: `nested=${CANARY}`,
      third: String(`nested=${CANARY}`.length),
      public: 'hello',
      literal: CANARY,
    });
    const projection = authority.qualifyContext(raw);
    expect(projection.values, 'ENGINE_CONTEXT_RAW_EXCLUSION').toEqual({
      public: 'hello',
      literal: CANARY,
    });
    expect(projection.deniedKeys).toEqual(['first', 'second', 'third']);
    expect(projection.orderedKeys).toEqual(['first', 'public', 'second', 'third', 'literal']);
    expect([...authority.secretInputNames]).toEqual(['token']);
    expect(authority.deniedInputNames).toEqual(['token']);
    expect(Object.getPrototypeOf(projection.values)).toBeNull();
    for (const denied of ['first', 'second', 'third']) {
      expect(Object.hasOwn(projection.values, denied)).toBe(false);
    }
  });

  it('uses declarations even for equal clean values or a derived value without secret bytes', () => {
    const projection = createWorkflowProvenance(workflow()).qualifyContext({
      first: 'different bytes',
      public: CANARY,
      third: '0',
    });
    expect(projection.values).toEqual({ public: CANARY });
    expect(projection.deniedKeys).toEqual(['first', 'third']);
  });

  it('retains the object-only default graph and propagates reverse-declared dependencies', () => {
    // Templated defaults cannot pass current YAML admission. Trusted object embeddings still
    // receive the existing declared-source analysis rather than a weaker second authority.
    const base = workflow();
    const definition: Workflow = {
      ...base,
      workflow: {
        ...base.workflow,
        inputs: [
          { name: 'laundered', type: 'string', default: '{{ctx.later}}' },
          { name: 'token', type: 'secret' },
        ],
        context: [
          { key: 'earlier', value: '{{inputs.laundered}}' },
          { key: 'later', value: '{{inputs.token}}' },
          { key: 'clean', value: 'unchanged' },
        ],
      },
    };
    const authority = createWorkflowProvenance(definition);
    expect(authority.secretInputNames.has('token')).toBe(true);
    expect(authority.secretInputNames.has('laundered')).toBe(true);
    const projection = authority.qualifyContext({
      earlier: CANARY,
      later: CANARY,
      clean: 'unchanged',
    });
    expect(projection.deniedKeys).toEqual(['earlier', 'later']);
    expect(projection.values).toEqual({ clean: 'unchanged' });
  });

  it('owns provenance independently of later admitted-workflow mutations', () => {
    const definition = workflow();
    const authority = createWorkflowProvenance(definition);
    definition.workflow.inputs?.splice(0);
    definition.workflow.context?.splice(0);
    const projection = authority.qualifyContext({ first: CANARY, public: 'still clean' });
    expect(authority.secretInputNames.has('token')).toBe(true);
    expect(authority.deniedInputNames).toEqual(['token']);
    expect(projection.values).toEqual({ public: 'still clean' });
    expect(projection.deniedKeys).toEqual(['first']);
  });

  it('does not even read a denied raw property while qualifying its keys', () => {
    let deniedReads = 0;
    const raw: Record<string, string> = { public: 'safe' };
    Object.defineProperty(raw, 'first', {
      enumerable: true,
      get() {
        deniedReads += 1;
        throw new Error(CANARY);
      },
    });
    const projection = createWorkflowProvenance(workflow()).qualifyContext(raw);
    expect(deniedReads).toBe(0);
    expect(projection.values).toEqual({ public: 'safe' });
    expect(projection.deniedKeys).toEqual(['first']);
    expect(JSON.stringify(projection)).not.toContain(CANARY);
    raw['public'] = CANARY;
    expect(projection.values['public']).toBe('safe');
  });

  it('preserves integer enumeration and clean/denied interleaving in the original full order', () => {
    const definition = WorkflowSchema.parse({
      schema_version: '1.0',
      workflow: {
        id: 'ordered',
        inputs: [{ name: 'token', type: 'secret' }],
        context: [
          { key: '10', value: '{{inputs.token}}' },
          { key: '2', value: 'two' },
          { key: 'alpha', value: '{{inputs.token}}' },
          { key: 'beta', value: 'clean' },
          { key: 'gamma', value: '{{ctx.alpha}}' },
        ],
        nodes: [{ id: 'start', type: 'input' }],
        edges: [],
      },
    });
    const projection = createWorkflowProvenance(definition).qualifyContext({
      '10': CANARY,
      '2': 'two',
      alpha: CANARY,
      beta: 'clean',
      gamma: CANARY,
    });
    expect(projection.orderedKeys).toEqual(['2', '10', 'alpha', 'beta', 'gamma']);
    expect(projection.deniedKeys).toEqual(['10', 'alpha', 'gamma']);
    expect(Object.keys(projection.values)).toEqual(['2', 'beta']);
  });
});

describe('createWorkflowContextProjection — explicit owned metadata', () => {
  it('copies and freezes every DTO component while preserving safe prototype-shaped names', () => {
    const values: Record<string, string> = { constructor: 'constructor text', toString: 'text' };
    Object.defineProperty(values, '__proto__', { value: 'proto text', enumerable: true });
    const dto = {
      values,
      deniedKeys: ['denied'],
      orderedKeys: ['constructor', 'denied', '__proto__', 'toString'],
    };
    const projection = createWorkflowContextProjection(dto);
    dto.values['constructor'] = CANARY;
    dto.deniedKeys.splice(0);
    dto.orderedKeys.reverse();
    expect(projection.values['constructor']).toBe('constructor text');
    expect(Reflect.get(projection.values, '__proto__')).toBe('proto text');
    expect(projection.values['toString']).toBe('text');
    expect(projection.deniedKeys).toEqual(['denied']);
    expect(projection.orderedKeys).toEqual(['constructor', 'denied', '__proto__', 'toString']);
    expect(Object.getPrototypeOf(projection.values)).toBeNull();
    for (const owned of [
      projection,
      projection.values,
      projection.deniedKeys,
      projection.orderedKeys,
    ]) {
      expect(Object.isFrozen(owned)).toBe(true);
    }
    expect(Reflect.set(projection.values, 'extra', CANARY)).toBe(false);
    expect(Reflect.set(projection.deniedKeys, '0', 'changed')).toBe(false);
  });

  it('accepts an explicitly empty projection', () => {
    expect(
      createWorkflowContextProjection({ values: {}, deniedKeys: [], orderedKeys: [] }),
    ).toEqual({
      values: {},
      deniedKeys: [],
      orderedKeys: [],
    });
  });

  it.each([
    undefined,
    null,
    {},
    { values: {}, deniedKeys: [] },
    { values: {}, deniedKeys: [], orderedKeys: [], extra: CANARY },
    { values: { clean: CANARY }, deniedKeys: [], orderedKeys: [] },
    { values: {}, deniedKeys: ['denied'], orderedKeys: [] },
    { values: {}, deniedKeys: [], orderedKeys: ['unknown'] },
    { values: {}, deniedKeys: ['denied', 'denied'], orderedKeys: ['denied'] },
    { values: {}, deniedKeys: ['denied'], orderedKeys: ['denied', 'denied'] },
    { values: { same: CANARY }, deniedKeys: ['same'], orderedKeys: ['same'] },
    { values: { 'bad.name': CANARY }, deniedKeys: [], orderedKeys: ['bad.name'] },
    { values: {}, deniedKeys: ['bad name'], orderedKeys: ['bad name'] },
    { values: { clean: 1 }, deniedKeys: [], orderedKeys: ['clean'] },
  ])('refuses missing/malformed metadata without retaining supplied data: %j', (dto) => {
    expectInvalid(() => createWorkflowContextProjection(dto));
  });

  it('replaces a hostile DTO getter error with the fixed content-free diagnostic', () => {
    const dto = {
      get values(): Readonly<Record<string, string>> {
        throw new Error(CANARY);
      },
      deniedKeys: [],
      orderedKeys: [],
    };
    expectInvalid(() => createWorkflowContextProjection(dto));
  });
});

describe('ownSecretInputNames — immutable membership', () => {
  it('copies caller membership and never exposes its backing Set to retained callbacks/iterators', () => {
    const original = new Set(['token', '__proto__', 'constructor']);
    const owned = ownSecretInputNames(original);
    const iterator = owned.secretInputNames.values();
    const entries = owned.secretInputNames.entries();
    const callbackViews: ReadonlySet<string>[] = [];
    const observed: string[] = [];
    owned.secretInputNames.forEach((value, key, view) => {
      expect(key).toBe(value);
      expect(view).toBe(owned.secretInputNames);
      callbackViews.push(view);
      observed.push(value);
    });
    original.clear();
    original.add('injected');
    for (const view of [owned.secretInputNames, ...callbackViews]) {
      expect(Object.isFrozen(view)).toBe(true);
      expect(Reflect.get(view, 'clear')).toBeUndefined();
      expect(Reflect.get(view, 'delete')).toBeUndefined();
      expect(Reflect.get(view, 'add')).toBeUndefined();
      expect(() => Set.prototype.clear.call(view)).toThrow(TypeError);
      expect(view.has('token')).toBe(true);
      expect(view.has('injected')).toBe(false);
    }
    expect([...iterator]).toEqual(['token', '__proto__', 'constructor']);
    expect([...entries]).toEqual([
      ['token', 'token'],
      ['__proto__', '__proto__'],
      ['constructor', 'constructor'],
    ]);
    expect([...owned.secretInputNames.keys()]).toEqual(observed);
    expect([...owned.secretInputNames]).toEqual(observed);
    expect(owned.secretInputNames.size).toBe(3);
    expect(owned.deniedInputNames).toEqual(['token', '__proto__', 'constructor']);
    expect(Object.isFrozen(owned)).toBe(true);
    expect(Object.isFrozen(owned.deniedInputNames)).toBe(true);
  });

  it.each([['duplicate', 'duplicate'], ['bad.name'], [''], ['bad name']])(
    'refuses duplicate or non-referenceable membership %j',
    (...names) => expectInvalid(() => ownSecretInputNames(names)),
  );

  it('replaces a failed input iterator with a fixed diagnostic', () => {
    const broken: Iterable<string> = {
      [Symbol.iterator](): Iterator<string> {
        throw new Error(CANARY);
      },
    };
    expectInvalid(() => ownSecretInputNames(broken));
  });
});
