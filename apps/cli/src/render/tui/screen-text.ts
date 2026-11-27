/**
 * The screen's text filter and its width classifier (MVP-11 unit 9, review rounds 1 to 4: S-1, S-3, S2-1, S2-4, C2-1, M2-3, R3S-1 to R3S-5,
 * R4-S-3, R4-S-6): what untrusted text may hold when it is drawn on a terminal, so that the layout and the terminal count it alike.
 *
 * **Why.** The chat lays a row out with the width the layout measures (`string-width`), and the grid's margin guarantee is exact in that layout:
 * a row is at most the content column wide, in a cell that starts at the margin. A terminal measures some characters differently, and a row the
 * layout sized to fit can then reach the right edge on screen: the terminal wraps it, and the rest starts at column 0 of the next physical row,
 * the margin, where the host draws who spoke. The reference terminal is tmux 3.7b, measured code point by code point over the planes text uses,
 * sequence by sequence for every class below, and on a SEQUENCE differential of random strings over all of Unicode and natural paragraphs (each
 * string written after an `A`, the cursor read back with `ESC[6n`; review rounds 2 to 4); `terminal-widths.test.ts` holds those tables and holds
 * the LAYOUT's measure (`viewport.ts` `displayWidth`: `string-width`, and every spacing character of an Indic conjunct or a Prepend cluster, which
 * this filter does not touch: review round 4, R4-S-1) of every FILTERED measured string to at least what tmux drew for it; and
 * `terminal-wrap.test-support.ts` draws the witness frames with them. All of it is tmux 3.7b only.
 *
 * **Where it runs: before the layout.** A rewrite below can change the width the layout measures (a decomposed AM, a selector added), so the
 * filter runs on the text BEFORE anything lays it out: a transcript entry's source (`chat-projection.ts` `entryRows`), the stream before the live
 * tail is laid out ({@link ScreenStream}), every one-line producer before it is fitted (review round 3, R3S-1: run after the layout, a decomposed
 * AM grew a row past the content column, the full-screen viewport clipped the newest rows and the acknowledgement counted a notice it did not
 * show). Run again over a laid-out row it changes nothing ({@link screenText} is idempotent), except where the layout itself joined two pieces the
 * source kept apart (markdown emphasis between two of them); there the row can grow, and the full-screen viewport clips a row to its cell
 * (`transcript-row.tsx`), so one row stays one physical row whatever a width says.
 *
 * **The classes**, all measured on tmux (`string-width` against the terminal):
 *
 * - **Dropped**: the default-ignorable and format code points (`\p{Default_Ignorable_Code_Point}`, `\p{Cf}`: the Hangul fillers, the soft hyphen,
 *   the word joiner and its kin, the tag and variation-selector supplements, the prepended concatenation marks; tmux draws U+115F two columns,
 *   U+FFA0, U+00AD and others one), every skin tone U+1F3FB to U+1F3FF (tmux joins a tone to only some of the bases that take one and draws
 *   `☝🏽`, `🏃🏽` and 62 more four columns where the layout counts two: a tone is not drawn), U+FE0F where it does not make an emoji the layout
 *   draws two columns wide (`a`+U+FE0F, a digit+U+FE0F: two on tmux), a lone surrogate (written as U+FFFD), the Hangul and Vietnamese tone marks
 *   U+302E, U+302F, U+16FF0, U+16FF1 (spacing marks the layout counts as 0 columns, tmux 2), and whatever follows an emoji the layout draws wide
 *   only as a whole (a flag, `❤️`, a keycap, `☝️`, an emoji zero-width-joiner sequence): a joiner, a combining mark, a selector after it makes the
 *   cluster one the layout no longer recognises and counts one column, tmux two.
 * - **Rewritten** to a form both measure alike: the Thai and Lao vowel AM (U+0E33, U+0EB3) as its compatibility decomposition (U+0E4D U+0E32,
 *   U+0ECD U+0EB2: the same glyphs); a regional indicator that is not half of a flag followed by a zero width non-joiner (a pair that is not a
 *   flag is two columns on tmux and one to the layout; a flag stays as it is and gets no joiner after it, which would make it one column to the
 *   layout and two on tmux: review round 3, R3S-2); the nine emoji bases a terminal draws two columns although they are text by default (`☝`,
 *   `⛹`, `✌`, `✍`, `🏋`, `🏌`, `🕴`, `🕵`, `🖐`: the layout counts one) with U+FE0F after them; an emoji zero-width-joiner sequence that is not a
 *   recommended one (tmux draws a chain of more than eight as two clusters) as its members, each on its own.
 *
 * **What is kept as it is.** The zero width joiner and non-joiner and the text selector U+FE0E after a letter (Indic and Arabic shaping); an
 * emoji with its presentation selector, a keycap, a flag, a recommended zero-width-joiner sequence (families, professions, `❤️‍🔥`), a subdivision
 * flag's tag characters. Not every terminal agrees with tmux: a terminal without zero-width-joiner support draws a family as its members, and a
 * CJK locale draws the ambiguous-width characters two columns (recorded residuals; the only general cure is autowrap off, not done).
 *
 * **What a person sees differs from what was written** (review round 3, R3S-4, recorded): Thai and Lao are drawn decomposed (a drag-copy copies
 * the decomposed form); a skin tone is not drawn; U+0600 and U+06DD (prepended marks) are dropped; regional indicators carry the joiner. The
 * documents (`/copy`, `/edit`, the history) keep every byte: only the screen's rows are filtered.
 *
 * **An orphan mark** (S-3): a combining mark or a kept joiner that starts a line has no character of its own to sit on, and a terminal paints it
 * on the cell before the row: the margin's last column. It is dropped at the start of each line.
 *
 * **The decision surfaces** never drop what is decided on: the approval card escapes every code point of the risky classes as `<U+XXXX>`
 * ({@link isWidthRiskCodePoint}, `tool-review-projection.ts`); the question card draws its labels and headers through this filter, and when two
 * of a set would draw alike at the row's cut (or one would draw empty) writes all of them one-to-one ({@link escapeScreenText}, `question-card.ts`
 * `decisionTexts`).
 *
 * **Linear.** Every pattern here is forward and bounded (review round 2, C2-1): `screen-text-performance.test.ts` holds each function to a bound on
 * a 64,000-character hostile run of every class.
 *
 * Pure: no `ink`, no `react`, no `node:` import (ADR-0145 §10).
 */

