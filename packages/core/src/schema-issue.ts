import type { ZodIssue } from 'zod';

/**
 * A user-facing message for a Zod issue. Deliberately code-derived (type names, key names, enum
 * options) — it never echoes an authored *value*, so a secret in a credential field can never leak.
 *
 * `custom` issues come from `@relavium/shared`'s `superRefine` calls. Today every one of them emits
 * a structural message (schema-defined key names, kebab-id-validated identifiers, type-enum labels)
 * — never an authored *value*. The explicit `case 'custom':` here makes that invariant visible in
 * the call site: if a future refine ever embeds an authored value, this switch is the first place a
 * reviewer should add a safe, value-free override. The `default` branch is the last-resort fallback
 * for Zod codes not yet seen in practice; it returns a generic message so an unknown code can never
 * accidentally surface a payload.
 */
export function schemaIssueReason(issue: ZodIssue): string {
  switch (issue.code) {
    case 'invalid_literal':
      return `expected literal ${typeof issue.expected === 'string' ? JSON.stringify(issue.expected) : String(issue.expected)}`;
    case 'invalid_type':
      return issue.received === 'undefined'
        ? `missing — expected ${issue.expected}`
        : `expected ${issue.expected}, received ${issue.received}`;
    case 'unrecognized_keys':
      return `unknown key${issue.keys.length === 1 ? '' : 's'}: ${issue.keys
        .map((key) => `\`${key}\``)
        .join(', ')}`;
    case 'invalid_enum_value':
      return `invalid value — expected one of: ${issue.options.map(String).join(', ')}`;
    case 'invalid_union_discriminator':
      return `expected one of: ${issue.options.map(String).join(', ')}`;
    case 'invalid_string':
    case 'too_small':
    case 'too_big':
      // Zod's built-in messages for these codes are purely structural (constraint metadata, not the
      // authored value), so they are safe to surface directly.
      return issue.message;
    case 'custom':
      // All @relavium/shared superRefines emit structural-only messages — see the comment above.
      return issue.message;
    default:
      // A Zod code not explicitly handled — return a generic message rather than risking an echo of
      // an authored value via issue.message (which is code-derived for the built-in codes, but could
      // change in future Zod versions).
      return 'invalid value';
  }
}
