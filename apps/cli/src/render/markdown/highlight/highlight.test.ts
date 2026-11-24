import { describe, expect, it } from 'vitest';

import type { SyntaxToken } from '../types.js';
import { highlightCode, languageOf, MAX_HIGHLIGHT_CHARS, MAX_HIGHLIGHT_LINE } from './index.js';

/** The classed runs of `text`, plain text left out: what the highlighter decided is not plain. */
function classed(info: string, text: string): readonly (readonly [SyntaxToken, string])[] {
  const segments = highlightCode(text, info);
  if (!segments) throw new Error(`not highlighted: ${info}`);
  return segments
    .filter((segment) => segment.token !== 'text')
    .map((segment) => [segment.token, segment.text] as const);
}

describe('info strings name a language by their first word', () => {
  it.each([
    ['ts', 'typescript'],
    ['TS', 'typescript'],
    ['typescript title="a.ts"', 'typescript'],
    ['{.python}', 'python'],
    ['.python', 'python'],
    ['language-ts', 'typescript'],
    ['ts:src/a.ts', 'typescript'],
    ['ts{1,3}', 'typescript'],
    ['  sh', 'shell'],
    ['c++', 'cpp'],
    ['c#', 'csharp'],
    ['yml', 'yaml'],
    ['Dockerfile', 'dockerfile'],
  ])('%s is %s', (info, id) => {
    expect(languageOf(info)?.id).toBe(id);
  });

  it.each([undefined, '', ' ', 'text', 'txt', 'mermaid', 'console', 'unknownlang', 'language-'])(
    '%j is not highlighted',
    (info) => {
      expect(languageOf(info)).toBeUndefined();
      expect(highlightCode('const a = 1', info)).toBeUndefined();
    },
  );

  it('does not highlight an empty block, one over the size limit, or one with a minified line', () => {
    expect(highlightCode('', 'ts')).toBeUndefined();
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS + 1), 'ts')).toBeUndefined();
    expect(highlightCode('a'.repeat(MAX_HIGHLIGHT_CHARS), 'ts')).toBeUndefined(); // one line over the line limit
    expect(highlightCode(`${'a'.repeat(MAX_HIGHLIGHT_LINE)}\nconst b = 1`, 'ts')).toBeDefined();
    expect(
      highlightCode(`${'a'.repeat(MAX_HIGHLIGHT_LINE + 1)}\nconst b = 1`, 'ts'),
    ).toBeUndefined();
    const lines = Array.from({ length: 4000 }, () => 'let x = 1;').join('\n'); // 43 999 characters
    expect(highlightCode(lines, 'ts')).toBeDefined();
  });

  it('puts the size limit at exactly 64 KiB of short lines, apart from the line limit', () => {
    const line = 'let a = 1234567\n'; // 16 characters
    const atLimit = line.repeat(MAX_HIGHLIGHT_CHARS / line.length);
    expect(atLimit).toHaveLength(MAX_HIGHLIGHT_CHARS);
    expect(highlightCode(atLimit, 'ts')).toBeDefined();
    expect(highlightCode(`${atLimit}x`, 'ts')).toBeUndefined();
  });
});

