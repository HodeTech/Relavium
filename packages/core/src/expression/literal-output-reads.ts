/**
 * The **conservative literal scan** over a `condition` / `transform` / `merge_fn` expression: which node
 * ids does this expression *literally* read out of `run.outputs`?
 *
 * It exists because the engine cannot observe such a read at run time. [ADR-0027](../../../../docs/decisions/0027-expression-sandbox.md)
 * §3 makes marshaling JSON-only — the host `JSON.stringify`s the scope and the VM `JSON.parse`s it — and
 * `Proxy` is deliberately never among the sandbox intrinsics, so a property the host omits is simply
 * `undefined` inside the VM, with nothing to throw from. A `condition` reading a node it is not ordered
 * after therefore compares against `undefined` and takes the false branch in silence.
 *
 * **It is a scan, not a parser, and that distinction is the decision** ([ADR-0093](../../../../docs/decisions/0093-an-expression-sees-only-what-it-is-ordered-after.md)
 * §2). It reads only literal accesses and makes no attempt to follow a computed key, an aliased binding,
 * or a value flowing through a variable. Where it cannot tell, it says nothing — it never guesses, never
 * synthesizes an edge, and never changes the graph's shape. Building a second full grammar for the
 * sandbox's language is exactly what that avoids: because the scan's failure mode is silence, it cannot
 * drift into disagreeing with the sandbox about what an expression means.
 */

/** One literal `run.outputs` access found in an expression. */
export interface LiteralOutputRead {
  /** The node id named by the access. */
  readonly id: string;
  /** How it was written — used only to keep a diagnostic precise, never to change the verdict. */
  readonly form: 'bracket' | 'dot';
}

/**
 * Replace every character inside a string/template literal or a comment with NUL, preserving length, so a
 * caller can ask of any position: *was this code?* Returns `undefined` when the input ends inside a literal
 * or block comment — the caller then scans nothing at all.
 *
 * **A position map, not a substitute input.** A first version masked the text and then ran the access
 * patterns over the RESULT, which cannot work: the key in `run.outputs["a"]` is itself a string literal, so
 * masking erased the very thing the scan exists to read, and every double-quoted access came back clean.
 * The patterns run over the ORIGINAL text; this only decides whether a match STARTED in code.
 *
 * **Every way this can be wrong points at silence, and that is what makes the scan safe to run at parse
 * time.** It is not a JavaScript lexer and does not try to be: a regex literal containing a quote, for
 * instance, is mis-read as opening a string. That can only ever blank MORE text than it should — which
 * loses a candidate read, where the narrowed scope is still the backstop — and it can never invent one,
 * because masking only removes. A false refusal would be precisely the drift ADR-0093 forbids: a workflow
 * that loaded yesterday refused today for a read that is not there.
 *
 * A template literal is blanked WHOLE, `${…}` substitutions included. Their contents are code and may hold
 * a real access; reading them needs the nesting a lexer provides, and missing them is silence.
 */
const NUL = '\u0000';

