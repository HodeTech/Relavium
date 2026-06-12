/**
 * `@relavium/core` public surface — the engine. Curated, **not** `export *`: only the engine's
 * contract is public. The `WorkflowYAMLParser` (1.L) lands first; the DAG builder (1.M), run loop
 * (1.N), checkpoint/resume (1.R), and retry extend this surface as they land. Zero platform-specific
 * imports (CLAUDE.md rule 5, ADR-0011) — the whole package runs in Node, the Tauri WebView, the VS
 * Code extension host, and Bun alike.
 */

// WorkflowYAMLParser (1.L) — parse + validate a `.relavium.yaml` string into a typed definition.
export { parseWorkflow } from './parser.js';
export type { WorkflowDefinition, ParseWorkflowOptions } from './parser.js';

// Typed, field-named, secret-free parse/validation errors — narrow on `code`, never on `message`.
export { WorkflowParseError, WorkflowSyntaxError, WorkflowValidationError } from './errors.js';
export type { WorkflowParseErrorCode, WorkflowIssue } from './errors.js';

// Structured, un-evaluated interpolation references — the view the DAG builder (1.M) consumes.
export { parseTemplate, templateReferences } from './interpolation/references.js';
export type {
  TemplateSegment,
  InterpolationReference,
  ReferenceKind,
  PipeFilter,
  FilterArg,
} from './interpolation/references.js';
export { collectReferences } from './interpolation/collect.js';
export type { ReferenceSite } from './interpolation/collect.js';