const ZWNJ = String.fromCodePoint(0x200c);
const ZWJ = String.fromCodePoint(0x200d);
const VS15 = String.fromCodePoint(0xfe0e);
const VS16 = String.fromCodePoint(0xfe0f);
const KEYCAP = String.fromCodePoint(0x20e3);
const BLACK_FLAG = String.fromCodePoint(0x1f3f4);
const TAG_FIRST = String.fromCodePoint(0xe0020);
const TAG_LAST = String.fromCodePoint(0xe007f);
const THAI_AM = String.fromCodePoint(0x0e33);
const LAO_AM = String.fromCodePoint(0x0eb3);
/** The spacing tone marks the layout counts as 0 columns and tmux draws two (Hangul U+302E, U+302F; Vietnamese reading marks U+16FF0, U+16FF1). */
const WIDE_MARKS = `${String.fromCodePoint(0x302e)}${String.fromCodePoint(0x302f)}${String.fromCodePoint(0x16ff0)}${String.fromCodePoint(0x16ff1)}`;
/** The compatibility decompositions of the two AM vowels: NIKHAHIT + SARA AA, NIGGAHITA + LAO AA. */
const DECOMPOSED_AM: Readonly<Record<string, string>> = {
  [THAI_AM]: `${String.fromCodePoint(0x0e4d)}${String.fromCodePoint(0x0e32)}`,
  [LAO_AM]: `${String.fromCodePoint(0x0ecd)}${String.fromCodePoint(0x0eb2)}`,
};

