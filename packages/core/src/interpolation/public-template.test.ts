import { WorkflowSchema } from '@relavium/shared';
import { describe, expect, it } from 'vitest';

import { InterpolationError, WorkflowContextError } from '../errors.js';
import {
  createWorkflowContextProjection,
  createWorkflowProvenance,
  ownSecretInputNames,
} from './provenance.js';
import {
  resolveContext,
  resolvePublicTemplate,
  resolveTemplate,
  type PublicTemplateScope,
} from './resolve.js';
import type { ResolverCapabilities } from './scope.js';

const CANARY = 'public-template-value-canary-0113';

function publicScope(): PublicTemplateScope {
  return {
    inputs: { token: CANARY, name: 'Ada', path: 'clean.txt' },
    ctx: createWorkflowContextProjection({
      values: { greeting: 'Hello' },
      deniedKeys: ['alias'],
      orderedKeys: ['alias', 'greeting'],
    }),
    secretInputNames: ownSecretInputNames(['token']).secretInputNames,
    outputs: { scan: { score: 9 } },
  };
}

async function expectSecretRefusal(
  text: string,
  scope: PublicTemplateScope,
  caps: ResolverCapabilities = {},
): Promise<void> {
  let caught: unknown;
  try {
    await resolvePublicTemplate(text, scope, caps);
  } catch (error) {
    caught = error;
  }
  expect(caught, 'PUBLIC_TEMPLATE_SECRET_REFUSAL').toBeInstanceOf(InterpolationError);
  if (!(caught instanceof InterpolationError)) throw caught;
  expect(caught.code, 'PUBLIC_TEMPLATE_SECRET_REFUSAL').toBe('secret_reference');
  expect(caught.message).toBe('secret-derived values are unavailable to text templates');
  for (const field of ['location', 'detail', 'source', 'cause']) {
    expect(Reflect.get(caught, field)).toBeUndefined();
  }
  expect(JSON.stringify(caught)).not.toContain(CANARY);
}

describe('resolvePublicTemplate — real clean consumer', () => {
  it('resolves independent clean text, output paths and defaults exactly', async () => {
    await expect(
      resolvePublicTemplate(
        '{{ctx.greeting}}, {{inputs.name}}! score={{run.outputs["scan"].score}}; {{inputs.missing | default("fallback")}}',
        publicScope(),
      ),
    ).resolves.toBe('Hello, Ada! score=9; fallback');
    await expect(resolvePublicTemplate('literal text', publicScope())).resolves.toBe(
      'literal text',
    );
  });

  it('permits a clean read_file capability and forwards the live signal', async () => {
    const controller = new AbortController();
    const calls: unknown[][] = [];
    await expect(
      resolvePublicTemplate(
        '{{inputs.path | read_file | length}}',
        publicScope(),
        {
          readFile: (path, signal) => {
            calls.push([path, signal]);
            return 'contents';
          },
        },
        controller.signal,
      ),
    ).resolves.toBe('8');
    expect(calls).toEqual([['clean.txt', controller.signal]]);
  });

  it('keeps ordinary cancellation behaviour on a clean template', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolvePublicTemplate('{{inputs.name}}', publicScope(), {}, controller.signal),
    ).rejects.toMatchObject({ code: 'aborted' });
  });

  it('does not value-scan clean user strings even if they equal declared secret bytes', async () => {
    await expect(
      resolvePublicTemplate('{{inputs.name}}/{{ctx.greeting}}', {
        ...publicScope(),
        inputs: { token: CANARY, name: CANARY },
        ctx: createWorkflowContextProjection({
          values: { greeting: CANARY },
          deniedKeys: [],
          orderedKeys: ['greeting'],
        }),
      }),
    ).resolves.toBe(`${CANARY}/${CANARY}`);
  });
});

