/**
 * Code points that draw nothing, so text can hide behind them: the format characters (zero-width, bidi marks, joiners, the soft
 * hyphen) and every other default-ignorable one (variation selectors, the combining grapheme joiner, the Hangul fillers, the
 * Mongolian free variation selectors, the tag characters). An emoji variation selector goes with them, so an emoji in a folded text
 * may draw in its text form: the callers accept that.
 *
 * ONE definition for the two readers that fold text before they look at it: the run card (an author's text must not hide a chord) and the
 * provider-key shape (a pasted key must not hide a prefix). It carries the `g` flag, for `String.prototype.replace`; a caller that wants a
 * test builds its own non-global pattern from `.source`.
 */
export const INVISIBLE_CHARS = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu;
