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

/** One field that carries at least one `{{ … }}` reference. */
export interface ReferenceSite {
  /** A human field locator, e.g. ``node `synthesize-report`.prompt_template``. */
  readonly location: string;
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
export function collectReferences(workflow: Workflow): readonly ReferenceSite[] {
  const sites: ReferenceSite[] = [];
  const spec = workflow.workflow;

  const visit = (location: string, text: string): void => {
    const segments = parseTemplate(text);
    const references: InterpolationReference[] = [];
    for (const segment of segments) {
      if (segment.kind === 'reference') {
        references.push(segment.reference);
      }
    }
    if (references.length > 0) {
      sites.push({ location, segments, references });
    }
  };

  // TODO(1.M): workflow-yaml-spec.md §Context-and-interpolation forbids `{{run.outputs[...]}}` in
  // context values (context is eagerly evaluated before the run; node outputs are unavailable).
  // Enforcing this here would require importing parseTemplate, coupling the collector to a semantic
  // constraint that the DAG builder (1.M) is better placed to enforce (it wires data-dependency
  // edges and can produce a richer error). Until then, a context entry that references a node
  // output is collected with kind:'node' and will be caught by the DAG builder when it finds no
  // satisfying edge for it. See the pinned test in parser.test.ts ("permits a context value …").
  for (const entry of spec.context ?? []) {
    visit(`context \`${entry.key}\`.value`, entry.value);
  }
  for (const input of spec.inputs ?? []) {
    if (typeof input.default === 'string') {
      visit(`input \`${input.name}\`.default`, input.default);
    }
  }
  for (const agent of spec.agents ?? []) {
    if (!('$ref' in agent)) {
      visit(`agent \`${agent.id}\`.system_prompt`, agent.system_prompt);
    }
  }
  for (const node of spec.nodes) {
    if (node.type === 'agent') {
      if (node.prompt_template !== undefined) {
        visit(`node \`${node.id}\`.prompt_template`, node.prompt_template);
      }
      if (node.system_prompt_append !== undefined) {
        visit(`node \`${node.id}\`.system_prompt_append`, node.system_prompt_append);
      }
    } else if (node.type === 'human_gate') {
      if (node.assignee !== undefined) {
        visit(`node \`${node.id}\`.assignee`, node.assignee);
      }
      if (node.message_template !== undefined) {
        visit(`node \`${node.id}\`.message_template`, node.message_template);
      }
    }
  }
  return sites;
}