describe('resolvePublicTemplate — declaration-based refusal before effects', () => {
  it.each([
    '{{ctx.alias}}',
    '{{ctx.alias | default("fallback")}}',
    '{{ctx.alias.child | default("fallback") | read_file}}',
    '{{inputs.token}}',
    '{{inputs.token | length}}',
    '{{inputs.token.child | default("fallback")}}',
    '{{inputs.token | read_file}}',
  ])('rejects %s before filters/defaults and without value access', async (text) => {
    let reads = 0;
    const inputs: Record<string, unknown> = { name: 'Ada' };
    Object.defineProperty(inputs, 'token', {
      enumerable: true,
      get() {
        reads += 1;
        throw new Error(CANARY);
      },
    });
    const fileReads: string[] = [];
    await expectSecretRefusal(
      text,
      { ...publicScope(), inputs },
      {
        readFile: (path) => {
          fileReads.push(path);
          return 'forbidden';
        },
      },
    );
    expect(reads).toBe(0);
    expect(fileReads).toEqual([]);
  });

  it.each(['{{ctx.alias}}', '{{inputs.token | default("fallback")}}'])(
    'preflights a denied reference after a clean read in the whole template: %s',
    async (denied) => {
      const paths: string[] = [];
      await expectSecretRefusal(`{{inputs.path | read_file}} later ${denied}`, publicScope(), {
        readFile: (path) => {
          paths.push(path);
          return 'clean result';
        },
      });
      expect(paths).toEqual([]);
    },
  );

  it('refuses an omitted optional secret input by declaration while clean defaults still work', async () => {
    const definition = WorkflowSchema.parse({
      schema_version: '1.0',
      workflow: {
        id: 'optional-secret',
        inputs: [{ name: 'token', type: 'secret', required: false }],
        nodes: [{ id: 'start', type: 'input' }],
        edges: [],
      },
    });
    const authority = createWorkflowProvenance(definition);
    const scope: PublicTemplateScope = {
      inputs: {},
      ctx: authority.qualifyContext({}),
      outputs: {},
      secretInputNames: authority.secretInputNames,
    };
    expect(Object.hasOwn(scope.inputs, 'token')).toBe(false);
    await expectSecretRefusal('{{inputs.token | default("fallback")}}', scope);
    await expect(resolvePublicTemplate('{{inputs.clean | default("works")}}', scope)).resolves.toBe(
      'works',
    );
  });

  it('consumes actual transitive context provenance from a schema-valid object outside parser taint checks', async () => {
    const definition = WorkflowSchema.parse({
      schema_version: '1.0',
      workflow: {
        id: 'hand-built',
        inputs: [{ name: 'token', type: 'secret' }],
        context: [
          { key: '__proto__', value: '{{inputs.token}}' },
          { key: 'constructor', value: '{{ctx.__proto__}}' },
          { key: 'clean', value: 'safe' },
        ],
        nodes: [{ id: 'start', type: 'input' }],
        edges: [],
      },
    });
    const inputs = { token: CANARY };
    const raw = await resolveContext(definition, inputs);
    const authority = createWorkflowProvenance(definition);
    const scope: PublicTemplateScope = {
      inputs,
      outputs: {},
      ctx: authority.qualifyContext(raw),
      secretInputNames: authority.secretInputNames,
    };
    expect(Reflect.get(raw, '__proto__')).toBe(CANARY);
    await expectSecretRefusal('{{ctx.__proto__ | default("fallback")}}', scope);
    await expectSecretRefusal('{{ctx.constructor}}', scope);
    await expectSecretRefusal('{{inputs.token}}', scope);
    await expect(resolvePublicTemplate('{{ctx.clean}}', scope)).resolves.toBe('safe');
    await expect(
      resolveTemplate('{{ctx.constructor}}/{{inputs.token}}', { inputs, ctx: raw, outputs: {} }),
    ).resolves.toBe(`${CANARY}/${CANARY}`);
  });

  it('retains refusal after the original membership Set and projection DTO are mutated', async () => {
    const sourceNames = new Set(['token']);
    const names = ownSecretInputNames(sourceNames);
    const dto = {
      values: { clean: 'safe' },
      deniedKeys: ['alias'],
      orderedKeys: ['clean', 'alias'],
    };
    const ctx = createWorkflowContextProjection(dto);
    sourceNames.clear();
    dto.deniedKeys.splice(0);
    dto.orderedKeys.splice(0);
    dto.values.clean = CANARY;
    const scope = { ...publicScope(), ctx, secretInputNames: names.secretInputNames };
    await expectSecretRefusal('{{inputs.token}}', scope);
    await expectSecretRefusal('{{ctx.alias | default("fallback")}}', scope);
    await expect(resolvePublicTemplate('{{ctx.clean}}', scope)).resolves.toBe('safe');
  });

  it.each(['ctx', 'secretInputNames'])(
    'refuses missing %s metadata even for literal-only templates',
    async (field) => {
      const scope = publicScope();
      Reflect.deleteProperty(scope, field);
      await expect(resolvePublicTemplate('literal text', scope)).rejects.toBeInstanceOf(
        WorkflowContextError,
      );
      await expect(resolvePublicTemplate('literal text', scope)).rejects.toMatchObject({
        code: 'validation',
        retryable: false,
        message: 'workflow context provenance is missing or invalid',
      });
    },
  );

  it('validates mutated low-level projection metadata before any capability', async () => {
    const scope = publicScope();
    Object.defineProperty(scope, 'ctx', {
      value: { values: { alias: CANARY }, deniedKeys: ['alias'], orderedKeys: ['alias'] },
    });
    const calls: string[] = [];
    await expect(
      resolvePublicTemplate('{{inputs.path | read_file}}', scope, {
        readFile: (path) => {
          calls.push(path);
          return 'read';
        },
      }),
    ).rejects.toMatchObject({ code: 'validation', retryable: false });
    expect(calls).toEqual([]);
  });
});
