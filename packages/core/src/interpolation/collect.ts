/**
 * Walk a validated `Workflow` and collect every interpolation-reference site — the structured,
 * un-evaluated view the DAG builder (1.M) reads to wire data-dependency edges. Pure: it derives
 * from the already-parsed object and evaluates nothing (1.L2 owns evaluation + secret-taint).
 *
 * Scanned fields are the authored *template* fields (workflow-yaml-spec.md §Context-and-interpolation):
 * `context[].value`, string `inputs[].default`, inline `agents[].system_prompt`, and on nodes the
 * agent `prompt_template` / `system_prompt_append` and human-gate `assignee` / `message_template`.
 * The whole-string JS expression fields (`condition`, `transform`, `merge_fn`) are NOT templates —
 * they reference run scope without `{{ }}` and are owned by the sandbox (1.AB), so they are skipped.
 */

import type { Workflow } from '@relavium/shared';

import { parseTemplate, type InterpolationReference, type TemplateSegment } from './references.js';

/**
 * What kind of field a reference site is — the distinction the secret-taint analyzer (1.L2) needs.
 * `agent-text`/`node-text` are model/human-visible and so are leak-checked; `context-value` is where
 * taint *propagates* (not itself a leak) and `input-default` is a fallback value, neither of which is
 * sent to a model. The DAG builder (1.M) also reads this to know which sites carry run data.
 */
export type ReferenceSiteCategory = 'context-value' | 'input-default' | 'agent-text' | 'node-text';

/** One field that carries at least one `{{ … }}` reference. */
export interface ReferenceSite {
  /** A human field locator, e.g. ``node `synthesize-report`.prompt_template``. */
  readonly location: string;
  /** Which kind of field this is — text (leak-checked) vs context/default (taint-propagating). */
  readonly category: ReferenceSiteCategory;
  /** The ordered literal/reference segments of the field's value. */
  readonly segments: readonly TemplateSegment[];
  /** Just the references at this site, in order. */
  readonly references: readonly InterpolationReference[];
}

// Security note: the `location` strings below embed node.id, agent.id, input.name, and
// context entry.key directly, without applying the SAFE_LABEL regex from parser.ts.  This is
// intentional and safe: `collectReferences` accepts a `Workflow` — the output of `parseWorkflow`
// — which has already been fully validated by `WorkflowSchema`.  Every id/name/key has been
// checked against the kebab-id regex (or at minimum `nonEmptyString`) by the Zod schema before
// reaching this function.  A raw, unvalidated string can never appear here.
// If the schema ever relaxes those constraints, add a SAFE_LABEL guard here in the same change.

type WorkflowNode = Workflow['workflow']['nodes'][number];

/** Build a ReferenceSite for `text` if it contains at least one interpolation reference. */
function buildSite(
  location: string,
  category: ReferenceSiteCategory,
  text: string,
): ReferenceSite | undefined {
  const segments = parseTemplate(text);
  const references: InterpolationReference[] = [];
  for (const segment of segments) {
    if (segment.kind === 'reference') {
      references.push(segment.reference);
    }
  }
  return references.length > 0 ? { location, category, segments, references } : undefined;
}

/**
 * Collect reference sites from the template fields on a single workflow node — all model/human text
 * (an agent's `prompt_template`/`system_prompt_append`, a human gate's `assignee`/`message_template`).
 * The DAG builder (1.M) calls this per node to attach a vertex's own un-evaluated input templates and
 * to discover its `{{run.outputs[…]}}` data-dependency edges. Pure; empty for nodes with no template
 * fields. (The JS-expression fields `condition`/`transform`/`merge_fn` are not templates and are not
 * scanned here — they read run scope without `{{ }}` and are owned by the sandbox, 1.AB.)
 */
export function nodeReferenceSites(node: WorkflowNode): readonly ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const addFieldSite = (label: string, value: string | undefined): void => {
    if (value !== undefined) {
      const site = buildSite(label, 'node-text', value);
      if (site !== undefined) sites.push(site);
    }
  };
  if (node.type === 'agent') {
    addFieldSite(`node \`${node.id}\`.prompt_template`, node.prompt_template);
    addFieldSite(`node \`${node.id}\`.system_prompt_append`, node.system_prompt_append);
  } else if (node.type === 'human_gate') {
    addFieldSite(`node \`${node.id}\`.assignee`, node.assignee);
    addFieldSite(`node \`${node.id}\`.message_template`, node.message_template);
  }
  return sites;
}

export function collectReferences(workflow: Workflow): readonly ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const spec = workflow.workflow;

  const push = (location: string, category: ReferenceSiteCategory, text: string): void => {
    const site = buildSite(location, category, text);
    if (site !== undefined) sites.push(site);
  };

  // A `{{run.outputs[…]}}` reference in a context value is rejected at parse by
  // `analyzePreRunReferences` (1.L2) — context is eagerly resolved before any node runs, so no node
  // output exists yet (workflow-yaml-spec.md §Context-and-interpolation). The collector stays a pure
  // structural view: it records the site (with kind:'node'); the analyzer reads it and raises the
  // field-named parse error.
  for (const entry of spec.context ?? []) {
    push(`context \`${entry.key}\`.value`, 'context-value', entry.value);
  }
  for (const input of spec.inputs ?? []) {
    if (typeof input.default === 'string') {
      push(`input \`${input.name}\`.default`, 'input-default', input.default);
    }
  }
  for (const agent of spec.agents ?? []) {
    // TODO(1.M): a `$ref` agent's `system_prompt` lives in another file; once 1.M resolves the ref,
    // the resolved prompt must be re-run through `analyzeSecretTaint` so a secret cannot hide behind it.
    if (!('$ref' in agent)) {
      push(`agent \`${agent.id}\`.system_prompt`, 'agent-text', agent.system_prompt);
    }
  }
  for (const node of spec.nodes) {
    sites.push(...nodeReferenceSites(node));
  }
  return sites;
}
