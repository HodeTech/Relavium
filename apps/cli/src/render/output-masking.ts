import { scrubSecrets } from '@relavium/llm/scrub-secrets';

/**
 * The one masking seam for a node's or a run's OUTPUT, on every human surface (ADR-0140 §2 and §4, MVP-8 step 4): the final summary
 * (`run-outputs.ts`, which `run`, the plain renderer and `logs` print) and the node page's output preview
 * (`history/node-detail-model.ts`) both mask through the functions below and through no other, so a rule changed here changes both and a
 * value one of them masks cannot reach the terminal through the other. A test masks a seeded set of outputs through both and compares
 * what they show (`output-masking.test.ts`).
 *
 * **The rule is the final summary's, and it is a rule about WHOLE values.** A value is masked whole, and only then is it cut: a cut made
 * first can leave a prefix of a secret that the scrubber no longer recognizes, so no cap (a line bound, a character bound, a leaf bound, a
 * key bound) is applied to text the scrubber has not read in full. Each string leaf is read on its own, so one field's text never joins
 * its neighbour's into a false match and a line break inside a leaf keeps its word boundary (a serialized `\n` would hide it). A leaf alone
 * cannot show a shape whose name is the member's KEY (`"x-api-key": "…"`), so a member with a primitive value also has its NAME read
 * ({@link namesCredential}); when the name labels a credential the member's value is masked whole ({@link maskedAsMember}), however long
 * it is and whatever a later cap would have shown of it. A name labels a credential in two ways: the scrubber's own header and query
 * rules read it as one (`x-api-key`, `?token=`), or it is one of the exact names in {@link CREDENTIAL_MEMBER_NAMES} (`apiKey`, `password`,
 * `client_secret`, `Authorization`…), which the scrubber has no rule for because an opaque value has no shape of its own.
 *
 * Nothing here caps, joins or serializes: that is each surface's own bound (the summary's 40 lines, 4,000 code points and 12,000 per run;
 * the page's 40 lines, 4,000 code points, 32,768 per leaf and 256 per key). What a surface does with a masked value is its own business;
 * what a masked value IS is decided here.
 */

/** The text a member masked whole shows — the shared scrubber's own mask. */
export const MEMBER_MASK = '[REDACTED]';
/** The stand-in value a member's name is read with: one character, which the scrubber's header rule masks. */
const NAME_PROBE = 'v';

/**
 * The member names that label a credential WITHOUT the scrubber's header or query form, as a JSON document writes them
 * (`apiKey`, `api_key`, `password`, `client_secret`, `Authorization`). A name is compared as it stands once it is lower-cased
 * and its `-`, `_`, `.` and whitespace are removed ({@link normalizedMemberName}), so `apiKey`, `API_KEY` and `api-key` are one entry.
 * The list is EXACT and short on purpose: a broader rule (`key`, `tokens`, `max_tokens`, `author`, `passwordless`, `api_key_id`)
 * would mask ordinary data, and a name that is not here masks nothing. It only ADDS masks: a name the scrubber's own rules already
 * read as a label stays one (PR #102 review P1-14). Most entries are the scrubber's own query-string names (`QUERY_SECRET_RULE`), less
 * its `key` and `auth`, which are too broad for a member name.
 */
export const CREDENTIAL_MEMBER_NAMES: ReadonlySet<string> = new Set([
  'apikey',
  'apisecret',
  'xapikey',
  'xgoogapikey',
  'secret',
  'secretkey',
  'clientsecret',
  'privatekey',
  'accesskey',
  'password',
  'passwd',
  'passphrase',
  'authorization',
  'credential',
  'credentials',
  'token',
  'accesstoken',
  'authtoken',
  'bearertoken',
  'idtoken',
  'refreshtoken',
  'sessiontoken',
]);

/**
 * `text` with its secret shapes masked by the shared scrubber, read in full. `onMask` is told when the scrubber changed anything, so a
 * surface can say its text was masked. The one place a leaf, a key, or a joined text is read; every surface that masks goes through it.
 */
export function maskText(text: string, onMask: () => void): string {
  const out = scrubSecrets(text);
  if (out !== text) onMask();
  return out;
}

/** A masked text, and whether it was cut to a limit AFTER it was masked. */
export interface MaskedCut {
  readonly text: string;
  readonly cut: boolean;
}

/**
 * `text` masked whole ({@link maskText}) and only then cut to `limit` UTF-16 code units. The order is the point: the cut never sees text the
 * scrubber has not read in full, so a secret that straddles the limit is masked before the limit decides what is shown. The cut never
 * falls between the two halves of a surrogate pair: an emoji at the limit is left out whole, so the shown text is one code unit shorter
 * rather than ending in a lone surrogate, which a terminal draws as a replacement character.
 */
export function maskThenCut(text: string, limit: number, onMask: () => void): MaskedCut {
  const out = maskText(text, onMask);
  if (out.length <= limit) return { text: out, cut: false };
  return { text: out.slice(0, codePointBoundary(out, limit)), cut: true };
}

