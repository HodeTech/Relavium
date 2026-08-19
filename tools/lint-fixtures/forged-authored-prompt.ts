/**
 * The `AuthoredSystemPrompt` fence fixture (CR-13, ADR-0081 §1) — every syntactic form that tries to forge
 * the brand, plus the forms the fence deliberately does NOT catch and the legitimate uses it must not touch.
 *
 * Quarantined here for the same reason the seam fixture is: this file exists to TRIP the rule, and
 * `assert-fence.mjs` reads its exact error count as the spec. A form that stops being policed changes the
 * count and fails CI rather than silently passing on the remaining errors.
 *
 * The type is declared locally rather than imported — the fence is name-based, and a fixture that depended
 * on `packages/core`'s module graph would couple a lint check to a build.
 */

declare const AUTHORED: unique symbol;
type AuthoredSystemPrompt = string & { readonly [AUTHORED]: true };

declare const dynamic: string;

/* ---- CAUGHT: the five direct forms, one error each. ------------------------------------------- */

export const asExpression = dynamic as AuthoredSystemPrompt;
export const angleBracket = <AuthoredSystemPrompt>dynamic;
export const twoStep = dynamic as unknown as AuthoredSystemPrompt;
export function returnPosition(): AuthoredSystemPrompt {
  return dynamic as AuthoredSystemPrompt;
}
export const satisfiesChained = dynamic satisfies string as AuthoredSystemPrompt;

/* ---- CAUGHT: the one-hop alias, flagged at its DECLARATION. ----------------------------------- */
/* A name-based selector cannot see `x as Alias`; making the alias requires writing the name, so the
   declaration is where the chain is closed. One error, on the declaration. */

type Alias = AuthoredSystemPrompt;
export const viaAlias = dynamic as Alias;

/* ---- CAUGHT: a type PREDICATE, which needs no assertion at all. -------------------------------- */
/* `value is AuthoredSystemPrompt` narrows a plain string into the brand with no `as`, no `<T>`, and no
   alias — a review verified it type-checks cleanly and produced zero fence hits. It is the worst residual
   to leave open because it is the most legible: it reads exactly like the legitimate `isBilledModality`
   guard in `agent-runner.ts`, so a reviewer scanning for `as AuthoredSystemPrompt` has no signal at all.
   One error, on the return annotation — the one place the name must appear. */

function isAuthored(value: string): value is AuthoredSystemPrompt {
  void value;
  return true;
}
export function viaTypeGuard(): AuthoredSystemPrompt {
  if (isAuthored(dynamic)) return dynamic;
  throw new Error('unreachable');
}

/* ---- NOT caught, and named in ADR-0081 §1 rather than left to be discovered. ------------------- */
/* TypeScript has no defence against `as` short of a runtime wrapper, which §1 rejects for changing the
   seam shape. Neither form is reachable by accident — each requires writing a construct whose only
   purpose is to defeat the type — which is exactly the bound the ADR claims: a forgery is VISIBLE, not
   impossible. These lines contribute ZERO errors; if a future rule ever catches one, the count drifts
   and `assert-fence.mjs` fails, which is the signal to update the ADR. */

function genericCast<T>(value: unknown): T {
  return value as T;
}
export const viaGeneric = genericCast<AuthoredSystemPrompt>(dynamic);

interface Holder {
  readonly prompt: AuthoredSystemPrompt;
}
export const viaInterfaceField = { prompt: dynamic } as Holder;

/* ---- MUST NOT fire: legitimate uses of the type. ---------------------------------------------- */
/* Without these the fence could be "airtight" by flagging every mention of the name, which would make
   the type unusable and get the rule disabled — the failure mode a fence is most likely to die of. */

export function accepts(prompt: AuthoredSystemPrompt): AuthoredSystemPrompt {
  return prompt;
}
export declare const annotated: AuthoredSystemPrompt;
