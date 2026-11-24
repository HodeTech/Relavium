import {
  escapeEnd,
  isAsciiLetter,
  isDigit,
  isIdentPart,
  isIdentStart,
  isSpace,
  words,
} from './chars.js';
import type { Scanner, Segments } from './segments.js';

const KEYWORDS = words(
  'if then elif else fi for while until do done case esac in function select time coproc',
);
/** After these a command starts again (`if cmd`, `then cmd`, `do cmd`). */
const COMMAND_AFTER = words('if then elif else do while until time');
/** Commands whose arguments are assignments (`export NAME=value`). */
const ASSIGNING = words('export local readonly declare typeset');
const SINGLE_QUOTE = 39;
const DOUBLE_QUOTE = 34;
const BACKTICK = 96;
const DOLLAR = 36;
const BACKSLASH = 92;
const HASH = 35;
const SPECIAL_VARIABLES = new Set('@*#?$!-0123456789'.split(''));
/** Characters that end a word and may start something else. */
const WORD_BREAKS = new Set([';', '|', '&', '(', ')', '<', '>', '"', "'", '`', '$', '\\']);

function isWordBreak(source: string, at: number): boolean {
  return isSpace(source.charCodeAt(at)) || WORD_BREAKS.has(source[at] ?? '');
}

/** The end of a `$…` expansion that starts at `at`, or `at` when the `$` is just a character. */
function variableEnd(out: Segments, source: string, at: number): number {
  const next = source[at + 1] ?? '';
  if (next === '{') {
    const close = out.find('}', at + 2);
    return close < 0 || close > out.lineEnd(at) ? at : close + 1;
  }
  if (next !== '$' && isIdentStart(next.charCodeAt(0))) {
    let end = at + 2;
    while (end < source.length && source[end] !== '$' && isIdentPart(source.charCodeAt(end)))
      end += 1;
    return end;
  }
  return SPECIAL_VARIABLES.has(next) ? at + 2 : at;
}

/** `NAME=` at the start of a word: the length of the name, or 0. */
function assignmentEnd(text: string): number {
  if (!isIdentStart(text.charCodeAt(0))) return 0;
  let at = 1;
  while (at < text.length && isIdentPart(text.charCodeAt(at))) at += 1;
  return text[at] === '=' ? at : 0;
}

/** `-x`, `--long`, `--key=value`: an option, not a negative number. */
function isOption(text: string): boolean {
  if (text.charCodeAt(0) !== 45 || text.length < 2 || text === '--') return false;
  return isAsciiLetter(text.charCodeAt(1)) || text[1] === '-';
}

function isDigits(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    if (!isDigit(text.charCodeAt(index))) return false;
  }
  return text.length > 0;
}

/** A session transcript: the first line of text starts with a `$ ` prompt, so the lines without one are output. */
function isSession(source: string): boolean {
  let at = 0;
  while (at < source.length && isSpace(source.charCodeAt(at))) at += 1;
  return source.startsWith('$ ', at);
}

class ShellScan {
  private i = 0;
  /** Is the next word a command name? True at the start, after a newline or an operator, and after `then`, `do`... */
  private commandStart = true;
  /** `NAME=` was just read: the value that follows is part of the assignment, not the command. */
  private valuePending = false;
  /** The command on this line is `export`, `local`...: its `NAME=value` arguments are assignments. */
  private assigning = false;
  /** Open parentheses: a `)` with none open ends a `case` pattern. */
  private parens = 0;
  private lineStart = true;
  private readonly session: boolean;
  private readonly source: string;
  private readonly out: Segments;

  constructor(source: string, out: Segments) {
    this.source = source;
    this.out = out;
    this.session = isSession(source);
  }

  run(): void {
    while (this.i < this.source.length) {
      this.out.tick();
      const code = this.source.charCodeAt(this.i);
      if (code === 10) {
        this.commandStart = true;
        this.valuePending = false;
        this.assigning = false;
        this.lineStart = true;
        this.i += 1;
      } else if (isSpace(code)) this.i += 1;
      else if (this.lineStart && this.skipsOutput(code)) this.i = this.out.lineEnd(this.i);
      else {
        this.lineStart = false;
        this.step(code);
      }
    }
  }

  /** In a session transcript a line with no prompt (and no comment) is output, which is not shell. */
  private skipsOutput(code: number): boolean {
    return this.session && code !== HASH && !this.source.startsWith('$ ', this.i);
  }

  private step(code: number): void {
    if (code === HASH && this.startsWord()) this.comment();
    else if (code === SINGLE_QUOTE) this.single();
    else if (code === DOUBLE_QUOTE) this.double();
    else if (code === DOLLAR) this.dollar();
    else if (code === BACKSLASH) this.i = escapeEnd(this.source, this.i);
    else if (code === BACKTICK || code === 59 || code === 124) this.operator(true);
    else if (code === 40) this.open();
    else if (code === 41) this.close();
    else if (code === 38) this.operator(!this.isRedirection());
    else if (code === 60 || code === 62) this.operator(false);
    else this.word();
  }

  /** A `#` starts a comment only at the start of a word: after a blank, an operator or the start. */
  private startsWord(): boolean {
    if (this.i === 0) return true;
    const before = this.source[this.i - 1] ?? '';
    return isSpace(before.charCodeAt(0)) || ';&|('.includes(before);
  }

  /** `2>&1` and `&>file`: the `&` belongs to a redirection and does not start a new command. */
  private isRedirection(): boolean {
    const before = this.source[this.i - 1];
    return before === '>' || before === '<' || this.source[this.i + 1] === '>';
  }

