import type { SyntaxToken } from '../types.js';
import {
  BACKSLASH,
  escapeEnd,
  isAsciiLetter,
  isBlank,
  isDigit,
  isIdentPart,
  isIdentStart,
  isLowerAscii,
  isSpace,
  isUpperAscii,
  words,
} from './chars.js';
import {
  colonFollows,
  commentEnd,
  scanNumber,
  scanQuoted,
  scanWord,
  type StringRule,
} from './lexemes.js';
import type { Scanner, Segments } from './segments.js';

/** What a family of C-like languages shares; everything else is data. */
export interface Profile {
  readonly lineComments: readonly string[];
  readonly blockComments: readonly (readonly [string, string])[];
  readonly strings: readonly StringRule[];
  readonly keywords: ReadonlySet<string>;
  readonly constants: ReadonlySet<string>;
  readonly types: ReadonlySet<string>;
  /** Keywords are matched case-insensitively (SQL). */
  readonly foldCase?: boolean;
  /** A capitalised word is a type (`Promise`, `String`), unless it is a member after a dot. */
  readonly capitalTypes?: boolean;
  /** `@name` is an annotation. */
  readonly decorators?: boolean;
  /** A `#` at the start of a line begins a preprocessor directive. */
  readonly preprocessor?: boolean;
  /** A string followed by a colon is a property name (JSON). */
  readonly jsonKeys?: boolean;
  /** Lifetimes, char literals, raw strings, macros and `#[attributes]`. */
  readonly rust?: boolean;
  /** Letters that may sit directly before a quote and belong to the string (`f"…"`, `rb'…'`). */
  readonly stringPrefixes?: ReadonlySet<string>;
  /** `/…/` is a regular-expression literal where an operand may start (JavaScript, TypeScript). */
  readonly regexLiterals?: boolean;
  /** A `'` between two digits is a digit separator (`1'000'000`). */
  readonly numberQuotes?: boolean;
  /** A capitalised name followed by `(` is a method, unless `new` precedes it (C#). */
  readonly pascalCalls?: boolean;
}

/** A template literal's holes are tracked up to this nesting; deeper ones stay plain string. */
const MAX_HOLES = 32;
/** A Rust raw string `r##"…"##` is read up to this many hashes. */
const MAX_RAW_HASHES = 16;
const OPEN_BRACE = 123;
const CLOSE_BRACE = 125;
const DOT = 46;
const SLASH = 47;
const OPEN_PAREN = 40;
const CLOSE_PAREN = 41;
const BACKTICK = 96;
const DOLLAR = 36;
const QUOTE = 39;
const DOUBLE_QUOTE = 34;

/** After one of these an operand may start, so a `/` there opens a regular expression and is not a division. */
const REGEX_AFTER: ReadonlySet<number> = new Set(
  '(,=:[!&|?{;~+-*%^'.split('').map((char) => char.charCodeAt(0)),
);
const REGEX_KEYWORDS = words(
  'return typeof instanceof in of delete void throw new case do else yield await',
);

class GenericScan {
  private i = 0;
  private lineStart = true;
  /** The last significant character: it decides whether a `/` opens a regular expression. */
  private previous = 0;
  private depth = 0;
  private readonly holes: number[] = [];
  /** The next token directly follows a member-access dot, so a keyword there is a name. */
  private memberNext = false;
  /** The last token was a keyword after which an operand starts (`return /x/`). */
  private operandNext = false;
  /** The last identifier, for `new Foo(`. */
  private lastWord = '';
  /** A `/` before this index is not tried as a regular expression: an attempt on its line already failed. */
  private regexOffUntil = -1;
  private readonly source: string;
  private readonly out: Segments;
  private readonly profile: Profile;
  private readonly hasTemplate: boolean;

  constructor(source: string, out: Segments, profile: Profile) {
    this.source = source;
    this.out = out;
    this.profile = profile;
    this.hasTemplate = profile.strings.some((rule) => rule.interpolation === true);
  }

  run(): void {
    const length = this.source.length;
    while (this.i < length) {
      this.out.tick();
      const code = this.source.charCodeAt(this.i);
      if (isSpace(code)) {
        if (code === 10) this.lineStart = true;
        this.i += 1;
        continue;
      }
      this.step(code);
      this.lineStart = false;
    }
  }

