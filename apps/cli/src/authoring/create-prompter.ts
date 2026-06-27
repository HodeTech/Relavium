import { isCancel, select, text } from '@clack/prompts';
import { LLM_PROVIDERS } from '@relavium/shared';

import type { AuthoredKind, CreatePrompter, CreateSpec } from './authoring.js';

/**
 * The `@clack/prompts`-backed {@link CreatePrompter} (2.J, [ADR-0047](../../../../docs/decisions/0047-cli-framework-commander-ink-clack.md))
 * — the ONLY place `@clack/prompts` is imported on the authoring path, mirroring the gate prompter + the ink
 * renderer split. It walks an `agent` / `workflow` scaffold wizard (kind → name → provider → model →
 * system_prompt → tools) and returns a {@link CreateSpec}, or `null` if the user cancels (Ctrl-C / ESC). The
 * narrow slice of clack it uses is injectable so the gather flow is unit-tested without a TTY.
 */

/** The narrow slice of `@clack/prompts` the wizard uses — injectable so the cancel/branch logic is testable. */
export interface ClackCreateDeps {
  readonly select: (opts: {
    message: string;
    options: readonly { value: string; label: string }[];
  }) => Promise<string | symbol>;
  readonly text: (opts: {
    message: string;
    placeholder?: string;
    // The value can be `undefined` (an empty submit) — matching clack's `validate` param, contravariantly. The
    // return is intentionally narrowed to `string | undefined`: clack's `Validate` also allows `Error`, but this
    // seam never returns one, so the narrowing is deliberate (a subtype of clack's signature), not an oversight.
    validate?: (value: string | undefined) => string | undefined;
  }) => Promise<string | symbol>;
  /** Clack's cancel sentinel guard (Ctrl-C / ESC) — a real type guard so a non-cancel value narrows. */
  readonly isCancel: (value: unknown) => value is symbol;
}

// The clack-boundary adapter (the one place the library's exact option shapes are met). Map to fresh mutable
// option objects + spread the optional `text` fields conditionally so no explicit `undefined` is passed
// (exactOptionalPropertyTypes), keeping the seam free of clack's types and free of an unsafe cast.
const defaultDeps: ClackCreateDeps = {
  select: (opts) =>
    select({
      message: opts.message,
      options: opts.options.map((option) => ({ value: option.value, label: option.label })),
    }),
  text: (opts) =>
    text({
      message: opts.message,
      ...(opts.placeholder === undefined ? {} : { placeholder: opts.placeholder }),
      ...(opts.validate === undefined ? {} : { validate: opts.validate }),
    }),
  isCancel,
};

/** A clack `validate` callback that rejects an empty / whitespace-only / unset submit. Exported for unit test. */
export const required =
  (label: string) =>
  (value: string | undefined): string | undefined =>
    (value ?? '').trim() === '' ? `${label} is required.` : undefined;

export function createClackPrompter(deps: ClackCreateDeps = defaultDeps): CreatePrompter {
  return {
    gather: async () => {
      const kindValue = await deps.select({
        message: 'Create a…',
        options: [
          { value: 'agent', label: 'Agent (.agent.yaml)' },
          { value: 'workflow', label: 'Workflow (.relavium.yaml — a single-agent scaffold)' },
        ],
      });
      if (deps.isCancel(kindValue)) return null;
      const kind: AuthoredKind = kindValue === 'workflow' ? 'workflow' : 'agent';

      const name = await deps.text({ message: 'Name', validate: required('Name') });
      if (deps.isCancel(name)) return null;

      const providerValue = await deps.select({
        message: 'Provider',
        options: LLM_PROVIDERS.map((p) => ({ value: p, label: p })),
      });
      if (deps.isCancel(providerValue)) return null;
      // Narrow to the closed provider set WITHOUT a cast — `select` only ever yields a listed option.
      const provider = LLM_PROVIDERS.find((p) => p === providerValue);
      if (provider === undefined) return null;

      const model = await deps.text({
        message: 'Model id',
        placeholder: 'claude-sonnet-4-6',
        validate: required('Model id'),
      });
      if (deps.isCancel(model)) return null;

      const systemPrompt = await deps.text({
        message: 'System prompt',
        validate: required('System prompt'),
      });
      if (deps.isCancel(systemPrompt)) return null;

      const toolsRaw = await deps.text({
        message: 'Tools (comma-separated tool ids, optional)',
        placeholder: 'read_file, web_search',
      });
      if (deps.isCancel(toolsRaw)) return null;
      const tools = toolsRaw
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t.length > 0);

      const spec: CreateSpec = { kind, name, provider, model, systemPrompt, tools };
      return spec;
    },
  };
}
