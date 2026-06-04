/**
 * QUARANTINED LINT FIXTURE — not real source, not part of any build or tsconfig.
 *
 * It pulls provider SDKs across the @relavium/llm seam from a NON-adapter zone through
 * EVERY syntax a real bypass could use. `tools/lint-fixtures/assert-fence.mjs` lints this
 * file and asserts BOTH seam rules fire EXACTLY their expected counts — so this file is
 * the precise spec of what the fence guarantees. If any line below stops failing lint, the
 * seam guard has regressed (ADR-0011).
 *
 * The specifiers intentionally do not resolve (the SDKs are not installed); both seam
 * rules are syntactic, so resolution is irrelevant.
 */

// --- Static forms — caught by @typescript-eslint/no-restricted-imports (5) ---
// Bare specifier (`paths`).
import '@anthropic-ai/sdk';
// Subpath (`patterns` group).
import 'openai/resources';
// Type-only import — a vendor TYPE leak via the `import type … from` form.
import type { GenerateContentResponse } from '@google/genai';
// Re-export, star form.
export * from '@anthropic-ai/sdk';
// Re-export, named form.
export { OpenAI } from 'openai';

// --- Non-static forms — caught by no-restricted-syntax (4) ---
// Dynamic import of a literal vendor specifier.
export const lazy = () => import('openai');
// Non-literal dynamic import — a computed specifier that evades the literal check.
const computed = '@anthropic-ai/sdk';
export const sneaky2 = () => import(computed);
// Import-type query — a pure type leak via the `import('…').T` operator.
export type Leaked2 = import('@anthropic-ai/sdk').Anthropic;
// CommonJS interop.
export const sneaky = require('@google/genai');

export type Leaked = GenerateContentResponse;
