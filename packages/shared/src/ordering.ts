/**
 * UTF-16 code-unit string order — **deliberately not `localeCompare`**, and shared because it has to be the
 * same order in every package that reproduces a run.
 *
 * It lives here for the reason [bytes.ts](bytes.ts) gives for `utf8ByteLength`: a second copy is how one
 * rule quietly becomes several. There were three — the DAG builder's, the engine scope builder's, and one
 * written inline as a nested ternary inside the JSON-Schema compiler's canonicalizer — and they must agree,
 * because each one fixes the key order of something a resumed run has to rebuild identically:
 *
 * - `PlanVertex.ancestors` → the key order of the `run.outputs` record an expression sees;
 * - `OutputPlanConfig.feederNodeIds` → the key order of a multi-feeder `output` capture;
 * - the compiler's canonical JSON → whether two `uniqueItems` members compare equal.
 *
 * `localeCompare` is locale-dependent, so the same workflow resumed under a different `LANG` would build a
 * different object (expression-sandbox-spec.md §run.outputs ordering; [ADR-0027](../../../docs/decisions/0027-expression-sandbox.md)).
 * That is also why a static analyser's advice to "provide a compare function that depends on
 * `String.localeCompare`" must be refused here rather than applied: it names the one change that breaks the
 * property the sort exists for.
 */
export function byCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
