import { RelaviumError } from '@relavium/shared';
import { RelaviumError as LeafRelaviumError } from '@relavium/shared/relavium-error';
import { describe, expect, it } from 'vitest';

import { CliError } from '../process/cli-error.js';
import {
  assertDescriptorRegistry,
  COMMAND_DESCRIPTORS,
  compatibilityOptions,
  compatibilityPath,
  GLOBAL_OPTION_DESCRIPTORS,
  legacyManifestEntries,
  type CommandDescriptor,
} from './descriptors.js';
import { DISPATCHABLE_COMMAND_IDS } from './dispatch.js';
import legacyFixture from './fixtures/legacy-command-manifest.json' with { type: 'json' };
import { COMMAND_MANIFEST, CommandManifestEntrySchema } from './manifest.js';

function descriptor(id: string): CommandDescriptor {
  const found = COMMAND_DESCRIPTORS.find((entry) => entry.executorId === id);
  if (found === undefined) throw new Error(`missing test descriptor: ${id}`);
  return found;
}

function expectDeepFrozen(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const child of Object.values(value)) expectDeepFrozen(child);
}

describe('descriptor authority and legacy compatibility (ADR-0110 Step 6)', () => {
  it('retains all 24 literal pre-refactor model entries, order, annotations and strict schemas', () => {
    expect(legacyFixture).toHaveLength(24);
    expect(legacyManifestEntries()).toEqual(legacyFixture);
    expect(COMMAND_MANIFEST).toEqual(legacyFixture);
    for (const entry of COMMAND_MANIFEST) {
      expect(CommandManifestEntrySchema.parse(entry)).toEqual(entry);
      expect(CommandManifestEntrySchema.safeParse({ ...entry, path: ['leaked'] }).success).toBe(
        false,
      );
    }
    expect(COMMAND_MANIFEST.find((entry) => entry.id === 'gate')?.args?.[0]).not.toHaveProperty(
      'required',
    );
    expect(
      COMMAND_MANIFEST.find((entry) => entry.id === 'models.pricing')?.args?.[1],
    ).toMatchObject({ name: 'provider', required: true });
    expect(COMMAND_MANIFEST.find((entry) => entry.id === 'provider.remove-key')?.args).toHaveLength(
      1,
    );
    expect(COMMAND_MANIFEST.filter((entry) => entry.modeScope !== undefined)).toEqual([]);
    expectDeepFrozen(COMMAND_MANIFEST);
  });

  it('checks descriptor executor bindings against the actual dispatch table in both directions', () => {
    const ids = COMMAND_DESCRIPTORS.flatMap((entry) =>
      entry.executorId === undefined ? [] : [entry.executorId],
    );
    expect(ids).toHaveLength(24);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...DISPATCHABLE_COMMAND_IDS].sort());
    expect(
      COMMAND_DESCRIPTORS.filter((entry) => entry.executorId === undefined).map(
        (entry) => entry.path,
      ),
    ).toEqual([['agent'], ['budget'], ['provider'], ['media'], ['init']]);
    expectDeepFrozen(COMMAND_DESCRIPTORS);
    expectDeepFrozen(GLOBAL_OPTION_DESCRIPTORS);
  });

  it('stages canonical chat paths, pricing spellings and key force without changing legacy bindings', () => {
    for (const verb of ['resume', 'list', 'export']) {
      const entry = descriptor(`chat-${verb}`);
      expect(entry.path).toEqual(['chat', verb]);
      expect(entry.aliases).toEqual([{ path: [`chat-${verb}`], deprecated: true }]);
      expect(compatibilityPath(entry)).toEqual([`chat-${verb}`]);
    }
    const pricing = descriptor('models.pricing');
    expect(
      pricing.options
        .filter((option) => ['input', 'output'].includes(option.binding))
        .map((option) => ({
          binding: option.binding,
          spellings: option.spellings,
          deprecated: option.deprecatedSpellings,
        })),
    ).toEqual([
      { binding: 'input', spellings: ['--input-price'], deprecated: ['--input'] },
      { binding: 'output', spellings: ['--output-price'], deprecated: ['--output'] },
    ]);
    expect(
      compatibilityOptions(pricing)
        .filter((option) => ['input', 'output'].includes(option.binding))
        .map((option) => option.spellings),
    ).toEqual([['--input'], ['--output']]);
    expect(descriptor('provider.remove-key').options).toMatchObject([
      { binding: 'force', spellings: ['--force'], compatibility: false, model: false },
    ]);
    expect(compatibilityOptions(descriptor('provider.remove-key'))).toEqual([]);
  });

  it('retains the same shared error constructor through the supported pure subpath', () => {
    expect(LeafRelaviumError).toBe(RelaviumError);
    expect(new CliError('invalid_invocation', 'fixed')).toBeInstanceOf(RelaviumError);
  });

  it.each([
    [
      'canonical path',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        executorId: 'other',
        legacyModelOrder: 100,
      }),
    ],
    [
      'alias collision',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        path: ['other'],
        aliases: [{ path: entry.path, deprecated: true }],
        executorId: 'other',
        legacyModelOrder: 100,
      }),
    ],
    [
      'executor id',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        path: ['other'],
        legacyModelOrder: 100,
      }),
    ],
    [
      'model order',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        path: ['other'],
        executorId: 'other',
      }),
    ],
    [
      'positional binding',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        positionals: [...entry.positionals, ...entry.positionals],
      }),
    ],
    [
      'option binding',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        options: [...entry.options, { ...entry.options[0]!, spellings: ['--another'] }],
      }),
    ],
    [
      'option spelling',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        options: [...entry.options, { ...entry.options[0]!, binding: 'another' }],
      }),
    ],
    [
      'deprecated spelling',
      (entry: CommandDescriptor): CommandDescriptor => ({
        ...entry,
        options: entry.options.map((option, index) =>
          index === 0 ? { ...option, deprecatedSpellings: option.spellings } : option,
        ),
      }),
    ],
  ])('rejects duplicate %s with the closed infrastructure classification', (_name, mutate) => {
    const first = descriptor('run');
    const changed = mutate(first);
    const pair = changed.path[0] === 'other' ? [first, changed] : [changed];
    // A same-path replacement needs the original present for the path collision case only.
    const entries = _name === 'canonical path' ? [first, changed] : pair;
    expect(() => assertDescriptorRegistry(entries)).toThrowError(CliError);
    try {
      assertDescriptorRegistry(entries);
    } catch (error) {
      expect(error).toMatchObject({ code: 'cli_internal', exitCode: 9 });
    }
  });

  it('rejects empty paths, missing model order and executors bound to unavailable stubs', () => {
    const first = descriptor('run');
    for (const changed of [
      { ...first, path: [] },
      { ...first, path: [''] },
      { ...first, availability: 'not_implemented' as const },
    ])
      expect(() => assertDescriptorRegistry([changed])).toThrowError(CliError);
    const { legacyModelOrder: _order, ...missingOrder } = first;
    expect(_order).toBe(0);
    expect(() => assertDescriptorRegistry([missingOrder])).toThrowError(CliError);
  });
});
