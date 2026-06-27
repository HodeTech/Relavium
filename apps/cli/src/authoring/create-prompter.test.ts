import { describe, expect, it } from 'vitest';

import { createClackPrompter, required, type ClackCreateDeps } from './create-prompter.js';

const CANCEL = Symbol('cancel');

/** A fake clack slice that replays queued `select` / `text` answers in call order (no TTY). */
function fakeDeps(
  selects: readonly (string | symbol)[],
  texts: readonly (string | symbol)[],
): ClackCreateDeps {
  const selectQueue = [...selects];
  const textQueue = [...texts];
  return {
    select: () => Promise.resolve(selectQueue.shift() ?? CANCEL),
    text: () => Promise.resolve(textQueue.shift() ?? CANCEL),
    isCancel: (value): value is symbol => typeof value === 'symbol',
  };
}

describe('createClackPrompter', () => {
  it('gathers an agent spec, narrowing kind + provider and parsing the comma-separated tools', async () => {
    const prompter = createClackPrompter(
      fakeDeps(
        ['agent', 'anthropic'],
        ['Code Reviewer', 'claude-sonnet-4-6', 'Review.', 'read_file, web_search'],
      ),
    );
    const spec = await prompter.gather();
    expect(spec).toEqual({
      kind: 'agent',
      name: 'Code Reviewer',
      provider: 'anthropic',
      model: 'claude-sonnet-4-6',
      systemPrompt: 'Review.',
      tools: ['read_file', 'web_search'], // split + trimmed
    });
  });

  it('gathers a workflow spec with an empty tools list', async () => {
    const prompter = createClackPrompter(
      fakeDeps(['workflow', 'openai'], ['Triage', 'gpt-4o', 'Triage the issue.', '   ']),
    );
    const spec = await prompter.gather();
    expect(spec?.kind).toBe('workflow');
    expect(spec?.provider).toBe('openai');
    expect(spec?.tools).toEqual([]); // whitespace-only ⇒ no tools
  });

  it('returns null when the user cancels at the FIRST prompt (kind)', async () => {
    const prompter = createClackPrompter(fakeDeps([CANCEL], []));
    expect(await prompter.gather()).toBeNull();
  });

  it('returns null when the user cancels MID-wizard (the model prompt)', async () => {
    const prompter = createClackPrompter(fakeDeps(['agent', 'anthropic'], ['Name', CANCEL]));
    expect(await prompter.gather()).toBeNull();
  });
});

describe('required (the validate callback)', () => {
  it('rejects an unset / empty / whitespace-only submit and accepts a non-empty one', () => {
    const validate = required('Name');
    expect(validate(undefined)).toBe('Name is required.'); // an empty submit is `undefined`
    expect(validate('')).toBe('Name is required.');
    expect(validate('   ')).toBe('Name is required.'); // whitespace-only is still empty
    expect(validate('Reviewer')).toBeUndefined(); // a real value passes (undefined = no error)
  });
});