describe('TypeScript and JavaScript', () => {
  it('classes keywords, types and numbers', () => {
    expect(classed('ts', 'const n: number = 0x1F;')).toEqual([
      ['keyword', 'const'],
      ['type', 'number'],
      ['number', '0x1F'],
    ]);
  });

  it('reads a word after a dot as a member, not a keyword', () => {
    expect(classed('ts', 'Array.from(x); obj.default; a.of')).toEqual([
      ['type', 'Array'],
      ['function', 'from'],
    ]);
  });

  it('ends a line comment at its line, so the code on the next line is read', () => {
    expect(classed('ts', 'const a = 1; // c\nconst b = 2;')).toEqual([
      ['keyword', 'const'],
      ['number', '1'],
      ['comment', '// c'],
      ['keyword', 'const'],
      ['number', '2'],
    ]);
    expect(classed('py', 'a = 1  # c\nb = 2')).toEqual([
      ['number', '1'],
      ['comment', '# c'],
      ['number', '2'],
    ]);
  });

  it('keeps `//` inside a string a string, and starts a comment after it', () => {
    expect(classed('ts', 'const u = "http://x"; // note')).toEqual([
      ['keyword', 'const'],
      ['string', '"http://x"'],
      ['comment', '// note'],
    ]);
  });

  it('ends an unterminated quote at the end of its line, not at the end of the block', () => {
    expect(classed('ts', 'const a = "oops\nconst b = 1;')).toEqual([
      ['keyword', 'const'],
      ['string', '"oops'],
      ['keyword', 'const'],
      ['number', '1'],
    ]);
  });

  it('lets a template literal run on across lines, and reads its holes as code', () => {
    expect(classed('ts', "const s = `a ${b ? `c${d}` : 'e'} f`;")).toEqual([
      ['keyword', 'const'],
      ['string', '`a '],
      ['string', '`c'],
      ['string', '`'],
      ['string', "'e'"],
      ['string', ' f`'],
    ]);
    expect(classed('ts', 'const a = `x\nconst b = 1')).toEqual([
      ['keyword', 'const'],
      ['string', '`x\nconst b = 1'],
    ]);
  });

  it('keeps a deeply nested template hole plain once the nesting limit is passed', () => {
    const deep = '`${'.repeat(100);
    expect(
      highlightCode(deep, 'ts')
        ?.map((segment) => segment.text)
        .join(''),
    ).toBe(deep);
  });

  it('classes decorators, capitalised names and call sites', () => {
    expect(classed('ts', '@Component({})\nclass Foo extends Bar { run() {} }')).toEqual([
      ['meta', '@Component'],
      ['keyword', 'class'],
      ['type', 'Foo'],
      ['keyword', 'extends'],
      ['type', 'Bar'],
      ['function', 'run'],
    ]);
  });

  it('does not treat TypeScript-only words as keywords in JavaScript', () => {
    expect(classed('js', 'const type = 1; interface')).toEqual([
      ['keyword', 'const'],
      ['number', '1'],
    ]);
    expect(classed('ts', 'type Alias = interface')).toEqual([
      ['keyword', 'type'],
      ['type', 'Alias'],
      ['keyword', 'interface'],
    ]);
    expect(classed('ts', 'type A = interface')).toEqual([
      ['keyword', 'type'],
      ['keyword', 'interface'],
    ]); // a one-letter name is not a type: a capital with no lowercase is a constant or a generic parameter
  });

  it('reads a number with an exponent, a separator and a suffix as one number', () => {
    expect(classed('ts', 'x = 1.5e-3 + 1_000n + .5')).toEqual([
      ['number', '1.5e-3'],
      ['number', '1_000n'],
      ['number', '.5'],
    ]);
  });
});

describe('JSON', () => {
  it('tells a key from a value', () => {
    expect(classed('json', '{"a": "b", "n" : 1, "t": true, "z": null, "l": ["x"]}')).toEqual([
      ['property', '"a"'],
      ['string', '"b"'],
      ['property', '"n"'],
      ['number', '1'],
      ['property', '"t"'],
      ['constant', 'true'],
      ['property', '"z"'],
      ['constant', 'null'],
      ['property', '"l"'],
      ['string', '"x"'],
    ]);
  });

  it('keeps an escaped quote inside the string', () => {
    expect(classed('json', '{"a\\"b": "c"}')).toEqual([
      ['property', '"a\\"b"'],
      ['string', '"c"'],
    ]);
  });

  it('reads comments in JSONC', () => {
    expect(classed('jsonc', '{ /* c */ "a": 1 } // d')).toEqual([
      ['comment', '/* c */'],
      ['property', '"a"'],
      ['number', '1'],
      ['comment', '// d'],
    ]);
  });
});

describe('Python', () => {
  it('reads a triple-quoted string across lines, and a prefix as part of the string', () => {
    expect(classed('python', 'x = f"{a}"\ny = """one\ntwo"""\nrb = rb\'z\'')).toEqual([
      ['string', 'f"{a}"'],
      ['string', '"""one\ntwo"""'],
      ['string', "rb'z'"],
    ]);
  });

  it('leaves a name that looks like a prefix alone when no quote follows', () => {
    expect(classed('python', 'f = 1')).toEqual([['number', '1']]);
  });

  it('does not start a comment inside a string', () => {
    expect(classed('python', 'a = "# not"  # is')).toEqual([
      ['string', '"# not"'],
      ['comment', '# is'],
    ]);
  });

  it('classes decorators, constants, builtin types and exceptions', () => {
    expect(classed('py', '@app.route("/")\ndef f(x: int) -> None:\n    raise ValueError')).toEqual([
      ['meta', '@app.route'],
      ['string', '"/"'],
      ['keyword', 'def'],
      ['function', 'f'],
      ['type', 'int'],
      ['constant', 'None'],
      ['keyword', 'raise'],
      ['type', 'ValueError'],
    ]);
  });
});

