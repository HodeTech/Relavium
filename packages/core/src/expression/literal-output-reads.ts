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
  const token = /(?<![\p{ID_Continue}$])run(?![\p{ID_Continue}$])/gu;
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
 * **`(?:\?\.\s*)?`, not `\??\.?\s*`** — the optional-chain step is ONE atomic alternative rather than two
 * independently optional characters between two `\s*`. Written the loose way, a whitespace run with no `[`
 * after it could be split between the two `\s*` at every position, and the match failed quadratically:
 * measured 8.6 ms at 4 K of whitespace, 39 ms at 8 K, 115 ms at 16 K, 514 ms at 32 K — and the parser
 * accepts a 2 MiB source while plan build is synchronous, so no deadline or cancel can interrupt it. The
 * loose form was also wrong: `outputs.["x"]` is not valid JavaScript, only `outputs?.["x"]` is.
 *
 * `run.outputs["id"]` / `run.outputs['id']`. The key must be a whole single- or double-quoted literal: a
 * template key (`run.outputs[`${x}`]`) or a computed one (`run.outputs[k]`) matches nothing, which is the
 * point — those are the cases the scan deliberately cannot tell about.
 *
 * The base must be a FREE `run`, not a property of something else — see {@link isFreeRunReference}, which
 * decides that rather than the pattern. Optional chaining (`run?.outputs?.["x"]`) is accepted because it
 * is the same literal access written another way; not accepting it would be a silent gap in enforcement
 * rather than an unsafe guess.
 */
const BRACKET_ACCESS =
  /(?<![.?\w$])run\s*\??\.\s*outputs\s*(?:\?\.\s*)?\[\s*(['"])([^'"\\]*)\1\s*\]/g;

/**
 * `run.outputs.id`. Only matches an identifier, so a kebab-case node id — the common shape — is
 * unreachable this way in JavaScript anyway (`run.outputs.my-node` is a subtraction, not an access).
 */
const DOT_ACCESS = /(?<![.?\w$])run\s*\??\.\s*outputs\s*\??\.\s*([A-Za-z_$][A-Za-z0-9_$]*)/g;

/**
 * Does the CODE (literals already masked) contain a backslash?
 *
 * In code position a backslash is a Unicode identifier escape — `r\u0075n` IS the identifier `run` to the
 * engine, and to this scanner it is not. A shadowing binding written that way therefore read as the scope's
 * `run`: `((r\u0075n) => run.outputs["ghost"])({outputs:{ghost:1}})` reported `ghost` while the real sandbox
 * evaluates it against the local binding and never touches the scope — a FALSE REFUSAL, the one failure
 * ADR-0093 §2's whole argument rests on not having.
 *
 * Decoding escapes would mean tracking identifier boundaries, which is the lexer this deliberately is not.
 * The scan abandons instead, which is the direction every other uncertainty here already fails in.
 */
function hasIdentifierEscape(code: string): boolean {
  return code.includes('\\');
}

/**
 * Is the `run` at `index` a FREE reference to the sandbox global, rather than a property of some other
 * object? `foo.run.outputs["x"]` reads a nested field of foreign data — naming it is a false refusal.
 *
 * **A backward walk, not a lookbehind, because JavaScript allows whitespace and comments between the `.`
 * and the property name.** A single-character lookbehind saw only what sits immediately before `run`, so
 * `a . run.outputs["x"]`, `a ?. run.outputs["x"]`, `a./*c*&#47;run.outputs["x"]`, `a["k"] . run…` and
 * `this . run…` all slipped through as scope reads — five shapes, all valid member accesses on something
 * else. Skipping masked characters is what covers the comment case: the comment is already NUL here, and
 * skipping it lands the walk on the `.` that must reject.
 *
 * Whitespace-only or a leading position means a free reference, which is the accepting answer.
 */
function isFreeRunReference(mask: string, index: number): boolean {
  let i = index - 1;
  while (i >= 0) {
    const ch = mask[i];
    if (ch === undefined) {
      return true;
    }
    // NUL is a masked literal or comment; whitespace is whitespace. Neither ends the member expression.
    if (ch === NUL || /\s/.test(ch)) {
      i -= 1;
      continue;
    }
    // `.` / `?` mean this is a property access; an identifier character means `run` is the TAIL of a longer
    // identifier.
    //
    // **`\p{ID_Continue}`, not `\w`.** `\w` is `[A-Za-z0-9_]` — ASCII only, with or without the `u` flag —
    // while a JavaScript identifier may contain any Unicode ID_Continue character. So `x.çrun.outputs["g"]`
    // passed every ASCII guard: `ç` is not `.`, `?`, or `\w`, so the walk called it a free `run` and named
    // `g`. Verified against the real sandbox: that expression reads a self-contained object literal and
    // never touches the scope, so refusing it was a false refusal.
    return !(ch === '.' || ch === '?' || /[\p{ID_Continue}$]/u.test(ch));
  }
  return true;
}

/**
 * Every literal `run.outputs` access in `expression`, de-duplicated — all BRACKET accesses in source order,
 * then all DOT accesses. Not first-appearance order across the two forms, which an earlier docblock claimed:
 * the two patterns are run one after the other. Order is not load-bearing (the caller checks membership),
 * so the doc is corrected rather than the code.
 *
 * Returns an EMPTY list both when there are genuinely no literal reads and when the masker could not make
 * sense of the text. The two are deliberately indistinguishable to the caller: in both cases the scan has
 * nothing it is confident enough to refuse on, and silence is the contract.
 */
export function literalOutputReads(expression: string): readonly LiteralOutputRead[] {
  const mask = maskLiterals(expression);
  if (mask === undefined || hasIdentifierEscape(mask) || rebindsRun(mask)) {
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
      if (
        id !== undefined &&
        id !== '' &&
        mask[match.index] !== NUL &&
        isFreeRunReference(mask, match.index) &&
        !seen.has(id)
      ) {
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