  private comment(): void {
    const end = this.out.lineEnd(this.i);
    this.out.mark(this.i, end, 'comment');
    this.i = end;
  }

  private operator(commandNext: boolean): void {
    this.commandStart = commandNext;
    this.valuePending = false;
    this.assigning = false;
    this.i += 1;
  }

  /** `(`: a subshell, a function's `()`, or the array of `NAME=(…)`. */
  private open(): void {
    this.parens += 1;
    this.operator(!this.valuePending);
  }

  /** `)`: it closes a `(`; one with none open ends a `case` pattern, and a command follows it. */
  private close(): void {
    const closes = this.parens > 0;
    if (closes) this.parens -= 1;
    this.operator(!closes);
  }

  /** A string or expansion ended: a command follows only when it was the value of a `NAME=` prefix. */
  private endValue(): void {
    this.commandStart = this.valuePending;
    this.valuePending = false;
  }

  private single(): void {
    const close = this.out.find("'", this.i + 1);
    const end = close < 0 ? this.source.length : close + 1;
    this.out.mark(this.i, end, 'string');
    this.i = end;
    this.endValue();
  }

  /** `"…"` with `$var` and `${…}` inside it classed as variables. */
  private double(): void {
    const { source, out } = this;
    let part = this.i;
    let at = this.i + 1;
    while (at < source.length) {
      const code = source.charCodeAt(at);
      if (code === BACKSLASH) at = escapeEnd(source, at);
      else if (code === DOUBLE_QUOTE) {
        at += 1;
        break;
      } else if (code === DOLLAR) {
        const end = variableEnd(out, source, at);
        if (end === at) at += 1;
        else {
          out.mark(part, at, 'string');
          out.mark(at, end, 'variable');
          part = end;
          at = end;
        }
      } else at += 1;
    }
    const end = Math.min(at, source.length);
    out.mark(part, end, 'string');
    this.i = end;
    this.endValue();
  }

  /** `$name`, `${…}`, `$1`, `$?`; `$(` opens a command; `$((` is arithmetic; `$'…'` is a string; a lone `$` is text. */
  private dollar(): void {
    const { source } = this;
    const next = source.charCodeAt(this.i + 1);
    if (source.startsWith('$((', this.i)) this.arithmetic();
    else if (next === 40) {
      this.parens += 1;
      this.i += 2;
      this.commandStart = true;
      this.valuePending = false;
    } else if (next === SINGLE_QUOTE) this.ansiString();
    else {
      const end = variableEnd(this.out, source, this.i);
      if (end > this.i) {
        this.out.mark(this.i, end, 'variable');
        this.i = end;
        this.endValue();
      } else this.i += 1;
    }
  }

  /** `$((1 + 2))`: arithmetic is not a command; it stays plain, up to its `))` or the end of the line. */
  private arithmetic(): void {
    const close = this.out.find('))', this.i + 3);
    const line = this.out.lineEnd(this.i);
    this.i = close >= 0 && close < line ? close + 2 : line;
    this.endValue();
  }

  /** `$'a\nb'`: a string in which a backslash takes the next character with it. */
  private ansiString(): void {
    const { source } = this;
    let at = this.i + 2;
    while (at < source.length && source.charCodeAt(at) !== SINGLE_QUOTE) {
      at = source.charCodeAt(at) === BACKSLASH ? escapeEnd(source, at) : at + 1;
    }
    const end = Math.min(at + 1, source.length);
    this.out.mark(this.i, end, 'string');
    this.i = end;
    this.endValue();
  }

  private word(): void {
    const { source } = this;
    this.valuePending = false;
    let end = this.i + 1;
    while (end < source.length && !isWordBreak(source, end)) end += 1;
    const text = source.slice(this.i, end);
    if (this.commandStart) this.commandWord(text, end);
    else this.argument(text, end);
    this.i = end;
  }

  private commandWord(text: string, end: number): void {
    const { out } = this;
    if (KEYWORDS.has(text)) {
      out.mark(this.i, end, 'keyword');
      this.commandStart = COMMAND_AFTER.has(text);
      return;
    }
    if (text === '{' || text === '!') return;
    if (text === '}') {
      this.commandStart = false;
      return;
    }
    const assignment = assignmentEnd(text);
    if (assignment > 0) {
      out.mark(this.i, this.i + assignment, 'variable');
      this.valuePending = text.length === assignment + 1;
      return;
    }
    this.commandStart = false;
    if (this.source[end] === ')' && this.parens === 0) return; // `start)`: a case pattern, not a command
    out.mark(this.i, end, 'function');
    this.assigning = ASSIGNING.has(text);
  }

  private argument(text: string, end: number): void {
    const { out } = this;
    const assignment = this.assigning ? assignmentEnd(text) : 0;
    if (text === 'in') out.mark(this.i, end, 'keyword');
    else if (text === '{')
      this.commandStart = true; // a function body: `foo() {`
    else if (assignment > 0) out.mark(this.i, this.i + assignment, 'variable');
    else if (isOption(text)) {
      const equals = text.indexOf('=');
      out.mark(this.i, this.i + (equals < 0 ? text.length : equals), 'property');
    } else if (isDigits(text) && !this.isRedirectionNumber(end)) out.mark(this.i, end, 'number');
  }

  /** The `2` and `1` of `2>&1`: file descriptors, not numbers. */
  private isRedirectionNumber(end: number): boolean {
    const before = this.source[this.i - 1];
    const after = this.source[end];
    return before === '&' || before === '>' || before === '<' || after === '>' || after === '<';
  }
}

/** POSIX shells and bash: comments, strings, expansions, keywords, command names and options. */
export const scanShell: Scanner = (source, out) => {
  new ShellScan(source, out).run();
};