describe('shell', () => {
  it('names the command, its options and its strings', () => {
    expect(classed('bash', 'docker run --rm -it -e A="b c" image')).toEqual([
      ['function', 'docker'],
      ['property', '--rm'],
      ['property', '-it'],
      ['property', '-e'],
      ['string', '"b c"'],
    ]);
  });

  it('keeps a command after a `NAME=value` prefix a command', () => {
    expect(classed('sh', 'FOO="a b" npm test')).toEqual([
      ['variable', 'FOO'],
      ['string', '"a b"'],
      ['function', 'npm'],
    ]);
    expect(classed('sh', 'FOO=1 BAR=2 run')).toEqual([
      ['variable', 'FOO'],
      ['variable', 'BAR'],
      ['function', 'run'],
    ]);
  });

  it('does not read the digits of a redirection as numbers, or its `&` as a new command', () => {
    expect(classed('bash', 'make 2>&1 | tee log')).toEqual([
      ['function', 'make'],
      ['function', 'tee'],
    ]);
    expect(classed('bash', 'run &> out; next')).toEqual([
      ['function', 'run'],
      ['function', 'next'],
    ]);
  });

  it('classes variables inside a double-quoted string but not inside a single-quoted one', () => {
    expect(classed('bash', 'echo "hi $USER ${HOME}" \'$no\'')).toEqual([
      ['function', 'echo'],
      ['string', '"hi '],
      ['variable', '$USER'],
      ['string', ' '],
      ['variable', '${HOME}'],
      ['string', '"'],
      ['string', "'$no'"],
    ]);
  });

  it('starts a comment only at the start of a word', () => {
    expect(classed('bash', 'echo a#b # real')).toEqual([
      ['function', 'echo'],
      ['comment', '# real'],
    ]);
    expect(classed('bash', '#!/bin/sh')).toEqual([['comment', '#!/bin/sh']]);
  });

  it('does not start a comment at a `#` that follows a quote, and ends a comment at its line', () => {
    expect(classed('bash', 'echo "a"#b')).toEqual([
      ['function', 'echo'],
      ['string', '"a"'],
    ]);
    expect(classed('bash', 'echo a # c\nls')).toEqual([
      ['function', 'echo'],
      ['comment', '# c'],
      ['function', 'ls'],
    ]);
  });

  it('lets a single-quoted string run across lines, as the shell does', () => {
    expect(classed('bash', 'curl -d \'{\n  "a": 1\n}\' url')).toEqual([
      ['function', 'curl'],
      ['property', '-d'],
      ['string', '\'{\n  "a": 1\n}\''],
    ]);
  });

  it('keeps the arguments of a command that continues on the next line', () => {
    expect(classed('bash', 'docker run \\\n  -it image')).toEqual([
      ['function', 'docker'],
      ['property', '-it'],
    ]);
  });

  it('starts a command again after a pipe, a `then` and `$(`', () => {
    expect(classed('bash', 'if grep x f; then echo $(date); fi')).toEqual([
      ['keyword', 'if'],
      ['function', 'grep'],
      ['keyword', 'then'],
      ['function', 'echo'],
      ['function', 'date'],
      ['keyword', 'fi'],
    ]);
  });

  it('leaves a prompt `$ ` as text and still reads the command after it', () => {
    expect(classed('bash', '$ ls -la')).toEqual([
      ['function', 'ls'],
      ['property', '-la'],
    ]);
  });
});

