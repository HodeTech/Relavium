import { describe, expect, it } from 'vitest';

import type { SyntaxToken } from '../types.js';
import { highlightCode } from './index.js';

/**
 * Constructs an independent review found misread, each with the input that showed it. Every case is a snippet of the
 * kind an answer contains. The expected classes are what a reader would call right, except the cases named as a known
 * misread (the JSX text one), which pin how far the damage goes, not that it is right.
 */
function classed(info: string, text: string): readonly (readonly [SyntaxToken, string])[] {
  const segments = highlightCode(text, info);
  if (!segments) throw new Error(`not highlighted: ${info}`);
  return segments
    .filter((segment) => segment.token !== 'text')
    .map((segment) => [segment.token, segment.text] as const);
}

describe('a dot is member access only when a name follows it at once, and it is not one of a run of dots', () => {
  it('reads the instruction after `COPY . .` in a Dockerfile', () => {
    expect(classed('dockerfile', 'COPY . .\nRUN npm run build')).toEqual([
      ['keyword', 'COPY'],
      ['keyword', 'RUN'],
    ]);
  });

  it('reads the keywords after the dots of a Python relative import', () => {
    expect(classed('python', 'from . import views\nfrom .. import x')).toEqual([
      ['keyword', 'from'],
      ['keyword', 'import'],
      ['keyword', 'from'],
      ['keyword', 'import'],
    ]);
  });

  it('reads the keyword after a spread in JavaScript and TypeScript', () => {
    expect(classed('ts', 'const s = [...new Set(a)]; const t = {...this.state};')).toEqual([
      ['keyword', 'const'],
      ['keyword', 'new'],
      ['type', 'Set'],
      ['keyword', 'const'],
      ['keyword', 'this'],
    ]);
  });

  it('reads the type after the variadic dots of a Go parameter', () => {
    expect(classed('go', 'func sum(nums ...int) int { return 0 }')).toEqual([
      ['keyword', 'func'],
      ['function', 'sum'],
      ['type', 'int'],
      ['type', 'int'],
      ['keyword', 'return'],
      ['number', '0'],
    ]);
  });

  it('still reads a keyword after a member dot as a name, even at the start of a line', () => {
    expect(classed('ts', 'a\n  .default\n  .from(x)')).toEqual([['function', 'from']]);
  });
});

describe('YAML anchors and tags', () => {
  it('reads an anchor or a tag that stands before a key, and still the key', () => {
    expect(classed('yaml', '&defaults color: red\n- !tag name: x\nref: &r value')).toEqual([
      ['meta', '&defaults'],
      ['property', 'color'],
      ['meta', '!tag'],
      ['property', 'name'],
      ['property', 'ref'],
      ['meta', '&r'],
    ]);
  });

  it('leaves a tagged value, with a colon in it and no key, as a value', () => {
    expect(classed('yaml', '- !Sub "arn:aws:x"\n')).toEqual([
      ['meta', '!Sub'],
      ['string', '"arn:aws:x"'],
    ]);
  });
});

