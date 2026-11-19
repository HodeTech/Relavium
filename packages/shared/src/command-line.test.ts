import { describe, expect, it } from 'vitest';

import {
  argvMatchesCommandLine,
  isUsableCommandLine,
  quoteCommandLine,
  tokenizeCommandLine,
} from './command-line.js';

describe('tokenizeCommandLine (ADR-0118 §3)', () => {
  it('splits on whitespace runs and trims the ends', () => {
    expect(tokenizeCommandLine('ls -la').tokens).toEqual(['ls', '-la']);
    expect(tokenizeCommandLine('  git \t status\n').tokens).toEqual(['git', 'status']);
    expect(tokenizeCommandLine('').tokens).toEqual([]);
    expect(tokenizeCommandLine('   ').tokens).toEqual([]);
  });

  it('keeps shell metacharacters, backslashes and expansions literal', () => {
    expect(tokenizeCommandLine('ls; rm -rf /').tokens).toEqual(['ls;', 'rm', '-rf', '/']);
    expect(tokenizeCommandLine('echo $HOME | cat && x *').tokens).toEqual([
      'echo',
      '$HOME',
      '|',
      'cat',
      '&&',
      'x',
      '*',
    ]);
    expect(tokenizeCommandLine('a\\ b').tokens).toEqual(['a\\', 'b']); // no escapes
  });

  it('groups a quoted span into one token, whitespace included', () => {
    expect(tokenizeCommandLine('grep "foo bar" .').tokens).toEqual(['grep', 'foo bar', '.']);
    expect(tokenizeCommandLine("echo 'a b' c").tokens).toEqual(['echo', 'a b', 'c']);
    expect(tokenizeCommandLine('say "it\'s"').tokens).toEqual(['say', "it's"]);
    expect(tokenizeCommandLine('say \'a "b" c\'').tokens).toEqual(['say', 'a "b" c']);
  });

  it('joins adjacent quoted and unquoted spans into one token', () => {
    expect(tokenizeCommandLine('a"b c"d').tokens).toEqual(['ab cd']);
    expect(tokenizeCommandLine(`'it'"'"'s'`).tokens).toEqual(["it's"]);
  });

  it('treats an empty quoted span as a token', () => {
    expect(tokenizeCommandLine('cmd ""').tokens).toEqual(['cmd', '']);
    expect(tokenizeCommandLine("cmd '' x").tokens).toEqual(['cmd', '', 'x']);
  });

  it('reports an open quote instead of tolerating it', () => {
    expect(tokenizeCommandLine('cmd "unterminated')).toEqual({
      tokens: ['cmd', 'unterminated'],
      unterminatedQuote: true,
    });
    expect(tokenizeCommandLine("cmd 'x").unterminatedQuote).toBe(true);
    expect(tokenizeCommandLine('cmd "x"').unterminatedQuote).toBe(false);
    // A quote of the other kind inside a span does not close it.
    expect(tokenizeCommandLine('cmd "it\'s').unterminatedQuote).toBe(true);
  });
});

