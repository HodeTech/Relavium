import { words } from './chars.js';
import type { Profile } from './generic.js';
import type { StringRule } from './lexemes.js';

const SLASH_COMMENTS = ['//'] as const;
const C_BLOCK = [['/*', '*/'] as const];

/** `"…"` and `'…'` that end at the line's end when not closed. */
const LINE_STRINGS: readonly StringRule[] = [
  { open: '"', multiline: false, escapes: true },
  { open: "'", multiline: false, escapes: true },
];

const NONE = words('');

const JS_KEYWORDS =
  'break case catch class const continue debugger default delete do else export extends finally for function if ' +
  'import in instanceof new return super switch this throw try typeof var void while with yield let static async ' +
  'await of from as enum';

const TS_ONLY_KEYWORDS =
  'type interface implements declare namespace abstract readonly public private protected override keyof infer is ' +
  'satisfies module global unique asserts';

const JS_STRINGS: readonly StringRule[] = [
  { open: '`', multiline: true, escapes: true, interpolation: true },
  ...LINE_STRINGS,
];

export const JAVASCRIPT: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: JS_STRINGS,
  keywords: words(JS_KEYWORDS),
  constants: words('true false null undefined NaN Infinity'),
  types: NONE,
  capitalTypes: true,
  decorators: true,
  regexLiterals: true,
};

export const TYPESCRIPT: Profile = {
  ...JAVASCRIPT,
  keywords: words(`${JS_KEYWORDS} ${TS_ONLY_KEYWORDS}`),
  types: words('string number boolean any unknown never object symbol bigint'),
};

export const JSON_PROFILE: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: [{ open: '"', multiline: false, escapes: true }],
  keywords: NONE,
  constants: words('true false null'),
  types: NONE,
  jsonKeys: true,
};

export const PYTHON: Profile = {
  lineComments: ['#'],
  blockComments: [],
  strings: [
    { open: '"""', multiline: true, escapes: true },
    { open: "'''", multiline: true, escapes: true },
    ...LINE_STRINGS,
  ],
  keywords: words(
    'and as assert async await break class continue def del elif else except finally for from global if import in ' +
      'is lambda nonlocal not or pass raise return try while with yield',
  ),
  constants: words('True False None'),
  types: words('int str float bool list dict set tuple bytes object complex frozenset bytearray'),
  capitalTypes: true,
  decorators: true,
  stringPrefixes: words('r f b u rb br fr rf'),
};

export const GO: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: [{ open: '`', multiline: true, escapes: false }, ...LINE_STRINGS],
  keywords: words(
    'break case chan const continue default defer else fallthrough for func go goto if import interface map package ' +
      'range return select struct switch type var',
  ),
  constants: words('true false nil iota'),
  types: words(
    'bool byte complex64 complex128 error float32 float64 int int8 int16 int32 int64 rune string uint uint8 uint16 ' +
      'uint32 uint64 uintptr any comparable',
  ),
};

export const RUST: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: [{ open: '"', multiline: true, escapes: true }],
  keywords: words(
    'as async await break const continue crate dyn else enum extern fn for if impl in let loop match mod move mut ' +
      'pub ref return self Self static struct super trait type unsafe use where while',
  ),
  constants: words('true false'),
  types: words('bool char str i8 i16 i32 i64 i128 isize u8 u16 u32 u64 u128 usize f32 f64'),
  capitalTypes: true,
  rust: true,
};

export const JAVA: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: [{ open: '"""', multiline: true, escapes: true }, ...LINE_STRINGS],
  keywords: words(
    'abstract assert break case catch class const continue default do else enum extends final finally for goto if ' +
      'implements import instanceof interface native new package private protected public return static strictfp ' +
      'super switch synchronized this throw throws transient try volatile while record sealed permits yield',
  ),
  constants: words('true false null'),
  types: words('boolean byte char double float int long short void var'),
  capitalTypes: true,
  decorators: true,
};

const C_KEYWORDS =
  'auto break case const continue default do else enum extern for goto if inline register restrict return sizeof ' +
  'static struct switch typedef union volatile while';

const C_TYPES =
  'void char short int long float double signed unsigned size_t ssize_t int8_t int16_t int32_t int64_t uint8_t ' +
  'uint16_t uint32_t uint64_t intptr_t uintptr_t ptrdiff_t FILE';

export const C: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: LINE_STRINGS,
  keywords: words(C_KEYWORDS),
  constants: words('NULL true false'),
  types: words(`${C_TYPES} bool`),
  preprocessor: true,
  numberQuotes: true,
};

export const CPP: Profile = {
  ...C,
  keywords: words(
    `${C_KEYWORDS} class namespace template typename public private protected virtual override final new delete ` +
      'this using try catch throw constexpr consteval constinit noexcept static_cast dynamic_cast reinterpret_cast ' +
      'const_cast explicit friend operator mutable decltype co_await co_return co_yield concept requires',
  ),
  constants: words('NULL nullptr true false'),
  types: words(
    `${C_TYPES} bool wchar_t char8_t char16_t char32_t string vector map set array unique_ptr shared_ptr`,
  ),
  capitalTypes: true,
};

export const CSHARP: Profile = {
  lineComments: SLASH_COMMENTS,
  blockComments: C_BLOCK,
  strings: [
    { open: '"""', multiline: true, escapes: false },
    { open: '@"', close: '"', multiline: true, escapes: false },
    ...LINE_STRINGS,
  ],
  keywords: words(
    'abstract as base break case catch checked class const continue default delegate do else enum event explicit ' +
      'extern finally fixed for foreach goto if implicit in interface internal is lock namespace new operator out ' +
      'override params private protected public readonly ref return sealed sizeof stackalloc static struct switch ' +
      'this throw try typeof unchecked unsafe using virtual volatile while async await record init required yield',
  ),
  constants: words('true false null'),
  types: words(
    'bool byte char decimal double float int long object sbyte short string uint ulong ushort void dynamic var',
  ),
  capitalTypes: true,
  pascalCalls: true,
  preprocessor: true,
};

export const SQL: Profile = {
  lineComments: ['--'],
  blockComments: C_BLOCK,
  strings: [
    { open: "'", multiline: true, escapes: false },
    // `"name"` and a backtick name quote an identifier: a name, not a keyword and not a string.
    { open: '"', multiline: false, escapes: false, token: 'property' },
    { open: '`', multiline: false, escapes: false, token: 'property' },
  ],
  keywords: words(
    'select from where and or not insert into values update set delete create table alter drop add column index ' +
      'view join left right inner outer full cross natural on using group by order having limit offset union all ' +
      'distinct intersect except as case when then else end is in like ilike between exists primary key foreign ' +
      'references constraint default unique check begin commit rollback transaction with recursive returning asc ' +
      'desc truncate grant revoke if replace function procedure trigger database schema cascade restrict explain ' +
      'analyze over partition window rows range unbounded preceding following for to returns language',
  ),
  constants: words('null true false'),
  types: words(
    'int integer bigint smallint tinyint varchar char text boolean bool date time timestamp timestamptz interval ' +
      'numeric decimal float real double serial bigserial uuid json jsonb bytea blob',
  ),
  foldCase: true,
};

export const DOCKERFILE: Profile = {
  lineComments: ['#'],
  blockComments: [],
  strings: LINE_STRINGS,
  keywords: words(
    'FROM RUN CMD LABEL MAINTAINER EXPOSE ENV ADD COPY ENTRYPOINT VOLUME USER WORKDIR ARG ONBUILD STOPSIGNAL ' +
      'HEALTHCHECK SHELL AS',
  ),
  constants: NONE,
  types: NONE,
};