/** An emoji the layout draws two columns wide (a recommended-for-general-interchange sequence, `string-width`'s own test). */
const RGI_EMOJI = new RegExp('^\\p{RGI_Emoji}$', 'v');
/** A keycap, with or without its presentation selector (`string-width` draws it two columns wide; tmux one or two: never more). */
const KEYCAP_SEQUENCE = new RegExp(`^[0-9#*]${VS16}?${KEYCAP}$`, 'u');
/** The emoji bases that are text by default (no emoji presentation) and that tmux draws two columns: the layout counts them one. */
const NARROW_BASE = '(?!\\p{Emoji_Presentation})\\p{Emoji_Modifier_Base}';
const NARROW_BASE_ONLY = new RegExp(`^${NARROW_BASE}$`, 'u');
/** What joins onto the character before it, or is dropped anyway: marks (the selectors and the keycap among them), tones, format and default-ignorable code points. */
const EXTENDER_CLASS = '[\\p{M}\\p{Emoji_Modifier}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Cs}]';
/**
 * What follows an emoji the layout draws wide only as a whole, and is dropped with it: the extenders, and a Thai or Lao AM (its decomposition's
 * mark would join onto the emoji: only its spacing vowel is kept, see {@link wideTail}).
 */
const WIDE_TAIL = `(?:${EXTENDER_CLASS}|${THAI_AM}|${LAO_AM})*`;
/** One member of an emoji zero-width-joiner sequence: a pictograph with its selectors and tones. */
const ELEMENT = `\\p{Extended_Pictographic}[${VS15}${VS16}\\p{Emoji_Modifier}]*`;
const TONES = /\p{Emoji_Modifier}/gu;

/**
 * The one forward pass of {@link dropScreenFillers} and {@link escapeScreenText}. At each position, in order: an emoji tag sequence (kept); an
 * emoji zero-width-joiner sequence and what follows it; a run of regional indicators and what follows it; one of the nine narrow emoji bases and
 * what follows it; an emoji with its presentation selector or a keycap and what follows it; a kept joiner or the text selector (kept); the Thai or
 * Lao AM (decomposed); else a code point of the dropped classes. Each alternative starts with its own class of code point and its repetitions are
 * separated by a fixed one (the joiner) or are a single class: linear.
 */
const SCREEN_PASS = new RegExp(
  [
    `(${BLACK_FLAG}[${TAG_FIRST}-${TAG_LAST}]+)`,
    `(${ELEMENT}(?:${ZWJ}${ELEMENT})+)(${WIDE_TAIL})`,
    `(\\p{Regional_Indicator}+)(${WIDE_TAIL})`,
    `(${NARROW_BASE})(${WIDE_TAIL})`,
    `((?!\\p{Emoji_Modifier})\\p{Emoji}(?:${VS16}${KEYCAP}?|${KEYCAP}))(${WIDE_TAIL})`,
    `(${ZWNJ}|${ZWJ}|${VS15})`,
    `(${THAI_AM}|${LAO_AM})`,
    `[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Emoji_Modifier}\\p{Cs}${WIDE_MARKS}]`,
  ].join('|'),
  'gu',
);

/** A run of combining marks and kept joiners at the start of a line: nothing of its own to sit on (a leading AM is a mark and a vowel by then). */
const ORPHAN_LEAD = new RegExp(`^(?:\\p{M}|${ZWNJ}|${ZWJ})+`, 'gmu');

/** The code points a terminal may draw wider than the layout counts, wherever they stand (see {@link isWidthRiskCodePoint}). */
const WIDTH_RISK = new RegExp(
  `[\\p{Emoji_Modifier}\\p{Regional_Indicator}\\p{Cs}${VS16}${THAI_AM}${LAO_AM}]|[${WIDE_MARKS}]`,
  'u',
);

/** One code point as the visible token a decision surface writes for it ({@link escapeScreenText}). */
function codePointToken(character: string): string {
  return `<U+${(character.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0')}>`;
}

/**
 * What follows an emoji the layout draws wide only as a whole (a flag, `❤️`, a keycap, `☝️`, a zero-width-joiner sequence): removed, except that
 * a Thai or Lao AM keeps its spacing vowel (its mark would join onto the emoji; drawn alone, the vowel is one column to both).
 */