describe('YAML', () => {
  it('reads a key only when the colon ends it', () => {
    expect(classed('yaml', 'url: http://x.y/z\ntime: 12:30')).toEqual([
      ['property', 'url'],
      ['property', 'time'],
      ['number', '12:30'], // a colon with no blank after it ends nothing: it is part of the value
    ]);
    expect(classed('yaml', 'a: "b: c"')).toEqual([
      ['property', 'a'],
      ['string', '"b: c"'],
    ]);
  });

  it('reads a block scalar as a string until the indentation returns', () => {
    const text =
      'steps:\n  - run: |\n      echo hi # not a comment\n\n      echo two\n    shell: bash\n  - name: x\nnext: 1';
    expect(classed('yaml', text)).toEqual([
      ['property', 'steps'],
      ['property', 'run'],
      ['meta', '|'],
      ['string', 'echo hi # not a comment'],
      ['string', 'echo two'],
      ['property', 'shell'], // a sibling key at the key's own column ends the block scalar
      ['property', 'name'],
      ['property', 'next'],
      ['number', '1'],
    ]);
  });

  it('classes scalars, comments, anchors and flow collections', () => {
    expect(classed('yaml', 'a: true # yes\nb: &x [1, "s"]\nc: *x\n- null\n- { k: v }')).toEqual([
      ['property', 'a'],
      ['constant', 'true'],
      ['comment', '# yes'],
      ['property', 'b'],
      ['meta', '&x'],
      ['number', '1'],
      ['string', '"s"'],
      ['property', 'c'],
      ['meta', '*x'],
      ['constant', 'null'],
      ['property', 'k'],
    ]);
  });

  it('reads document markers, quoted keys and a comment line', () => {
    expect(classed('yaml', '---\n# top\n"q k": 1\n...')).toEqual([
      ['meta', '---'],
      ['comment', '# top'],
      ['property', '"q k"'],
      ['number', '1'],
      ['meta', '...'],
    ]);
  });
});

describe('TOML and INI', () => {
  it('classes tables, keys, values and comments', () => {
    expect(
      classed(
        'toml',
        '# c\n[a.b]\nname = "x" # t\nn = 1_000\nd = 1979-05-27T07:32:00Z\n[[bin]]\nok = false',
      ),
    ).toEqual([
      ['comment', '# c'],
      ['type', '[a.b]'],
      ['property', 'name'],
      ['string', '"x"'],
      ['comment', '# t'],
      ['property', 'n'],
      ['number', '1_000'],
      ['property', 'd'],
      ['number', '1979-05-27T07:32:00Z'],
      ['type', '[[bin]]'],
      ['property', 'ok'],
      ['constant', 'false'],
    ]);
  });

  it('reads a multiline string and the continuation lines of an array', () => {
    expect(classed('toml', 'a = """\nx\n"""\nb = [\n  "p",\n  3,\n]')).toEqual([
      ['property', 'a'],
      ['string', '"""\nx\n"""'],
      ['property', 'b'],
      ['string', '"p"'],
      ['number', '3'],
    ]);
  });

  it('does not read the opening bracket of a nested array as a table header', () => {
    expect(classed('toml', 'a = [\n  [\n    1,\n    2,\n  ],\n]')).toEqual([
      ['property', 'a'],
      ['number', '1'],
      ['number', '2'],
    ]);
  });

  it('reads INI with `;` comments and `:` separators', () => {
    expect(classed('ini', '; c\n[s]\nk: v\nport = 80\non = yes')).toEqual([
      ['comment', '; c'],
      ['type', '[s]'],
      ['property', 'k'],
      ['property', 'port'],
      ['number', '80'],
      ['property', 'on'],
      ['constant', 'yes'],
    ]);
  });
});

describe('diff', () => {
  it('reads a line by its first character, without trusting hunk counts', () => {
    const text =
      'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@ fn\n ctx\n-old\n+new\n+more\n\\ No newline at end of file';
    expect(classed('diff', text)).toEqual([
      ['meta', 'diff --git a/x b/x'],
      ['meta', '--- a/x'],
      ['meta', '+++ b/x'],
      ['hunk', '@@ -1 +1 @@'],
      ['deleted', '-old'],
      ['inserted', '+new'],
      ['inserted', '+more'],
      ['comment', '\\ No newline at end of file'],
    ]);
  });

  it('reads `--- ` as a header only when a `+++ ` line follows it', () => {
    expect(classed('diff', '@@ -1 +1 @@\n--- removed text\n+++ added text')).toEqual([
      ['hunk', '@@ -1 +1 @@'],
      ['meta', '--- removed text'],
      ['meta', '+++ added text'],
    ]);
    expect(classed('diff', '@@ -1 +1 @@\n--- removed text\n context\n+++ added text')).toEqual([
      ['hunk', '@@ -1 +1 @@'],
      ['deleted', '--- removed text'],
      ['inserted', '+++ added text'],
    ]);
  });

  it('leaves prose and context lines plain, and works without any header', () => {
    expect(classed('patch', 'Here is the change:\n- a\n+ b')).toEqual([
      ['deleted', '- a'],
      ['inserted', '+ b'],
    ]);
  });
});

