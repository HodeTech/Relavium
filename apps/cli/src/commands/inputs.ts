import type { WorkflowDefinition } from '@relavium/core';

import { CliError } from '../process/errors.js';

type InputDecl = NonNullable<WorkflowDefinition['workflow']['inputs']>[number];

/** Parse repeatable `--input key=value` tokens into a raw string map. */
export function parseInputArgs(rawInputs: readonly string[]): Record<string, string> {
  // **A null-prototype accumulator** — the same §7 discipline the engine's admission map, the resume
  // identity maps and `gate`'s secret merge all use, and the one CLI accumulator that was missed. An input
  // name may legitimately be `__proto__` (the `[A-Za-z0-9_-]+` grammar permits it), and on a plain `{}` the
  // assignment below goes through `Object.prototype`'s `__proto__` ACCESSOR: a string value is a silent
  // no-op, so `--input __proto__=…` vanished with no own property and no error, and the later read returned
  // `Object.prototype` itself — which a `number`-typed input then handed to `coerce`, throwing an untyped
  // `TypeError` that escaped as "an unexpected internal error". ADR-0083 §9.7 names the CLI path explicitly.
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const entry of rawInputs) {
    const eq = entry.indexOf('=');
    if (eq <= 0) {
      throw new CliError('invalid_invocation', `--input must be key=value (got '${entry}').`);
    }
    const key = entry.slice(0, eq);
    // Reject a repeated key rather than silently last-wins — a duplicate `--input k=…` is a mistake
    // (each input is distinct), and the surface's posture is fail-fast on malformed invocation.
    if (Object.hasOwn(out, key)) {
      throw new CliError('invalid_invocation', `--input '${key}' was given more than once.`);
    }
    out[key] = entry.slice(eq + 1);
  }
  return out;
}

/**
 * Coerce + validate the raw string inputs against the workflow's declared `inputs`: reject an
 * unknown key, require a non-defaulted required input, and coerce by declared type (since `--input`
 * always arrives as a string). Deep per-field validation (min/max/format) stays the engine's; this
 * is the surface's fail-fast on shape (exit 2). Returns the typed inputs for `WorkflowEngine.start`.
 */
export function resolveInputs(
  def: WorkflowDefinition,
  raw: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const declared = def.workflow.inputs ?? [];
  const names = new Set(declared.map((decl) => decl.name));

  for (const key of Object.keys(raw)) {
    if (!names.has(key)) {
      throw new CliError('invalid_invocation', `unknown input '${key}'.`);
    }
  }

  const resolved: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const decl of declared) {
    // `Object.hasOwn` before the read, because `raw` is a caller's object here: a plain literal would answer
    // `raw['__proto__']` with `Object.prototype` rather than `undefined`, turning an omitted input into a
    // present one whose value is not a string.
    const provided = Object.hasOwn(raw, decl.name) ? raw[decl.name] : undefined;
    if (provided === undefined) {
      if (decl.required === true && decl.default === undefined) {
        throw new CliError('invalid_invocation', `missing required input '${decl.name}'.`);
      }
      continue; // omitted — the engine applies the declared default, if any
    }
    resolved[decl.name] = coerce(decl.name, decl.type, provided);
  }
  return resolved;
}

function coerce(name: string, type: InputDecl['type'], value: string): unknown {
  switch (type) {
    case 'number': {
      const trimmed = value.trim();
      // `Number('') === 0` (and `Number('  ') === 0`), so reject an empty/whitespace value — otherwise
      // `--input n=` would silently yield 0. A literal `n=0` still trims to '0'.
      if (trimmed === '') {
        throw new CliError(
          'invalid_invocation',
          `input '${name}' must be a number (got an empty value).`,
        );
      }
      // `Number('0x10') === 16`, `Number('0o17') === 15`, `Number('0b11') === 3` — JS radix literals
      // parse to a surprising finite value, so a `--input n=0x10` typo would become 16. Restrict to a
      // plain decimal/scientific shape; `Number.isFinite` then rejects a malformed remainder (`1.2.3`).
      const isDecimalShape = [...trimmed].every((ch) => '0123456789.eE+-'.includes(ch));
      const parsed = isDecimalShape ? Number(trimmed) : Number.NaN;
      if (!Number.isFinite(parsed)) {
        throw new CliError(
          'invalid_invocation',
          `input '${name}' must be a decimal number (got '${value}').`,
        );
      }
      return parsed;
    }
    case 'boolean': {
      if (value === 'true' || value === '1') {
        return true;
      }
      if (value === 'false' || value === '0') {
        return false;
      }
      throw new CliError(
        'invalid_invocation',
        `input '${name}' must be a boolean (true/false or 1/0).`,
      );
    }
    default:
      return value; // string / file_path / code_diff / secret stay as strings
  }
}