function wideTail(tail: string): string {
  let out = '';
  for (const character of tail) out += DECOMPOSED_AM[character]?.slice(1) ?? '';
  return out;
}

/**
 * A run of regional indicators as the screen draws it: taken in pairs from its start, as a terminal pairs them; a pair that is a flag stays as it
 * is, and every other indicator is followed by a zero width non-joiner, so no two of them that are not a flag form one cluster, wherever the text
 * around them goes (a markdown layout that joins two runs included). Nothing follows a flag: a joiner after it would make it one column to the
 * layout and two on tmux (review round 3, R3S-2). Linear in the run.
 */
function regionalRun(run: string): string {
  const indicators = [...run];
  let out = '';
  for (let at = 0; at < indicators.length; at += 2) {
    const first = indicators[at] ?? '';
    const second = indicators[at + 1];
    if (second !== undefined && RGI_EMOJI.test(`${first}${second}`)) out += `${first}${second}`;
    else out += second === undefined ? `${first}${ZWNJ}` : `${first}${ZWNJ}${second}${ZWNJ}`;
  }
  return out;
}

/** One member of a zero-width-joiner sequence as the screen draws it: no tone; a narrow base with its presentation selector (and no other). */
function sequenceElement(element: string): string {
  const base = String.fromCodePoint(element.codePointAt(0) ?? 0);
  const rest = element.slice(base.length);
  if (NARROW_BASE_ONLY.test(base)) return `${base}${VS16}`;
  return `${base}${rest.replace(TONES, '')}`;
}

/**
 * An emoji zero-width-joiner sequence as the screen draws it: its members without tones; kept joined when the result is a recommended sequence
 * (the layout draws it two columns, as tmux does), else written as its members, each through the pass on its own (tmux draws a long chain as
 * more than one cluster: review round 3).
 */
function zwjSequence(sequence: string): string {
  const members = sequence.split(ZWJ).map((element) => sequenceElement(element));
  const joined = members.join(ZWJ);
  const plain = members.map((member) => member.replace(/<U\+[0-9A-F]+>/gu, ''));
  if (RGI_EMOJI.test(plain.join(ZWJ))) return joined;
  return members.map((member) => screenPass(member)).join('');
}

/**
 * What one emoji with its presentation selector or keycap becomes, with what follows it (`trailing`): kept, and what follows it removed, when the
 * layout draws it wide; else only its base is kept (the selector or keycap does not belong to it, and what follows it would join onto it).
 */
function presentedUnit(unit: string, trailing: string): string {
  if (RGI_EMOJI.test(unit) || KEYCAP_SEQUENCE.test(unit)) return `${unit}${wideTail(trailing)}`;
  const base = String.fromCodePoint(unit.codePointAt(0) ?? 0);
  return `${base}${wideTail(`${unit.slice(base.length)}${trailing}`)}`;
}

/** The pass's callback: the groups of {@link SCREEN_PASS} in order (see the pattern). */
function passMatch(match: string, groups: readonly (string | undefined)[]): string {
  const [
    tagSequence,
    sequence,
    sequenceTail,
    regional,
    regionalTail,
    narrow,
    narrowTail,
    presented,
    presentedTail,
    joiner,
    vowel,
  ] = groups;
  if (tagSequence !== undefined || joiner !== undefined) return match;
  if (sequence !== undefined) return `${zwjSequence(sequence)}${wideTail(sequenceTail ?? '')}`;
  if (regional !== undefined) return `${regionalRun(regional)}${wideTail(regionalTail ?? '')}`;
  if (narrow !== undefined) {
    const tail = narrowTail ?? '';
    return `${narrow}${VS16}${wideTail(tail)}`;
  }
  if (presented !== undefined) return presentedUnit(presented, presentedTail ?? '');
  if (vowel !== undefined) return DECOMPOSED_AM[vowel] ?? '';
  return '';
}

/**
 * The first pass: the code points dropped wherever they stand (default-ignorable and format code points, tones, lone surrogates, the wide tone
 * marks), except the joiners and the selectors and a subdivision flag's tags, which the second pass judges by what they stand next to. Dropped
 * FIRST, so that what was on either side of them is judged as it will be drawn: side by side (review round 3: a tone between a joiner and an emoji
 * hid a sequence from a single pass, which a second run then found).
 */
