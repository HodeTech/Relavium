/** Owned declared-source provenance at the engine/public-consumer boundary (ADR-0113). */
import { isReferenceableInputName, type Workflow } from '@relavium/shared';
import { z } from 'zod';

import { WorkflowContextError } from '../errors.js';
import { computeTaint } from './analyze.js';

/** Clean strings and the full original key order; denied values are never retained here. */
export interface WorkflowContextProjection {
  readonly values: Readonly<Record<string, string>>;
  readonly deniedKeys: readonly string[];
  readonly orderedKeys: readonly string[];
}

const nameSchema = z.string().refine(isReferenceableInputName);
const namesSchema = z.array(nameSchema);
const projectionSchema = z
  .object({
    // Keep the original record for the owned copy below: z.record's rebuild loses __proto__.
    values: z.custom<Readonly<Record<string, string>>>(
      (value) => z.record(nameSchema, z.string()).safeParse(value).success,
    ),
    deniedKeys: namesSchema,
    orderedKeys: namesSchema,
  })
  .strict()
  .superRefine((projection, ctx) => {
    const clean = new Set(Object.keys(projection.values));
    const denied = new Set(projection.deniedKeys);
    const ordered = new Set(projection.orderedKeys);
    if (
      denied.size !== projection.deniedKeys.length ||
      ordered.size !== projection.orderedKeys.length ||
      [...denied].some((key) => clean.has(key)) ||
      ordered.size !== clean.size + denied.size ||
      [...ordered].some((key) => !clean.has(key) && !denied.has(key))
    ) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid context provenance' });
    }
  });

/** Validate and own explicit embedding metadata; missing metadata never means clean. */
export function createWorkflowContextProjection(value: unknown): WorkflowContextProjection {
  try {
    const parsed = projectionSchema.safeParse(value);
    if (!parsed.success) throw new WorkflowContextError();
    const values: Record<string, string> = {};
    Object.setPrototypeOf(values, null);
    for (const key of parsed.data.orderedKeys) {
      if (Object.hasOwn(parsed.data.values, key)) {
        const entry = parsed.data.values[key];
        if (typeof entry !== 'string') throw new WorkflowContextError();
        values[key] = entry;
      }
    }
    return Object.freeze({
      values: Object.freeze(values),
      deniedKeys: Object.freeze([...parsed.data.deniedKeys]),
      orderedKeys: Object.freeze([...parsed.data.orderedKeys]),
    });
  } catch {
    // Metadata/getter/schema errors may contain data. This boundary has only a fixed diagnostic.
    throw new WorkflowContextError();
  }
}

export interface OwnedSecretInputNames {
  readonly secretInputNames: ReadonlySet<string>;
  readonly deniedInputNames: readonly string[];
}

/** Copy membership at embedding entry; neither callbacks nor iterators expose a mutable Set. */
export function ownSecretInputNames(names: Iterable<string>): OwnedSecretInputNames {
  try {
    const parsed = namesSchema.safeParse([...names]);
    if (!parsed.success) throw new WorkflowContextError();
    const backing = new Set(parsed.data);
    if (backing.size !== parsed.data.length) throw new WorkflowContextError();
    const deniedInputNames = Object.freeze([...backing]);
    const view: ReadonlySet<string> = Object.freeze({
      get size() {
        return backing.size;
      },
      has: (name: string) => backing.has(name),
      keys: () => backing.keys(),
      values: () => backing.values(),
      entries: () => backing.entries(),
      [Symbol.iterator]: () => backing[Symbol.iterator](),
      forEach: (
        callback: (value: string, key: string, set: ReadonlySet<string>) => void,
        thisArg?: unknown,
      ) => {
        for (const name of backing) callback.call(thisArg, name, name, view);
      },
    });
    return Object.freeze({ secretInputNames: view, deniedInputNames });
  } catch {
    throw new WorkflowContextError();
  }
}

export interface WorkflowProvenance extends OwnedSecretInputNames {
  qualifyContext(resolved: Readonly<Record<string, string>>): WorkflowContextProjection;
}

/** One linear taint authority per admitted workflow, reused by fresh/resume/preparation producers. */
export function createWorkflowProvenance(workflow: Workflow): WorkflowProvenance {
  const taint = computeTaint(workflow.workflow);
  const names = ownSecretInputNames(taint.inputs.keys());
  return Object.freeze({
    ...names,
    qualifyContext(resolved: Readonly<Record<string, string>>): WorkflowContextProjection {
      try {
        const values: Record<string, string> = {};
        Object.setPrototypeOf(values, null);
        const deniedKeys: string[] = [];
        const orderedKeys = Object.keys(resolved);
        for (const key of orderedKeys) {
          if (taint.ctx.has(key)) deniedKeys.push(key);
          else {
            const value = resolved[key];
            if (typeof value !== 'string') throw new WorkflowContextError();
            values[key] = value;
          }
        }
        return createWorkflowContextProjection({ values, deniedKeys, orderedKeys });
      } catch {
        throw new WorkflowContextError();
      }
    },
  });
}
