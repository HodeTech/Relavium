import { type LineCounter, parse as parseYaml } from 'yaml';

/**
 * The single hardened, deterministic YAML 1.2-core decode profile (ADR-0035) every authored-YAML parser
 * shares — `parseWorkflow` ({@link ./parser.ts}) and `parseAgent` ({@link ./agent-parser.ts}). The decode
 * produces only plain JSON-like data on every surface (no `Date`/`Buffer`, no anchors/aliases, no merge
 * keys, duplicate keys rejected); strict Zod then enforces the actual contract. Throws the raw
 * `YAMLParseError` on a syntax fault — each parser normalizes it to its own typed, secret-free error, so the
 * profile stays one definition and can never drift between the two parsers.
 */
export function decodeHardenedYaml(yamlText: string, lineCounter: LineCounter): unknown {
  return parseYaml(yamlText, {
    version: '1.2',
    schema: 'core', // YAML 1.2 core only — `!!timestamp`/`!!binary` never become a Date/Buffer
    resolveKnownTags: false, // an unknown `!!`-tag stays a string, never a platform object
    merge: false, // no YAML-1.1 `<<` merge keys
    uniqueKeys: true, // a duplicate map key is an error
    stringKeys: true, // complex/non-string keys are rejected (a deterministic object shape)
    maxAliasCount: 0, // anchors/aliases are not part of the authored contract — no alias-bomb expansion
    prettyErrors: false, // no source snippet in the message (secret-free); line/col via the LineCounter
    logLevel: 'error', // no `console.warn` — the parser stays a pure function (no I/O side effect)
    lineCounter,
  });
}