const DROP_PASS = new RegExp(
  [
    `(${BLACK_FLAG}[${TAG_FIRST}-${TAG_LAST}]+)`,
    // a run of joiners, whole (one match, whatever follows: linear), and the selectors after it, which select nothing and go
    `((?:${ZWNJ}|${ZWJ})+)(?:${VS15}|${VS16})*`,
    `(${ZWNJ}|${ZWJ}|${VS15}|${VS16})`,
    `[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Emoji_Modifier}\\p{Cs}${WIDE_MARKS}]`,
  ].join('|'),
  'gu',
);

function dropPass(text: string): string {
  return text.replace(
    DROP_PASS,
    (match: string, tagSequence: unknown, joiners: unknown, kept: unknown) => {
      if (typeof tagSequence === 'string' || typeof kept === 'string') return match;
      if (typeof joiners === 'string') return joiners;
      return '';
    },
  );
}

function onePass(text: string): string {
  return dropPass(text).replace(SCREEN_PASS, (match: string, ...rest: unknown[]) =>
    passMatch(
      match,
      rest.slice(0, 11).map((group) => (typeof group === 'string' ? group : undefined)),
    ),
  );
}

/** How many times the pass runs at most: a removal can bring two pieces side by side that a later pass judges again (a joiner and an emoji). */
const SETTLE_PASSES = 4;

/**
 * The pass, run again over its own output until it changes nothing (in practice once more; at most {@link SETTLE_PASSES} times): what one pass
 * removes can put two characters side by side that it judged apart (a selector between a joiner and an emoji, dropped late), and the screen must
 * draw what a second look would (so a row filtered again after its layout does not change). Each pass is linear.
 */
function screenPass(text: string): string {
  let out = onePass(text);
  for (let pass = 1; pass < SETTLE_PASSES; pass += 1) {
    const again = onePass(out);
    if (again === out) break;
    out = again;
  }
  return out;
}

/**
 * `text` with the dropped classes dropped and the rewritten ones rewritten (see the module header). Newlines and everything else kept; forward
 * passes, run until they change nothing. Idempotent.
 */
export function dropScreenFillers(text: string): string {
  return screenPass(text);
}

/** `text` with the combining marks and joiners that start a line (the text's, and each after a newline) dropped (after {@link dropScreenFillers}). */
export function dropOrphanMarks(text: string): string {
  return text.replace(ORPHAN_LEAD, '');
}

/**
 * Untrusted text made fit for the screen: the dropped classes dropped, the rewritten ones rewritten, then the orphan marks at the start of each
 * line. Run it BEFORE the text is laid out: a rewrite can change the width the layout measures (see the module header). Idempotent.
 */
export function screenText(text: string): string {
  return dropOrphanMarks(dropScreenFillers(text));
}

/**
 * A string written ONE-TO-ONE for a decision surface (the question card's option labels and headers, when two of a set would draw alike: review
 * rounds 3 and 4, R3S-4, R4-S-3): every code point a row draws as itself stays (a letter or a digit of any script, printable ASCII, a flag's pair
 * of regional indicators), and every other one is written as its `<U+XXXX>` token: a mark (an accent, a virama), a symbol or an emoji, a format
 * or default-ignorable code point, the Thai or Lao AM, a lone regional indicator, `<` itself, and whatever `alsoEscape` names (the card's own glyphs
 * and shapes). Code point by code point, with no pass over the text: nothing is dropped, rewritten or inserted, so two different strings never
 * write the same, and what is written draws as wide as the layout counts it (no mark joins a letter; no cluster forms but a flag).
 */
