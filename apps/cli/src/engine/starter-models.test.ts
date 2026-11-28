/**
 * The ONE starter-model table (ADR-0146 §6, ruled 2026-11-24; MVP-11 unit 6): `KNOWN_PROVIDERS[id].starterModel` is the model of the current family
 * a provider starts on, and every path that picks a model for a provider reads it and no other spelling: the default a first setup and an
 * environment-key consent write, the zero-config chat's model, the setup's live key check, `relavium provider test` and the doctor's deep tier.
 *
 * Pinned here: each entry is a row of the SHIPPED catalogue, of its own provider, priced (a model with no price would be unpriced and conservative
 * in the cost accounting), and a chat model (text in, text out); Anthropic's is Haiku 5.5, the ruling; the zero-config chat binds the table's
 * entry; and no file on those paths spells a model id by hand (a string literal that is a catalogue id), so a second table cannot grow back.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { catalogModel, catalogModelIds } from '@relavium/llm';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { defaultChatModel } from '../chat/agent-source.js';
import { DEFAULT_CHAT_MODEL } from '../chat/default-agent.js';
import { KNOWN_PROVIDER_IDS, KNOWN_PROVIDERS } from './providers.js';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** Every file on a path that picks a model for a provider (the setup, the consent, the defaults, the checks). */
const STARTER_PATHS = [
  'engine/providers.ts',
  'onboarding/wizard.ts',
  'onboarding/setup-notes.ts',
  'home/provider-setup.ts',
  'home/drive-home.tsx',
  'commands/provider.ts',
  'commands/standalone-provider-setup.ts',
  'chat/doctor-deep.ts',
  'chat/agent-source.ts',
  'chat/default-agent.ts',
] as const;

/** The string literals of a source (plain strings and templates' text), read with the compiler, so a comment that names a model is not one. */
function stringLiterals(path: string): string[] {
  const source = ts.createSourceFile(
    path,
    readFileSync(`${SRC}${path}`, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node)) found.push(node.text);
    else if (ts.isTemplateExpression(node)) {
      found.push(node.head.text, ...node.templateSpans.map((span) => span.literal.text));
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('the one starter-model table', () => {
  it.each(KNOWN_PROVIDER_IDS)(
    "%s's starter is a shipped catalogue row of its own provider, priced, and a chat model",
    (id) => {
      const model = catalogModel(KNOWN_PROVIDERS[id].starterModel);
      expect(model, 'a row of the shipped catalogue').toBeDefined();
      expect(model?.provider).toBe(id);
      expect(model?.inputPerMtokMicrocents ?? 0, 'priced input').toBeGreaterThan(0);
      expect(model?.outputPerMtokMicrocents ?? 0, 'priced output').toBeGreaterThan(0);
      expect(model?.inputModalities ?? [], 'text in').toContain('text');
      expect(model?.outputModalities ?? [], 'text out').toContain('text');
    },
  );

  it('the four starter ids are pinned here as literals: changing a table entry is a deliberate edit of this test too (the one place the values are written out)', () => {
    expect(
      Object.fromEntries(KNOWN_PROVIDER_IDS.map((id) => [id, KNOWN_PROVIDERS[id].starterModel])),
    ).toEqual({
      anthropic: 'claude-haiku-5-5',
      openai: 'gpt-5.4-mini',
      gemini: 'gemini-2.5-flash',
      deepseek: 'deepseek-v4-flash',
    });
  });

  it("Anthropic's starter is Haiku 5.5 (the maintainer's ruling), and the zero-config chat binds the table's entry", () => {
    expect(KNOWN_PROVIDERS.anthropic.starterModel).toBe('claude-haiku-5-5');
    expect(DEFAULT_CHAT_MODEL).toBe(KNOWN_PROVIDERS.anthropic.starterModel);
    const base = {
      cwd: SRC,
      projectConfigDir: undefined,
      homeDir: undefined,
      defaultModel: undefined,
    };
    expect(defaultChatModel(base)).toEqual({
      model: KNOWN_PROVIDERS.anthropic.starterModel,
      provider: 'anthropic',
    });
    for (const id of KNOWN_PROVIDER_IDS)
      expect(defaultChatModel({ ...base, hasKey: (candidate) => candidate === id })).toEqual({
        model: KNOWN_PROVIDERS[id].starterModel,
        provider: id,
      });
  });

  it.each(STARTER_PATHS.filter((path) => path !== 'engine/providers.ts'))(
    '%s spells no model id: it reads the table',
    (path) => {
      const ids = new Set(catalogModelIds());
      expect(stringLiterals(path).filter((text) => ids.has(text))).toEqual([]);
    },
  );

  it('the table itself is the one place the starter ids are written', () => {
    const literals = stringLiterals('engine/providers.ts');
    for (const id of KNOWN_PROVIDER_IDS)
      expect(literals.filter((text) => text === KNOWN_PROVIDERS[id].starterModel)).toHaveLength(1);
  });
});