describe('SQL', () => {
  it('matches keywords in any case and reads a doubled quote inside a string', () => {
    expect(classed('sql', "select count(*) FROM t where n = 'o''k' -- c")).toEqual([
      ['keyword', 'select'],
      ['function', 'count'],
      ['keyword', 'FROM'],
      ['keyword', 'where'],
      ['string', "'o''k'"],
      ['comment', '-- c'],
    ]);
  });
});

describe('Go, Rust, Java, C, C++ and C#', () => {
  it('reads a Go raw string across lines and a rune', () => {
    expect(classed('go', "x := `a\nb`\ny := 'c'")).toEqual([
      ['string', '`a\nb`'],
      ['string', "'c'"],
    ]);
  });

  it('tells a Rust lifetime from a char literal and reads attributes and macros', () => {
    expect(
      classed(
        'rust',
        "#[derive(Debug)]\nfn f<'a>(x: &'a str) { let c = 'z'; println!(\"{}\", c); }",
      ),
    ).toEqual([
      ['meta', '#[derive(Debug)]'],
      ['keyword', 'fn'],
      ['type', "'a"],
      ['type', "'a"],
      ['type', 'str'],
      ['keyword', 'let'],
      ['string', "'z'"],
      ['function', 'println'],
      ['string', '"{}"'],
    ]);
  });

  it('reads a preprocessor directive and its angle-bracket path', () => {
    expect(classed('c', '#include <stdio.h>\n  #define N 3\nint main(void) { return N; }')).toEqual(
      [
        ['meta', '#include'],
        ['string', '<stdio.h>'],
        ['meta', '#define'],
        ['number', '3'],
        ['type', 'int'],
        ['function', 'main'],
        ['type', 'void'],
        ['keyword', 'return'],
      ],
    );
  });

  it('reads Java annotations and text blocks, and C# types', () => {
    expect(classed('java', '@Override\npublic String s() { return """\n x"""; }')).toEqual([
      ['meta', '@Override'],
      ['keyword', 'public'],
      ['type', 'String'],
      ['function', 's'],
      ['keyword', 'return'],
      ['string', '"""\n x"""'],
    ]);
    expect(classed('cs', 'public async Task<int> Run() { var x = null; }')).toEqual([
      ['keyword', 'public'],
      ['keyword', 'async'],
      ['type', 'Task'],
      ['type', 'int'],
      ['function', 'Run'],
      ['type', 'var'],
      ['constant', 'null'],
    ]);
  });
});

describe('HTML, XML and CSS', () => {
  it('classes tags, attributes, values, comments and declarations, and leaves text and a bare `<` alone', () => {
    expect(classed('html', '<!DOCTYPE html>\n<a href="x" id=y hidden>1 < 2</a><!-- c -->')).toEqual(
      [
        ['meta', '<!DOCTYPE html>'],
        ['keyword', 'a'],
        ['property', 'href'],
        ['string', '"x"'],
        ['property', 'id'],
        ['string', 'y'],
        ['property', 'hidden'],
        ['keyword', 'a'],
        ['comment', '<!-- c -->'],
      ],
    );
  });

  it('terminates on an unfinished tag and an unfinished attribute value', () => {
    expect(
      highlightCode('<a href="never', 'html')
        ?.map((segment) => segment.text)
        .join(''),
    ).toBe('<a href="never');
    expect(
      highlightCode('<a', 'xml')
        ?.map((segment) => segment.text)
        .join(''),
    ).toBe('<a');
  });

  it('tells a property from a selector, and reads at-rules, colours, units and !important', () => {
    expect(
      classed(
        'css',
        '@media (min-width: 600px) {\n  a:hover { color: #fff; margin: -1.5rem 50% !important }\n}',
      ),
    ).toEqual([
      ['keyword', '@media'],
      ['property', 'color'],
      ['number', '#fff'],
      ['property', 'margin'],
      ['number', '-1.5rem'],
      ['number', '50%'],
      ['keyword', 'important'],
    ]);
  });
});

describe('Dockerfile', () => {
  it('reads instructions only in capitals, so a shell word like `run` stays plain', () => {
    expect(classed('dockerfile', 'FROM node AS b\nRUN npm run build # c')).toEqual([
      ['keyword', 'FROM'],
      ['keyword', 'AS'],
      ['keyword', 'RUN'],
      ['comment', '# c'],
    ]);
  });
});