  private step(code: number): void {
    const member = this.memberNext;
    const operand = this.operandNext;
    const before = this.lastWord;
    this.memberNext = false;
    this.operandNext = false;
    this.lastWord = '';
    if (this.comment() || this.regex(code, operand) || this.stringAt(this.i, this.i)) return;
    if (isDigit(code) || (code === DOT && this.startsLeadingDot())) {
      this.number();
      return;
    }
    if (this.special(code)) return;
    if (isIdentStart(code)) this.word(member, before);
    else this.punctuation(code);
  }

  /** `.5` is a number; `0..5`, `t.0`, `f().0` and a spread's dots are not. */
  private startsLeadingDot(): boolean {
    const { source } = this;
    if (!isDigit(source.charCodeAt(this.i + 1))) return false;
    const before = source.charCodeAt(this.i - 1);
    return !(isIdentPart(before) || before === CLOSE_PAREN || before === 93 || before === DOT);
  }

  /** The few characters whose meaning depends on the language: `@`, `#` and, in Rust, `'`. */
  private special(code: number): boolean {
    const { profile } = this;
    if (code === 64) return profile.decorators === true && this.decorator();
    if (code === 35) {
      if (this.lineStart && profile.preprocessor === true) {
        this.directive();
        return true;
      }
      return profile.rust === true && this.attribute();
    }
    return code === QUOTE && profile.rust === true && this.rustQuote();
  }

  private comment(): boolean {
    const { profile, source } = this;
    for (const open of profile.lineComments) {
      if (source.startsWith(open, this.i)) return this.markComment(open, undefined);
    }
    for (const [open, close] of profile.blockComments) {
      if (source.startsWith(open, this.i)) return this.markComment(open, close);
    }
    return false;
  }

  private markComment(open: string, close: string | undefined): boolean {
    const end = commentEnd(this.out, this.source, this.i, open, close);
    this.out.mark(this.i, end, 'comment');
    this.i = end;
    this.previous = 0;
    return true;
  }

  /** `/re/flags` where an operand may start. One failed attempt turns the attempts off to the end of its line. */
  private regex(code: number, operand: boolean): boolean {
    if (this.profile.regexLiterals !== true || code !== SLASH || this.i < this.regexOffUntil)
      return false;
    if (!(operand || this.previous === 0 || REGEX_AFTER.has(this.previous))) return false;
    const end = this.regexEnd();
    if (end < 0) {
      this.regexOffUntil = this.out.lineEnd(this.i);
      return false;
    }
    this.out.mark(this.i, end, 'string');
    this.i = end;
    this.previous = CLOSE_PAREN; // what follows a regular expression is an operator
    return true;
  }

  /** The end of the regular expression that starts at the `/` at `i`, or -1 when its line has no closing `/`. */
  private regexEnd(): number {
    const { source } = this;
    let at = this.i + 1;
    let inClass = false;
    let found = -1;
    while (at < source.length && found < 0) {
      const code = source.charCodeAt(at);
      if (code === 10) break;
      if (code === BACKSLASH) at = escapeEnd(source, at);
      else {
        if (code === 91) inClass = true;
        else if (code === 93) inClass = false;
        else if (code === SLASH && !inClass) found = at + 1;
        at += 1;
      }
    }
    this.out.charge(at - this.i);
    if (found < 0) return -1;
    let end = found;
    while (isAsciiLetter(source.charCodeAt(end))) end += 1;
    return end;
  }

  /** A string literal that opens at `at`; `from` is where its first character (a prefix, if any) starts. */
  private stringAt(at: number, from: number): boolean {
    for (const rule of this.profile.strings) {
      if (!this.source.startsWith(rule.open, at)) continue;
      if (rule.interpolation === true) this.templateFrom(from, at + rule.open.length);
      else {
        const end = scanQuoted(this.source, at, rule);
        const key = this.profile.jsonKeys === true && colonFollows(this.out, this.source, end);
        this.out.mark(from, end, rule.token ?? (key ? 'property' : 'string'));
        this.i = end;
        this.previous = this.source.charCodeAt(end - 1);
      }
      return true;
    }
    return false;
  }