describe('regular-expression literals in JavaScript and TypeScript', () => {
  it('reads a quote inside a regular expression as part of it', () => {
    expect(classed('ts', 'a.replace(/\'/g, "\\\\\'")')).toEqual([
      ['function', 'replace'],
      ['string', "/'/g"],
      ['string', '"\\\\\'"'],
    ]);
  });

  it('does not let a backtick in a regular expression open a template literal', () => {
    expect(classed('js', 'const r = /`/g; const n = 1;')).toEqual([
      ['keyword', 'const'],
      ['string', '/`/g'],
      ['keyword', 'const'],
      ['number', '1'],
    ]);
  });

  it('reads `//` inside a regular expression as part of it', () => {
    expect(classed('js', 'if (/https?:\\/\\//.test(u)) go();')).toEqual([
      ['keyword', 'if'],
      ['string', '/https?:\\/\\//'],
      ['function', 'test'],
      ['function', 'go'],
    ]);
  });

  it('reads a regular expression after `return`, and a class holding a slash', () => {
    expect(classed('ts', 'return /[/]x/i.test(s)')).toEqual([
      ['keyword', 'return'],
      ['string', '/[/]x/i'],
      ['function', 'test'],
    ]);
  });

  it('reads a division as a division', () => {
    expect(classed('js', 'x = a / 2 / b; y = (c + 1) / 3; z = list[0] / 4;')).toEqual([
      ['number', '2'],
      ['number', '1'],
      ['number', '3'],
      ['number', '0'],
      ['number', '4'],
    ]);
  });

  it('gives up on one line and goes on with the next', () => {
    expect(classed('js', 'a = (/ no closer\nb = /x/;')).toEqual([['string', '/x/']]);
  });

  it('does not read a closing JSX tag as a regular expression', () => {
    expect(classed('tsx', 'const a = <a>x</a>; const b = <b>y</b>;')).toEqual([
      ['keyword', 'const'],
      ['keyword', 'const'],
    ]);
  });

  it('confines a quote in JSX text to its line (a known misread: the text is read as code)', () => {
    expect(classed('tsx', "<p>Don't click</p>\nconst n = 1;")).toEqual([
      ['type', 'Don'],
      ['string', "'t click</p>"],
      ['keyword', 'const'],
      ['number', '1'],
    ]);
  });
});

describe('Rust', () => {
  it('reads a range as two numbers and a path through `self`', () => {
    expect(classed('rust', 'for i in 0..10 { v[1..3]; 0..self.len() }')).toEqual([
      ['keyword', 'for'],
      ['keyword', 'in'],
      ['number', '0'],
      ['number', '10'],
      ['number', '1'],
      ['number', '3'],
      ['number', '0'],
      ['keyword', 'self'],
      ['function', 'len'],
    ]);
  });

  it('reads a tuple index as a name and a number', () => {
    expect(classed('rust', 'let a = t.0.1;')).toEqual([
      ['keyword', 'let'],
      ['number', '0.1'],
    ]);
  });

  it("reads `'\\''` as one char literal, and an escape like `'\\u{1F600}'`", () => {
    expect(classed('rust', "let q = '\\''; let e = '\\u{1F600}'; let n = 1;")).toEqual([
      ['keyword', 'let'],
      ['string', "'\\''"],
      ['keyword', 'let'],
      ['string', "'\\u{1F600}'"],
      ['keyword', 'let'],
      ['number', '1'],
    ]);
  });

  it('reads a raw string with a quote inside it as one string', () => {
    expect(classed('rust', 'let j = r#"{"a": 1}"#; let k = br"x";')).toEqual([
      ['keyword', 'let'],
      ['string', 'r#"{"a": 1}"#'],
      ['keyword', 'let'],
      ['string', 'br"x"'],
    ]);
  });
});

describe('TOML and INI', () => {
  it('reads the keys of an inline table', () => {
    expect(classed('toml', 'serde = { version = "1.0", features = ["derive"] }')).toEqual([
      ['property', 'serde'],
      ['property', 'version'],
      ['string', '"1.0"'],
      ['property', 'features'],
      ['string', '"derive"'],
    ]);
  });

  it('reads the lines of a multi-line array as values, not as table headers', () => {
    expect(classed('toml', 'a = [\n  [1, 2],\n  [3],\n]\n[t]\nb = 1')).toEqual([
      ['property', 'a'],
      ['number', '1'],
      ['number', '2'],
      ['number', '3'],
      ['type', '[t]'],
      ['property', 'b'],
      ['number', '1'],
    ]);
  });

  it('does not let a broken table header reach over the lines after it', () => {
    expect(classed('toml', '[broken\nb = 1\n]')).toEqual([['number', '1']]);
  });

  it('reads a `#` inside an INI or env value as part of it, and one after a blank as a comment', () => {
    expect(classed('env', 'COLOR=#ff0000 # red\nexport PORT=3000')).toEqual([
      ['property', 'COLOR'],
      ['comment', '# red'],
      ['keyword', 'export'],
      ['property', 'PORT'],
      ['number', '3000'],
    ]);
  });

  it('still reads `#` as a comment anywhere outside a string in TOML', () => {
    expect(classed('toml', 'a = 1#c')).toEqual([
      ['property', 'a'],
      ['number', '1'],
      ['comment', '#c'],
    ]);
  });
});

