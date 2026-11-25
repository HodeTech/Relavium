import ts from 'typescript';

/**
 * What a **hint-shaped literal** is, and how to find every one in a source text
 * ([ADR-0145](../../../../../../docs/decisions/0145-the-cli-has-one-surface-language.md) §3, "golden first").
 *
 * The completeness guard (`legend-completeness.test.ts`) reads every string the production source writes out, from the syntax tree
 * (so a comment never counts), and asks {@link isHintShaped} of each. The shape is **deliberately wide**: a string that merely
 * mentions a key is caught, because a producer the golden missed is worse than a false alarm that costs one reasoned line in the
 * allow-list. A string is hint-shaped when it holds, as a whole word:
 *
 * 1. a **strong key token**: `Esc`, `Ctrl+X`, `Ctrl-X`, `Alt+X`, `Shift+Tab`, `PgUp`, `PgDn`, `Home/End`, an arrow group
 *    (`↑/↓`, `↑↓`, `←/→`, `←→`); or
 * 2. a **bracketed key and a word after it**: `[Ctrl+Y] Allow`, `[d] withdraw`, `[v] full diff`, `[PgUp/PgDn] page`; or
 * 3. a **weak key token**: `Enter`, `Tab`, `Space`, `Backspace`, anywhere, except `Enter` as the imperative verb that starts a
 *    sentence (`Enter a different key`, `Enter 0 to record it as free`); or
 * 4. **`press` and a single lower-case letter**: `press d again`, `Press y to continue`; or
 * 5. **`any key`** / **`any other key`**: `Any other key cancels`.
 *
 * A literal that is **only** a key expression (`'Esc'`, `'Ctrl+C'`, `'[Enter]'`, `'Esc / Ctrl+C'`) is not hint-shaped: it is the
 * `keys` field of a legend item, which the builder already carries.
 */

/** Keys whose name alone makes a string a hint. */
const STRONG = [
  String.raw`Esc(?![A-Za-z])`,
  String.raw`Ctrl[+-][A-Za-z](?![A-Za-z])`,
  String.raw`Alt\+[A-Za-z](?![A-Za-z])`,
  String.raw`Shift\+Tab`,
  String.raw`PgUp`,
  String.raw`PgDn`,
  String.raw`Home/End`,
  '↑/↓',
  '↑↓',
  '←/→',
  '←→',
];
/** Keys that are also ordinary words, so a context is needed (see {@link IMPERATIVE_ENTER}). */
const WEAK = [
  String.raw`Enter(?![A-Za-z])`,
  String.raw`Tab(?![A-Za-z])`,
  String.raw`Space(?![A-Za-z])`,
  String.raw`Backspace`,
];

const BEFORE = String.raw`(?<![A-Za-z0-9_+-])`;
const STRONG_KEY = new RegExp(`${BEFORE}(?:${STRONG.join('|')})`, 'u');
const WEAK_KEY = new RegExp(`${BEFORE}(?:${WEAK.join('|')})`, 'u');
/** `[Ctrl+Y] Allow`, `[v] full diff`, `[Enter] withdraw`: a bracketed key with words after it. */
const BRACKET_KEY =
  /\[(?:Ctrl\+[A-Za-z]|Alt\+[A-Za-z]|Esc|Enter|Tab|Space|PgUp\/PgDn|Home\/End|Tab\/Shift\+Tab|↑↓|↑\/↓|[a-z])(?: \/ [A-Za-z]+)?\]\s+[A-Za-z]/u;
/** `press d`, `Press y`: a letter key named in a sentence. */
const PRESS_LETTER = /\b[Pp]ress [a-z](?![A-Za-z])/u;
/** `any key`, `any other key`: a sentence that says which keys do what. */
const ANY_KEY = /\b[Aa]ny (?:other )?key\b/u;
/** The verb `Enter`, at the start of a sentence: `Enter a different key`, `Enter 0 to record it as free.` */
const IMPERATIVE_ENTER = /(?:^|[.!?]\s+)Enter (?:a|an|the|your|value|it|0|one|some|text)\b/u;
/** A whole literal that is one key expression, as a legend item's `keys` field is: `Esc`, `Ctrl+C`, `Alt+B/Alt+F`, `[Enter]`, `Esc / Ctrl+C`. */
const KEY_EXPRESSION =
  /^\[?(?:(?:Esc|Enter|Tab|Space|Backspace|Ctrl[+-][A-Za-z]|Alt\+[A-Za-z]|Shift\+Tab|PgUp|PgDn|Home|End|↑|↓|←|→|↑|↓)(?:(?: \/ |\/|\+| |, )(?:Esc|Enter|Tab|Space|Ctrl[+-][A-Za-z]|Alt\+[A-Za-z]|Shift\+Tab|PgUp|PgDn|Home|End|↑|↓|←|→|↑|↓|[a-z]))*)\]?$/u;

/** Whether a string, as the source writes it, is a key legend, a hint, or a sentence that names a key. */
export function isHintShaped(text: string): boolean {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (normalized.length === 0) return false;
  if (KEY_EXPRESSION.test(normalized)) return false;
  if (STRONG_KEY.test(normalized)) return true;
  if (BRACKET_KEY.test(normalized)) return true;
  if (PRESS_LETTER.test(normalized) || ANY_KEY.test(normalized)) return true;
  if (WEAK_KEY.test(normalized)) return !isOnlyImperativeEnter(normalized);
  return false;
}

/** `Enter` appears only as the imperative verb (no other weak key, no strong key, no bracket key). */
function isOnlyImperativeEnter(text: string): boolean {
  const withoutVerb = text.replace(new RegExp(IMPERATIVE_ENTER.source, 'gu'), ' ');
  return !WEAK_KEY.test(withoutVerb);
}

/** One hint-shaped literal of a source file. */
export interface HintLiteral {
  /** 1-based line of the literal's first character. */
  readonly line: number;
  /** The literal's text with an interpolation written as `${…}`, white space collapsed. */
  readonly text: string;
}

/**
 * Every hint-shaped string of `source`, in source order. String literals, template literals (an interpolation is written `${…}`,
 * so `↑/↓ select · ${verb} · Esc cancel` is one string) and the text of JSX are read; a type position (`'close'` in a union), an
 * import specifier and a property name are not strings the program shows, and a comment is not a node at all.
 */
export function hintLiterals(source: string, fileName: string): readonly HintLiteral[] {
  const kind = fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const found: HintLiteral[] = [];
  const add = (node: ts.Node, text: string): void => {
    const collapsed = text.replace(/\s+/gu, ' ').trim();
    if (!isHintShaped(collapsed)) return;
    const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
    found.push({ line: line + 1, text: collapsed });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isLiteralTypeNode(node))
      return;
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name)) {
      visit(node.initializer);
      return;
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      add(node, node.text);
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const joined = node.templateSpans.reduce(
        (text, span) => `${text}\${…}${span.literal.text}`,
        node.head.text,
      );
      add(node, joined);
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (ts.isJsxText(node)) {
      add(node, node.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}
