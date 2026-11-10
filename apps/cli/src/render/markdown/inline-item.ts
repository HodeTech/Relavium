import { sanitizeInline } from '../sanitize.js';
import type { InlineSourceIndex } from './inline-index.js';
import { isAutolinkTarget } from './opaque-targets.js';
import type { MarkdownSpan } from './types.js';

export type InlineItemStyle = Omit<MarkdownSpan, 'text'>;
export interface InlineItemEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly raw?: boolean;
}
export type InlineItemPart<T> =
  | {
      readonly kind: 'raw';
      readonly start: number;
      readonly end: number;
      readonly style?: InlineItemStyle;
      readonly flatten?: boolean;
    }
  | { readonly kind: 'text'; readonly text: string; readonly style?: InlineItemStyle }
  | { readonly kind: 'child'; readonly value: T };
export interface InlineItem<T> {
  readonly end: number;
  readonly plain: boolean;
  readonly trimPlain: 0 | 1 | 2;
  readonly parts: readonly InlineItemPart<T>[];
  readonly edits: readonly InlineItemEdit[];
}
export type InlineChild<T> = (
  start: number,
  end: number,
  depth: number,
  style: InlineItemStyle,
  flatten: boolean,
) => { readonly text: string; readonly value: T };

/** One canonical decision over an indexed UTF-16 range. All raw parts are source ranges. */
export function interpretInlineItem<T>(
  index: InlineSourceIndex,
  start: number,
  end: number,
  depth: number,
  plainSuffix: string,
  child: InlineChild<T>,
): InlineItem<T> {
  const char = (at: number): string => (at < end ? index.charAt(at) : '');
  const starts = (token: string, at: number): boolean =>
    at + token.length <= end && index.startsWith(token, at);
  const next = (token: string, at: number): number => index.next(token, at, end);
  const raw = (
    from: number,
    to: number,
    style?: InlineItemStyle,
    flatten = false,
  ): InlineItemPart<T> => ({
    kind: 'raw',
    start: from,
    end: to,
    ...(style ? { style } : {}),
    ...(flatten ? { flatten } : {}),
  });
  const text = (value: string, style?: InlineItemStyle): InlineItemPart<T> => ({
    kind: 'text',
    text: value,
    ...(style ? { style } : {}),
  });
  const item = (
    finish: number,
    plain: boolean,
    parts: readonly InlineItemPart<T>[],
    edits: readonly InlineItemEdit[] = [],
    trimPlain: 0 | 1 | 2 = 0,
  ): InlineItem<T> => ({ end: finish, plain, trimPlain, parts, edits });
  const ch = char(start);
  // A code span may end inside a recognized link or autolink. Once parsing
  // resumes there, its remaining syntax initiators belong to the opaque
  // source construct and must stay literal. The construct opener itself is
  // still interpreted normally, including recursively parsed link labels.
  // Backticks retain their existing code precedence: their branch preserves
  // opaque delimiter bytes while consuming the literal code body.
  if ('\\\n[!<*_~'.includes(ch) && index.opaqueInterior(start))
    return item(start + 1, true, [raw(start, start + 1)]);
  if (ch === '\\' && /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/.test(char(start + 1)))
    return item(
      start + 2,
      true,
      [raw(start + 1, start + 2)],
      [{ start, end: start + 1, text: '' }],
    );
  if (ch === '\n') {
    const trim: 0 | 1 | 2 = plainSuffix.endsWith('  ')
      ? 2
      : plainSuffix.endsWith('\\') && char(start - 1) === '\\' && !index.escaped(start - 1)
        ? 1
        : 0;
    return item(
      start + 1,
      true,
      [text(trim ? '\n' : ' ')],
      trim
        ? [{ start: start - trim, end: start, text: '' }]
        : [{ start, end: start + 1, text: ' ' }],
      trim,
    );
  }
  if (ch === '`') {
    const runEnd = index.runEnd(start, '`', end);
    const close = index.tickClose(start, end);
    if (close >= 0) {
      const parts: InlineItemPart<T>[] = [];
      const edits: InlineItemEdit[] = [];
      if (index.opaqueCode(start)) {
        parts.push(raw(start, runEnd));
        edits.push({ start, end: runEnd, text: '', raw: true });
      } else edits.push({ start, end: runEnd, text: '' });
      parts.push(raw(runEnd, close, { code: true }));
      edits.push({ start: runEnd, end: close, text: '', raw: true });
      if (index.opaqueCode(close)) {
        parts.push(raw(close, close + runEnd - start));
        edits.push({ start: close, end: close + runEnd - start, text: '', raw: true });
      } else edits.push({ start: close, end: close + runEnd - start, text: '' });
      return item(close + runEnd - start, false, parts, edits);
    }
    return item(runEnd, true, [raw(start, runEnd)]);
  }
  if ((ch === '[' || (ch === '!' && char(start + 1) === '[')) && depth < 32) {
    const image = ch === '!';
    const labelStart = start + (image ? 2 : 1);
    const close = next('](', labelStart);
    const finish = close < 0 ? -1 : index.parenClose(close + 1, end);
    const nested = next('[', labelStart);
    if (close >= 0 && finish >= 0 && (nested < 0 || nested > close)) {
      if (index.validLinkTarget(close + 2, finish)) {
        const label = index.slice(labelStart, close);
        if (label.includes('\n'))
          return item(
            finish + 1,
            true,
            [raw(start, finish + 1)],
            [{ start, end: finish + 1, text: '', raw: true }],
          );
        const target = index.slice(close + 2, finish);
        const safeTarget = sanitizeInline(target);
        if (image)
          return item(
            finish + 1,
            false,
            [
              text('[image: ', { dim: true, linkURL: safeTarget }),
              raw(labelStart, close, { dim: true, linkURL: safeTarget }, true),
              text('] (', { dim: true, linkURL: safeTarget }),
              raw(close + 2, finish, { dim: true, linkURL: safeTarget }),
              text(')', { dim: true, linkURL: safeTarget }),
            ],
            [
              { start, end: labelStart, text: '[image: ' },
              { start: labelStart, end: close, text: '', raw: true },
              { start: close, end: close + 2, text: '] (' },
              { start: close + 2, end: finish, text: '', raw: true },
            ],
          );
        const labelResult = child(labelStart, close, depth + 1, { linkURL: safeTarget }, true);
        const duplicate = labelResult.text === safeTarget;
        const parts: InlineItemPart<T>[] = [{ kind: 'child', value: labelResult.value }];
        const edits: InlineItemEdit[] = [{ start, end: labelStart, text: '' }];
        if (duplicate) edits.push({ start: close, end: finish + 1, text: '' });
        else {
          parts.push(
            text(' (', { linkURL: safeTarget }),
            raw(close + 2, finish, { linkURL: safeTarget }),
            text(')', { linkURL: safeTarget }),
          );
          edits.push(
            { start: close, end: close + 2, text: ' (' },
            { start: close + 2, end: finish, text: '', raw: true },
          );
        }
        return item(finish + 1, false, parts, edits);
      }
      return item(
        finish + 1,
        true,
        [raw(start, finish + 1)],
        [{ start, end: finish + 1, text: '', raw: true }],
      );
    }
    const labelEnd = next('][', labelStart);
    const referenceEnd = labelEnd < 0 ? -1 : next(']', labelEnd + 2);
    if (labelEnd >= 0 && referenceEnd >= 0 && (nested < 0 || nested > labelEnd))
      return item(
        referenceEnd + 1,
        true,
        [raw(start, referenceEnd + 1)],
        [{ start, end: referenceEnd + 1, text: '', raw: true }],
      );
    // A complete bare bracket group is an ambiguous shortcut-reference
    // candidate. Reference resolution is unsupported, so retain it literally
    // unless a following '(' or '[' may still complete another link form.
    const bareEnd =
      (close >= 0 && finish < 0) || !index.hasInlineSyntax(labelStart, end)
        ? -1
        : next(']', labelStart);
    if (bareEnd >= 0 && (nested < 0 || nested > bareEnd)) {
      const following = char(bareEnd + 1);
      if (following !== '(' && following !== '[')
        return item(
          bareEnd + 1,
          true,
          [raw(start, bareEnd + 1)],
          [{ start, end: bareEnd + 1, text: '', raw: true }],
        );
    }
  }
  if (ch === '<') {
    const close = next('>', start + 1);
    const nested = next('<', start + 1);
    const target =
      close < 0 || (nested >= 0 && nested < close) ? '' : index.slice(start + 1, close);
    if (isAutolinkTarget(target))
      return item(
        close + 1,
        false,
        [raw(start + 1, close, { linkURL: target })],
        [
          { start, end: start + 1, text: '' },
          { start: start + 1, end: close, text: '', raw: true },
          { start: close, end: close + 1, text: '' },
        ],
      );
  }
  if (depth < 31 && !index.intraword(start) && (starts('***', start) || starts('___', start))) {
    const marker = index.slice(start, start + 3);
    const close = next(marker, start + 3);
    if (close > start + 3) {
      const nested = child(start + 3, close, depth + 2, { strong: true, emphasis: true }, false);
      return item(
        close + 3,
        false,
        [{ kind: 'child', value: nested.value }],
        [
          { start, end: start + 3, text: '' },
          { start: close, end: close + 3, text: '' },
        ],
      );
    }
  }
  const marker =
    starts('**', start) || starts('__', start) || starts('~~', start)
      ? index.slice(start, start + 2)
      : ch === '*' || ch === '_'
        ? ch
        : '';
  if (marker && marker.includes('_') && index.intraword(start))
    return item(start + marker.length, true, [raw(start, start + marker.length)]);
  if (marker && depth < 32) {
    let close = next(marker, start + marker.length);
    if ((marker === '*' || marker === '_') && close >= 0 && starts(marker + marker, close)) {
      const strongEnd = next(marker + marker, close + 2);
      if (strongEnd >= 0)
        close = char(strongEnd + 2) === marker ? strongEnd + 2 : next(marker, strongEnd + 2);
    } else if (
      (marker === '**' || marker === '__') &&
      close >= 0 &&
      char(close + 2) === marker[0] &&
      index.singleCount(marker[0] ?? '', start + marker.length, close) % 2 === 1
    )
      close++;
    if (close > start + marker.length) {
      const flags: InlineItemStyle =
        marker === '~~'
          ? { strike: true }
          : marker.length === 2
            ? { strong: true }
            : { emphasis: true };
      const nested = child(start + marker.length, close, depth + 1, flags, false);
      return item(
        close + marker.length,
        false,
        [{ kind: 'child', value: nested.value }],
        [
          { start, end: start + marker.length, text: '' },
          { start: close, end: close + marker.length, text: '' },
        ],
      );
    }
  }
  const finish = Math.max(start + 1, index.plainEnd(start, end));
  return item(finish, true, [raw(start, finish)]);
}