export function maskLiterals(text: string): string | undefined {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') {
        out += NUL;
        i += 1;
      }
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = text.indexOf('*/', i + 2);
      if (close === -1) {
        return undefined;
      }
      out += NUL.repeat(close + 2 - i);
      i = close + 2;
      continue;
    }
    // **Any other `/` abandons the scan.** Telling a regex literal from division is the one genuinely hard
    // part of lexing JavaScript, and getting it wrong in the "thought it was division" direction is not
    // silence: a regex holding an ODD number of quotes shifts every later string boundary by one, so a real
    // string's opening quote is consumed and its CONTENTS become code — and a second odd-quoted regex
    // restores parity, so the mask terminates normally and a fabricated read survives. The cost of bailing
    // is that an expression containing division is never scanned, which is silence, which is safe.
    if (ch === '/') {
      return undefined;
    }
    // Annex B B.1.3 HTML-like comments. QuickJS accepts them; treating their contents as code would make
    // a commented-out access refusable. Abandoned rather than lexed — the same trade as `/`.
    if (text.startsWith('<!--', i) || text.startsWith('-->', i)) {
      return undefined;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      let closed = false;
      while (j < text.length) {
        if (text[j] === '\\') {
          j += 2;
          continue;
        }
        // A `${` inside a template opens CODE, and that code can itself contain a nested template. Pairing
        // backticks flat leaves the inner template's text marked as code, which is a false-find shape.
        // Tracking the nesting is the lexer this deliberately is not, so it abandons instead.
        if (ch === '`' && text[j] === '$' && text[j + 1] === '{') {
          return undefined;
        }
        if (text[j] === ch) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        return undefined;
      }
      out += NUL.repeat(j + 1 - i);
      i = j + 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/**
 * Does this code REBIND the identifier `run`? A parameter, a destructure, or a declaration named `run`
 * shadows the sandbox global, and `((run) => run.outputs["x"])(inputs.alias)` then reads something else
 * entirely — reporting it is a false refusal.
 *
 * The test is deliberately crude and errs toward silence: a *use* of the scope's `run` is always written
 * `run.` or `run?.`, so any `run` token followed by anything else is treated as possibly a binding and the
 * whole expression goes unscanned. That catches `(run) =>`, `const run =`, `{ run }` and `function(run)`
 * alike without knowing which is which — and it also silences innocent uses like `typeof run`, which costs
 * only coverage.
 */
function rebindsRun(code: string): boolean {
  const token = /(?<![\w$])run(?![\w$])/g;
  let match = token.exec(code);
  while (match !== null) {
    const rest = code.slice(match.index + 3);
    if (!/^\s*\??\./.test(rest)) {
      return true;
    }
    match = token.exec(code);
  }
  return false;
}

/**
 * `run.outputs["id"]` / `run.outputs['id']`. The key must be a whole single- or double-quoted literal: a
 * template key (`run.outputs[`${x}`]`) or a computed one (`run.outputs[k]`) matches nothing, which is the
 * point — those are the cases the scan deliberately cannot tell about.
 *
 * **The `(?<![.?\w$])` lookbehind is load-bearing, not tidiness.** A plain `\brun` matches the `run` in
 * `foo.run.outputs["x"]` — a member expression on some OTHER object, which an author can reach through
 * `inputs`/`ctx` — and refusing that is a FALSE REFUSAL, the one failure mode this scan must not have.
 * Optional chaining (`run?.outputs?.["x"]`) is accepted because it is the same literal access written
 * another way; not accepting it would be a silent gap in enforcement rather than an unsafe guess.
 */
const BRACKET_ACCESS = /(?<![.?\w$])run\s*\??\.\s*outputs\s*\??\.?\s*\[\s*(['"])([^'"\\]*)\1\s*\]/g;

/**
 * `run.outputs.id`. Only matches an identifier, so a kebab-case node id — the common shape — is
 * unreachable this way in JavaScript anyway (`run.outputs.my-node` is a subtraction, not an access).
 */
const DOT_ACCESS = /(?<![.?\w$])run\s*\??\.\s*outputs\s*\??\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Every literal `run.outputs` access in `expression`, de-duplicated, in first-appearance order.
 *
 * Returns an EMPTY list both when there are genuinely no literal reads and when the masker could not make
 * sense of the text. The two are deliberately indistinguishable to the caller: in both cases the scan has
 * nothing it is confident enough to refuse on, and silence is the contract.
 */
export function literalOutputReads(expression: string): readonly LiteralOutputRead[] {
  const mask = maskLiterals(expression);
  if (mask === undefined || rebindsRun(mask)) {
    return [];
  }
  const seen = new Set<string>();
  const reads: LiteralOutputRead[] = [];
  const collect = (pattern: RegExp, group: number, form: LiteralOutputRead['form']): void => {
    pattern.lastIndex = 0;
    // Matched against the ORIGINAL text — the key is a string literal and would be masked away — then
    // filtered by where the match began. `run` inside a comment or a surrounding string is masked, so a
    // mention of an access is never mistaken for one.
    let match = pattern.exec(expression);
    while (match !== null) {
      const id = match[group];
      if (id !== undefined && id !== '' && mask[match.index] !== NUL && !seen.has(id)) {
        seen.add(id);
        reads.push({ id, form });
      }
      match = pattern.exec(expression);
    }
  };
  collect(BRACKET_ACCESS, 2, 'bracket');
  collect(DOT_ACCESS, 1, 'dot');
  return reads;
}