export function escapeScreenText(
  text: string,
  alsoEscape: (character: string) => boolean = () => false,
): string {
  const characters = [...text];
  let out = '';
  for (let at = 0; at < characters.length; at += 1) {
    const character = characters[at] ?? '';
    const next = characters[at + 1] ?? '';
    if (REGIONAL.test(character) && REGIONAL.test(next) && RGI_EMOJI.test(`${character}${next}`)) {
      out += `${character}${next}`;
      at += 1;
      continue;
    }
    out +=
      AS_ITSELF.test(character) && !alsoEscape(character) ? character : codePointToken(character);
  }
  return out;
}
const REGIONAL = /^\p{Regional_Indicator}$/u;
/** What a decision surface writes as itself (see {@link escapeScreenText}). */
const AS_ITSELF = new RegExp(
  `^(?![<${THAI_AM}${LAO_AM}]|\\p{Default_Ignorable_Code_Point})[\\p{L}\\p{N}\\x20-\\x7e]$`,
  'u',
);

/** A character after which an emoji the layout draws wide as a whole ends (a flag, a selector, a keycap, a pictograph): see {@link screenPieces}. */
const WIDE_UNIT_END = new RegExp(
  `(?:\\p{Regional_Indicator}\\p{Regional_Indicator}|${VS16}|${KEYCAP}|\\p{Extended_Pictographic})$`,
  'u',
);
const LEADING_EXTENDERS = new RegExp(`^${EXTENDER_CLASS}+`, 'u');

/**
 * The same filter over a laid-out row cut in styled pieces (the markdown layout's spans): {@link dropScreenFillers} on every piece, the orphan marks
 * dropped from the start of the ROW (the first pieces, across an empty one), and what a piece starts with that would join onto an emoji the previous
 * piece ends with dropped (the layout put the two pieces side by side: the source kept them apart). The pieces keep their order and their styles;
 * a piece the filter empties is kept, empty. Returns the very same array when nothing changed.
 */
export function screenPieces<Piece extends { readonly text: string }>(
  pieces: readonly Piece[],
): readonly Piece[] {
  let leading = true;
  let afterWideUnit = false;
  let changed = false;
  const out = pieces.map((piece) => {
    let text = dropScreenFillers(piece.text);
    if (leading) text = text.replace(ORPHAN_LEAD, '');
    else if (afterWideUnit) text = text.replace(LEADING_EXTENDERS, '');
    if (text !== '') {
      leading = false;
      afterWideUnit = WIDE_UNIT_END.test(text);
    }
    if (text === piece.text) return piece;
    changed = true;
    return { ...piece, text };
  });
  return changed ? out : pieces;
}

/**
 * Whether a code point is one a terminal may draw wider than the layout counts in SOME context: U+FE0F, a skin tone, a regional indicator, a
 * lone surrogate, the Thai or Lao AM, the wide tone marks. The approval card escapes every one of them as `<U+XXXX>` wherever it stands (a consent
 * surface shows what is approved and never drops it; it escapes the joiners and a surrogate already as invisible).
 */
export function isWidthRiskCodePoint(character: string): boolean {
  return WIDTH_RISK.test(character);
}

/**
 * One of the nine emoji bases that are text by default and that a terminal draws two columns wide while the layout counts one (`☝`, `⛹`, `✌`, `✍`,
 * `🏋`, `🏌`, `🕴`, `🕵`, `🖐`; review round 3, measured on tmux): a consent surface draws it WITH U+FE0F after it (the two count two columns to
 * both), a mark of how it is drawn and not a character of the text, so the glyph stays legible where an escape would not.
 */
export function isNarrowEmojiBase(character: string): boolean {
  return NARROW_BASE_ONLY.test(character);
}

/** What a stream holds back at most before it lets text through anyway (a run with no neutral character in it). */
const HOLD_LIMIT = 1024;
/**
 * A character whose presence does not change how the filter treats the text before it, and that the filter writes as it is whatever follows it
 * (a letter, a digit, a space, punctuation): everything but a regional indicator, a pictograph, a mark, a tone, a format, default-ignorable or
 * surrogate code point, and the Thai or Lao AM (it can follow an emoji as part of what is dropped after it). A keycap's base (a digit, `#`, `*`)
 * is let through, and carried into the next piece's filter as its context (a selector and a keycap after it make one emoji with it).
 */