describe('quoteCommandLine is the inverse of the tokenizer', () => {
  const cases: readonly (readonly string[])[] = [
    [],
    ['ls'],
    ['ls', '-la'],
    ['cat', 'a b'],
    ['cat a', 'b'],
    ['echo', ''],
    ['echo', '', ''],
    ['say', "it's"],
    ['say', 'a "b" c'],
    ['say', `both ' and "`],
    ["'"],
    ['"'],
    ["''"],
    [' '],
    ['\t', '\n', '\r'],
    ['a\nb'],
    ['$HOME', '*', '|', ';', '&&', '\\'],
    ['PGPASSWORD=secret', 'psql'],
    ['unicode ✓', 'ünï'],
    [String.fromCharCode(0x2028), String.fromCharCode(0x202e), String.fromCharCode(0x200b)],
  ];

  it.each(cases.map((argv, index) => [index, argv] as const))(
    'round-trips case %i',
    (_index, argv) => {
      const line = quoteCommandLine(argv);
      const parsed = tokenizeCommandLine(line);
      expect(parsed.unterminatedQuote).toBe(false);
      expect(parsed.tokens).toEqual(argv);
    },
  );

  it('round-trips a seeded random population of awkward tokens', () => {
    // A small deterministic generator (no dependency): tokens drawn from an alphabet heavy in the characters the
    // grammar treats specially.
    let state = 0x9e3779b9;
    const next = (): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state;
    };
    const alphabet = ['a', 'b', ' ', "'", '"', '\t', '\n', '\\', '$', '*', '-', 'é'];
    for (let round = 0; round < 500; round += 1) {
      const argv: string[] = [];
      const width = next() % 5;
      for (let i = 0; i < width; i += 1) {
        let token = '';
        const length = next() % 7;
        for (let j = 0; j < length; j += 1) token += alphabet[next() % alphabet.length];
        argv.push(token);
      }
      expect(tokenizeCommandLine(quoteCommandLine(argv)).tokens).toEqual(argv);
    }
  });

  it('leaves an ordinary command as typed', () => {
    expect(quoteCommandLine(['git', 'status', '--short'])).toBe('git status --short');
    expect(quoteCommandLine(['grep', 'foo bar', '.'])).toBe("grep 'foo bar' .");
  });
});

describe('argvMatchesCommandLine compares tokens, not text', () => {
  it('does not admit one argument with a space for two arguments', () => {
    // The defect this closes: the joined strings of both argvs were equal.
    expect(argvMatchesCommandLine(['cat', 'a', 'b'], 'cat a b')).toBe(true);
    expect(argvMatchesCommandLine(['cat', 'a b'], 'cat a b')).toBe(false);
    expect(argvMatchesCommandLine(['cat a', 'b'], 'cat a b')).toBe(false);
    expect(argvMatchesCommandLine(['./s/build.sh', '--release'], './s/build.sh --release')).toBe(
      true,
    );
    expect(argvMatchesCommandLine(['./s/build.sh --release'], './s/build.sh --release')).toBe(
      false,
    );
  });

  it('lets an entry typed with quotes match the argv it names', () => {
    expect(argvMatchesCommandLine(['cat', 'a b'], 'cat "a b"')).toBe(true);
    expect(argvMatchesCommandLine(['cat', 'a b'], "cat 'a b'")).toBe(true);
    expect(argvMatchesCommandLine(['cat', 'a', 'b'], 'cat "a b"')).toBe(false);
  });

  it('requires equal length and equal elements', () => {
    expect(argvMatchesCommandLine(['git'], 'git status')).toBe(false);
    expect(argvMatchesCommandLine(['git', 'status', 'x'], 'git status')).toBe(false);
    expect(argvMatchesCommandLine(['git', 'Status'], 'git status')).toBe(false);
  });

  it('never matches an entry that cannot be tokenized', () => {
    expect(argvMatchesCommandLine(['cat', 'x'], 'cat "x')).toBe(false);
    expect(argvMatchesCommandLine([], '')).toBe(false);
  });
});

describe('isUsableCommandLine', () => {
  it('accepts a command line and refuses an open quote or an empty one', () => {
    expect(isUsableCommandLine('git status')).toBe(true);
    expect(isUsableCommandLine('echo "a b"')).toBe(true);
    expect(isUsableCommandLine('echo "a b')).toBe(false);
    expect(isUsableCommandLine('   ')).toBe(false);
    expect(isUsableCommandLine('')).toBe(false);
  });

  it('refuses an entry whose program token is empty — it tokenizes but could never name anything to run', () => {
    expect(isUsableCommandLine("''")).toBe(false);
    expect(isUsableCommandLine('""')).toBe(false);
    expect(isUsableCommandLine("'' x")).toBe(false);
    // An empty ARGUMENT after a real program is a legitimate entry.
    expect(isUsableCommandLine("echo ''")).toBe(true);
  });
});