/** The largest index at or below `limit` that is not between a high surrogate and its low one. */
function codePointBoundary(text: string, limit: number): number {
  if (!(limit > 0)) return 0; // NOSONAR — S1940: the negation is deliberate, it is also true for NaN, which `<=` would let through to the read below
  // A pair that starts at `limit - 1` reads as one code point above U+FFFF, so `limit` is then its low half; a lone high surrogate reads as itself.
  const startsPair = (text.codePointAt(limit - 1) ?? 0) > 0xffff;
  return startsPair ? limit - 1 : limit;
}

/**
 * A copy of `value` with every string, and every object key, passed through `scrub`, and every object member with a
 * primitive value masked whole when its name labels a credential ({@link maskedAsMember}). It follows `JSON.stringify`'s
 * own reading of an object that defines `toJSON`, and throws on a cycle, as `JSON.stringify` would. This is the EAGER form of the rule,
 * for a surface that prints every value; a surface that shows only the head of a large document applies {@link maskText} and
 * {@link maskedAsMember} as it walks, and masks no more than it shows.
 */
export function scrubLeaves(
  value: unknown,
  scrub: (text: string) => string,
  onMask: () => void,
  ancestors: Set<object>,
): unknown {
  if (typeof value === 'string') return scrub(value);
  if (typeof value !== 'object' || value === null) return value;
  if (hasToJson(value)) return scrubLeaves(value.toJSON(), scrub, onMask, ancestors);
  if (ancestors.has(value)) throw new TypeError('a cyclic output value');
  ancestors.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item) => scrubLeaves(item, scrub, onMask, ancestors));
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      const member = scrubLeaves(item, scrub, onMask, ancestors);
      // `defineProperty`, not assignment: an own `__proto__` member (JSON.parse makes one) would otherwise hit the
      // prototype setter and vanish from the display. Two keys masked to the same text keep the later one; the
      // block's note then says it was masked.
      Object.defineProperty(copy, scrub(key), {
        value: maskedAsMember(key, member, onMask),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return copy;
  } finally {
    ancestors.delete(value);
  }
}

/**
 * `member` (already masked leaf by leaf), or {@link MEMBER_MASK} in its place when its name labels a credential
 * ({@link namesCredential}); `onMask` is told. Only a value JSON prints as itself is read this way: an object or
 * array is read member by member by the walk itself, and `JSON.stringify` drops `undefined`, a function or a symbol.
 * A name only the exact list knows ({@link CREDENTIAL_MEMBER_NAMES}) masks a string or a number, not a boolean or a
 * null: neither carries a credential, and `{ secret: true, ref }` is how the engine already shows a masked secret
 * input, which must stay readable. A name the scrubber reads as a label masks every such value, as it always did.
 * The node page's output preview applies the same member rule as the summary (MVP-8 step 1).
 */
export function maskedAsMember(key: string, member: unknown, onMask: () => void): unknown {
  if (typeof member === 'object' && member !== null) return member;
  if (member === undefined || typeof member === 'function' || typeof member === 'symbol') {
    return member;
  }
  const label = credentialLabel(key);
  if (label === undefined) return member;
  if (label === 'listed' && typeof member === 'boolean') return member;
  if (label === 'listed' && member === null) return member;
  onMask();
  return MEMBER_MASK;
}

/**
 * Whether `key` labels a credential, by the scrubber's own rule or by the exact list ({@link credentialLabel}). Only the
 * name decides: the member's own text never enters this view.
 */
export function namesCredential(key: string): boolean {
  return credentialLabel(key) !== undefined;
}

/**
 * How `key` labels a credential, if it does. `'scrubber'`: read as the one-member JSON text `{"<key>":"v"}`, the form
 * the scrubber sees in a serialized object, with a stand-in value, the scrubber masks that value. The member's own text
 * never enters this view, so its JSON escapes (`\n` for a newline) cannot stretch a token the leaf pass already masked
 * at a line end into a whole-value mask. `'listed'`: the name, normalized, is one of {@link CREDENTIAL_MEMBER_NAMES}
 * (`apiKey`, `password`, `client_secret`), which no scrubber rule reads because their values have no shape.
 *
 * A name the scrubber masks up to its end on its own (`Basic plan`, `Bearer token`, a URL ending in `?key=1`) is
 * itself a secret shape, not a label, and no list entry changes that (`Bearer token` normalizes to a listed name): its
 * token has nothing after it in the name, so in the serialized view the token runs on over the closing quote into the
 * stand-in. It is shown masked and masks only itself, not its value.
 */
function credentialLabel(key: string): 'scrubber' | 'listed' | undefined {
  const own = scrubSecrets(key);
  if (own !== key && own.endsWith(MEMBER_MASK)) return undefined;
  const tail = `:${JSON.stringify(NAME_PROBE)}}`;
  if (!scrubSecrets(JSON.stringify({ [key]: NAME_PROBE })).endsWith(tail)) return 'scrubber';
  return CREDENTIAL_MEMBER_NAMES.has(normalizedMemberName(key)) ? 'listed' : undefined;
}

/** `key` lower-cased with `-`, `_`, `.` and whitespace removed: `apiKey`, `API_KEY` and `api-key` are one name. */
function normalizedMemberName(key: string): string {
  return key.toLowerCase().replaceAll(/[\s._-]/gu, '');
}

function hasToJson(value: object): value is { toJSON: () => unknown } {
  return 'toJSON' in value && typeof value.toJSON === 'function';
}