const NOT_NEUTRAL = new RegExp(
  `[\\p{Regional_Indicator}\\p{Extended_Pictographic}\\p{M}\\p{Emoji_Modifier}\\p{Cf}\\p{Default_Ignorable_Code_Point}\\p{Cs}${THAI_AM}${LAO_AM}]`,
  'u',
);
/** The orphan marks after a newline inside a piece of a stream (its start is a line start only when the text before it ended a line). */
const ORPHAN_AFTER_NEWLINE = new RegExp(`\\n(?:\\p{M}|${ZWNJ}|${ZWJ})+`, 'gu');

/**
 * Where a stream may cut `text`: just after its last neutral character, or `-1`. Only `text` from `from` on is looked at (what the stream held
 * has no neutral character: it is what followed the last one), and never further than {@link HOLD_LIMIT} from its end.
 */
function settledEnd(text: string, from: number): number {
  const floor = Math.max(from, text.length - HOLD_LIMIT);
  for (let at = text.length - 1; at >= floor; at -= 1) {
    const unit = text.charCodeAt(at);
    if (unit >= 0xdc00 && unit <= 0xdfff) continue; // the low half of a pair: the character starts one unit earlier
    const end = unit >= 0xd800 && unit <= 0xdbff ? at + 2 : at + 1;
    if (!NOT_NEUTRAL.test(text.slice(at, end))) return end;
  }
  return -1;
}

/**
 * The filter over a stream that arrives in chunks (the live tail, review round 3, R3S-1): {@link ScreenStream.append} returns the filtered text that
 * is now settled and holds back the end the next chunk could still change (a regional indicator that could be half of a flag, an emoji a selector
 * or a joiner could follow, a mark): it lets the text through up to its last NEUTRAL character, so the decisions the filter makes about it never
 * depend on a later chunk and the output is the filter of the whole text, whatever the chunks. A line start is a line start of the whole text
 * (an orphan mark is dropped only there), and what a piece starts with that would join onto an emoji the previous piece ended with is dropped, as
 * the whole text's filter drops it. A run of more than {@link HOLD_LIMIT} code units with no neutral character is let through anyway, cut between
 * two code points (each side's filter is still width-safe; a decision at the cut may differ). Linear: the scan for the cut looks only at the new chunk (what is held has no neutral character), and what is held is never more than
 * {@link HOLD_LIMIT} code units.
 */
export class ScreenStream {
  private held = '';
  private atLineStart = true;
  private afterWideUnit = false;
  /** The keycap base (a digit, `#`, `*`) the last piece ended with: the next piece is filtered after it, and it is not written again. */
  private keycapBase = '';

  append(chunk: string): string {
    if (chunk === '') return '';
    const text = `${this.held}${chunk}`;
    let cut = settledEnd(text, this.held.length);
    if (cut < 0 && text.length > HOLD_LIMIT) {
      cut = text.length - 8;
      const unit = text.charCodeAt(cut);
      if (unit >= 0xdc00 && unit <= 0xdfff) cut -= 1;
    }
    if (cut <= 0) {
      this.held = text;
      return '';
    }
    this.held = text.slice(cut);
    return this.settle(text.slice(0, cut));
  }

  /** Forget what is held and where the text stands (a new turn's stream). */
  reset(): void {
    this.held = '';
    this.atLineStart = true;
    this.afterWideUnit = false;
    this.keycapBase = '';
  }

  private settle(piece: string): string {
    const context = this.keycapBase;
    this.keycapBase = /[0-9#*]$/u.test(piece) ? piece.slice(-1) : '';
    // the filter never removes a keycap's base (it keeps the base of whatever it judges): the output starts with the context, written already
    let out = dropScreenFillers(`${context}${piece}`).slice(context.length);
    if (this.atLineStart) out = out.replace(ORPHAN_LEAD, '');
    else {
      if (this.afterWideUnit) out = out.replace(LEADING_EXTENDERS, '');
      out = out.replace(ORPHAN_AFTER_NEWLINE, '\n');
    }
    if (out !== '') {
      this.atLineStart = out.endsWith('\n');
      this.afterWideUnit = WIDE_UNIT_END.test(out);
    }
    return out;
  }
}