  /** Scan a template literal's text from `scanFrom`, up to its end or the next `${`. */
  private templateFrom(tokenStart: number, scanFrom: number): void {
    const { source } = this;
    let at = scanFrom;
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === BACKSLASH) at = escapeEnd(source, at);
      else if (code === BACKTICK) {
        this.finishString(tokenStart, at + 1);
        return;
      } else if (
        code === DOLLAR &&
        source.charCodeAt(at + 1) === OPEN_BRACE &&
        this.holes.length < MAX_HOLES
      ) {
        this.out.mark(tokenStart, at, 'string');
        this.depth += 1;
        this.holes.push(this.depth);
        this.i = at + 2;
        this.previous = OPEN_BRACE;
        return;
      } else at += 1;
    }
    this.finishString(tokenStart, source.length);
  }

  private finishString(tokenStart: number, end: number): void {
    this.out.mark(tokenStart, end, 'string');
    this.i = end;
    this.previous = BACKTICK;
  }

  private number(): void {
    const end = scanNumber(this.source, this.i, this.profile.numberQuotes === true);
    this.out.mark(this.i, end, 'number');
    this.i = end;
    this.previous = this.source.charCodeAt(end - 1);
  }

  /** `@name` or `@a.b.c`: an annotation. A lone `@` is an operator. */
  private decorator(): boolean {
    if (!isIdentStart(this.source.charCodeAt(this.i + 1))) return false;
    let end = this.i + 1;
    for (;;) {
      end = scanWord(this.source, end);
      if (this.source.charCodeAt(end) === DOT && isIdentStart(this.source.charCodeAt(end + 1)))
        end += 1;
      else break;
    }
    this.out.mark(this.i, end, 'meta');
    this.i = end;
    this.previous = 0;
    return true;
  }

  /** `#include <x.h>`, `#define`: the directive is meta, and an angle-bracket path is a string. It always consumes at least the `#`. */
  private directive(): void {
    const { source } = this;
    let at = this.i + 1;
    while (isBlank(source.charCodeAt(at))) at += 1;
    const end = scanWord(source, at);
    this.out.mark(this.i, end, 'meta');
    const name = source.slice(at, end);
    this.i = end;
    this.previous = 0;
    if (name !== 'include' && name !== 'import') return;
    let path = end;
    while (isBlank(source.charCodeAt(path))) path += 1;
    if (source.charCodeAt(path) !== 60) return;
    const close = this.out.find('>', path);
    if (close < 0 || close > this.out.lineEnd(path)) return;
    this.out.mark(path, close + 1, 'string');
    this.i = close + 1;
  }

  /** Rust `#[derive(Debug)]` and `#![allow(x)]`: meta up to the closing bracket, or the end of the line. */
  private attribute(): boolean {
    const { source } = this;
    const bracket = source.charCodeAt(this.i + 1) === 33 ? this.i + 2 : this.i + 1;
    if (source.charCodeAt(bracket) !== 91) return false;
    const close = this.out.find(']', bracket);
    const limit = this.out.lineEnd(bracket);
    const end = close >= 0 && close < limit ? close + 1 : limit;
    this.out.mark(this.i, end, 'meta');
    this.i = end;
    this.previous = 0;
    return true;
  }

  /** In Rust a `'` opens a char literal (`'a'`, `'\n'`, `'\''`) or a lifetime (`'a`), never a string. */
  private rustQuote(): boolean {
    const { source } = this;
    const next = source.charCodeAt(this.i + 1);
    let end = -1;
    if (next === BACKSLASH) end = this.escapedCharEnd();
    else if (source.charCodeAt(this.i + 2) === QUOTE) end = this.i + 3;
    else if (next >= 0xd800 && next <= 0xdbff && source.charCodeAt(this.i + 3) === QUOTE)
      end = this.i + 4;
    if (end >= 0) {
      this.out.mark(this.i, end, 'string');
      this.i = end;
      this.previous = QUOTE;
      return true;
    }
    if (!isIdentStart(next)) return false;
    const word = scanWord(source, this.i + 1);
    this.out.mark(this.i, word, 'type');
    this.i = word;
    this.previous = 0;
    return true;
  }

  /** The end of an escaped char literal (`'\n'`, `'\''`, `'\u{1F600}'`): its closing quote is at least three on. */
  private escapedCharEnd(): number {
    const limit = Math.min(this.source.length, this.i + 12);
    for (let at = this.i + 3; at < limit; at++) {
      const code = this.source.charCodeAt(at);
      if (code === 10) return -1;
      if (code === QUOTE) return at + 1;
    }
    return -1;
  }

  /** Rust `r"…"`, `r#"…"#`, `br##"…"##`: no escapes, closed by a quote and as many hashes as opened it. */
  private rawString(afterWord: number): boolean {
    const { source } = this;
    let hashes = 0;
    let at = afterWord;
    while (source.charCodeAt(at) === 35 && hashes < MAX_RAW_HASHES) {
      hashes += 1;
      at += 1;
    }
    if (source.charCodeAt(at) !== DOUBLE_QUOTE) return false;
    const closing = `"${'#'.repeat(hashes)}`;
    const close = this.out.find(closing, at + 1);
    const end = close < 0 ? source.length : close + closing.length;
    this.out.mark(this.i, end, 'string');
    this.i = end;
    this.previous = DOUBLE_QUOTE;
    return true;
  }

  private word(member: boolean, before: string): void {
    const { source, profile } = this;
    const end = scanWord(source, this.i);
    const word = source.slice(this.i, end);
    if (profile.rust === true && (word === 'r' || word === 'br') && this.rawString(end)) return;
    const quote = source.charCodeAt(end);
    const prefixed =
      profile.stringPrefixes?.has(word.toLowerCase()) === true &&
      (quote === DOUBLE_QUOTE || quote === QUOTE);
    if (prefixed && this.stringAt(end, this.i)) return;
    const token = this.classify(word, end, member, before);
    if (token !== 'text') this.out.mark(this.i, end, token);
    this.i = end;
    this.previous = source.charCodeAt(end - 1);
    this.lastWord = word;
    this.operandNext = token === 'keyword' && REGEX_KEYWORDS.has(word);
  }

  private classify(word: string, end: number, member: boolean, before: string): SyntaxToken {
    const { profile } = this;
    const call = this.source.charCodeAt(end) === OPEN_PAREN || this.isMacroCall(end);
    if (member) return call ? 'function' : 'text';
    const key = profile.foldCase === true ? word.toLowerCase() : word;
    if (profile.keywords.has(key)) return 'keyword';
    if (profile.constants.has(key)) return 'constant';
    if (profile.types.has(key)) return 'type';
    if (profile.capitalTypes === true && isCapitalised(word)) {
      return profile.pascalCalls === true && call && before !== 'new' ? 'function' : 'type';
    }
    return call ? 'function' : 'text';
  }

  /** Rust `println!(…)`, `vec![…]`: a word, a `!`, then an opening bracket. */
  private isMacroCall(end: number): boolean {
    if (this.profile.rust !== true || this.source.charCodeAt(end) !== 33) return false;
    const open = this.source.charCodeAt(end + 1);
    return open === OPEN_PAREN || open === 91 || open === OPEN_BRACE;
  }

  private punctuation(code: number): void {
    if (code === OPEN_BRACE) this.depth += 1;
    else if (code === CLOSE_BRACE) {
      if (this.hasTemplate && this.holes.at(-1) === this.depth) {
        this.holes.pop();
        this.depth -= 1;
        this.templateFrom(this.i + 1, this.i + 1);
        return;
      }
      this.depth = Math.max(0, this.depth - 1);
    } else if (code === DOT) {
      // A dot that is followed at once by a name, and is not one of a run of dots, is member access.
      this.memberNext =
        isIdentStart(this.source.charCodeAt(this.i + 1)) &&
        this.source.charCodeAt(this.i - 1) !== DOT;
    }
    this.previous = code;
    this.i += 1;
  }
}

/** `Promise`, `HttpClient`: an uppercase first letter and at least one lowercase letter. */
function isCapitalised(word: string): boolean {
  if (!isUpperAscii(word.charCodeAt(0))) return false;
  for (let index = 1; index < word.length; index++) {
    if (isLowerAscii(word.charCodeAt(index))) return true;
  }
  return false;
}

/** A scanner for one C-like profile. */
export function genericScanner(profile: Profile): Scanner {
  return (source, out) => {
    new GenericScan(source, out, profile).run();
  };
}