describe('shell', () => {
  it('reads the body of a function', () => {
    expect(classed('bash', 'foo() { echo hi; }')).toEqual([
      ['function', 'foo'],
      ['function', 'echo'],
    ]);
  });

  it('reads the names an `export` or `local` assigns', () => {
    expect(classed('bash', 'export NAME=val OTHER="x y"\nlocal n=1')).toEqual([
      ['function', 'export'],
      ['variable', 'NAME'],
      ['variable', 'OTHER'],
      ['string', '"x y"'],
      ['function', 'local'],
      ['variable', 'n'],
    ]);
  });

  it('keeps the arithmetic of `$((…))` out of the commands', () => {
    expect(classed('bash', 'echo $((1+2)) done')).toEqual([['function', 'echo']]);
  });

  it('does not read a `case` pattern as a command, and reads the command after it', () => {
    expect(classed('bash', 'case $x in\n  start) echo go ;;\n  *) echo no ;;\nesac')).toEqual([
      ['keyword', 'case'],
      ['variable', '$x'],
      ['keyword', 'in'],
      ['function', 'echo'],
      ['function', 'echo'],
      ['keyword', 'esac'],
    ]);
  });

  it('reads a command in `$(…)` as a command, and an array as values', () => {
    expect(classed('bash', 'echo $(date) && arr=(a b c)')).toEqual([
      ['function', 'echo'],
      ['function', 'date'],
      ['variable', 'arr'],
    ]);
  });

  it('reads the commands of a session and leaves its output alone', () => {
    expect(classed('bash', '$ npm test\nPASS src/a.test.ts\n  Tests: 3 passed\n$ ls -la')).toEqual([
      ['function', 'npm'],
      ['function', 'ls'],
      ['property', '-la'],
    ]);
  });

  it('keeps a comment in a session, and a command that continues over lines', () => {
    expect(classed('bash', '$ docker run \\\n  -it image\n# note\nout')).toEqual([
      ['function', 'docker'],
      ['property', '-it'],
      ['comment', '# note'],
    ]);
  });

  it('never splits a backslash and an astral character between two classes', () => {
    const runs = highlightCode('\\😀abc', 'bash') ?? [];
    expect(runs.map((run) => run.text).join('')).toBe('\\😀abc');
    for (const run of runs) {
      const last = run.text.charCodeAt(run.text.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });
});

describe('C, C++, C#, SQL', () => {
  it('reads a PascalCase method call as a call and a constructor as a type', () => {
    expect(classed('cs', 'return NotFound(); var u = new User(); return Ok(u);')).toEqual([
      ['keyword', 'return'],
      ['function', 'NotFound'],
      ['type', 'var'],
      ['keyword', 'new'],
      ['type', 'User'],
      ['keyword', 'return'],
      ['function', 'Ok'],
    ]);
  });

  it('reads a verbatim and a raw string in C#', () => {
    expect(classed('cs', 'var p = @"C:\\temp\\"; var n = 1;')).toEqual([
      ['type', 'var'],
      ['string', '@"C:\\temp\\"'],
      ['type', 'var'],
      ['number', '1'],
    ]);
  });

  it('reads a digit separator in C++ as part of the number', () => {
    expect(classed('cpp', "auto n = 1'000'000; char c = 'x';")).toEqual([
      ['keyword', 'auto'],
      ['number', "1'000'000"],
      ['type', 'char'],
      ['string', "'x'"],
    ]);
  });

  it('reads a quoted identifier in SQL as a name, not as a keyword', () => {
    expect(classed('sql', 'SELECT "order", `group` FROM t')).toEqual([
      ['keyword', 'SELECT'],
      ['property', '"order"'],
      ['property', '`group`'],
      ['keyword', 'FROM'],
    ]);
  });
});
