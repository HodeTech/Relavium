/**
 * The EVIDENCE for the joins the layout's measure keeps at `string-width`'s count (MVP-11 unit 9, review round 5, R5-S-4: `viewport.ts`
 * `isTmuxJoin`), measured on tmux 3.7b, the reference terminal, as every other table here is (each string written to a pane after an `A`, the
 * cursor read back with `ESC[6n`: the reviewers' `measure.py`). The measure counts EVERY cluster of several code points as the sum of its code
 * points unless it is one of these joins, so the guarantee rests on this list being right; it is finite, and it was measured exhaustively:
 *
 * - every recommended emoji presentation sequence of this runtime (a code point and U+FE0F: 207), keycap (12), flag (259), subdivision flag
 *   (3, found among 87,880 tag codes tried) and untoned zero-width-joiner sequence (248, found by a search over every pictograph with and without
 *   U+FE0F: pairs, triples over their members, quads over theirs, and every pictograph inserted into every sequence found, which reaches the three
 *   kisses: review round 6, I-1): tmux drew EVERY one of them exactly two columns, as `string-width` counts it;
 * - every recommended modifier sequence (a base and a tone: 665): NOT a join the measure keeps; tmux drew 315 of them wider than `string-width`
 *   (`☝🏽` four columns), so they count the sum (the screen's filter drops every tone anyway);
 * - Hangul: every precomposed syllable with a final after it (11,172), every LV syllable with a vowel after it (399), the modern leading x vowel x
 *   final product (11,172), every leading jamo (modern and extended) with representative vowels and finals (6,076), every vowel with every final after
 *   a leading jamo (12,878) and 20,000 random one-cluster runs (seed 6601; the fillers U+115F and U+1160 left out: the filter drops them): 61,697
 *   strings, `string-width` never below what tmux drew (49,291 exact; tmux draws a vowel or a final with no leading jamo in no column at all);
 * - a base and code points tmux draws in no column: every code point the segmenter joins after a letter (2,619), measured after `a`, after `a`
 *   with a combining acute, after `क` and after `😀`: {@link TMUX_ZERO_AFTER_A_LETTER} are the 2,605 tmux drew in no column in all four contexts,
 *   and `string-width` counts each of them 0 alone, so the sum of such a cluster is its base's count and needs no entry of its own;
 *   {@link TMUX_JOINING_WIDER} are the other 14 (U+FE0F, which the sum widens a cell for; the Thai and Lao AM and the halfwidth sound marks, which
 *   the sum counts; the tones and the wide tone marks, which the filter drops).
 *
 * {@link whitelistStrings} rebuilds every one of those strings in this runtime (the order and the seed are the measurement's), so they can be
 * written out and measured again; `terminal-widths.test.ts` holds the counts to it.
 */

import { yieldToRunner } from '../event-loop.test-support.js';

/** The code points tmux 3.7b drew in no column after a letter, a letter and a mark, a consonant and an emoji (2,605 of them), as ranges. */
export const TMUX_ZERO_AFTER_A_LETTER: readonly (readonly [number, number])[] = [
  [0x300, 0x36f],
  [0x483, 0x489],
  [0x591, 0x5bd],
  [0x5bf, 0x5bf],
  [0x5c1, 0x5c2],
  [0x5c4, 0x5c5],
  [0x5c7, 0x5c7],
  [0x610, 0x61a],
  [0x64b, 0x65f],
  [0x670, 0x670],
  [0x6d6, 0x6dc],
  [0x6df, 0x6e4],
  [0x6e7, 0x6e8],
  [0x6ea, 0x6ed],
  [0x711, 0x711],
  [0x730, 0x74a],
  [0x7a6, 0x7b0],
  [0x7eb, 0x7f3],
  [0x7fd, 0x7fd],
  [0x816, 0x819],
  [0x81b, 0x823],
  [0x825, 0x827],
  [0x829, 0x82d],
  [0x859, 0x85b],
  [0x897, 0x89f],
  [0x8ca, 0x8e1],
  [0x8e3, 0x903],
  [0x93a, 0x93c],
  [0x93e, 0x94f],
  [0x951, 0x957],
  [0x962, 0x963],
  [0x981, 0x983],
  [0x9bc, 0x9bc],
  [0x9be, 0x9c4],
  [0x9c7, 0x9c8],
  [0x9cb, 0x9cd],
  [0x9d7, 0x9d7],
  [0x9e2, 0x9e3],
  [0x9fe, 0x9fe],
  [0xa01, 0xa03],
  [0xa3c, 0xa3c],
  [0xa3e, 0xa42],
  [0xa47, 0xa48],
  [0xa4b, 0xa4d],
  [0xa51, 0xa51],
  [0xa70, 0xa71],
  [0xa75, 0xa75],
  [0xa81, 0xa83],
  [0xabc, 0xabc],
  [0xabe, 0xac5],
  [0xac7, 0xac9],
  [0xacb, 0xacd],
  [0xae2, 0xae3],
  [0xafa, 0xaff],
  [0xb01, 0xb03],
  [0xb3c, 0xb3c],
  [0xb3e, 0xb44],
  [0xb47, 0xb48],
  [0xb4b, 0xb4d],
  [0xb55, 0xb57],
  [0xb62, 0xb63],
  [0xb82, 0xb82],
  [0xbbe, 0xbc2],
  [0xbc6, 0xbc8],
  [0xbca, 0xbcd],
  [0xbd7, 0xbd7],
  [0xc00, 0xc04],
  [0xc3c, 0xc3c],
  [0xc3e, 0xc44],
  [0xc46, 0xc48],
  [0xc4a, 0xc4d],
  [0xc55, 0xc56],
  [0xc62, 0xc63],
  [0xc81, 0xc83],
  [0xcbc, 0xcbc],
  [0xcbe, 0xcc4],
  [0xcc6, 0xcc8],
  [0xcca, 0xccd],
  [0xcd5, 0xcd6],
  [0xce2, 0xce3],
  [0xcf3, 0xcf3],
  [0xd00, 0xd03],
  [0xd3b, 0xd3c],
  [0xd3e, 0xd44],
  [0xd46, 0xd48],
  [0xd4a, 0xd4d],
  [0xd57, 0xd57],
  [0xd62, 0xd63],
  [0xd81, 0xd83],
  [0xdca, 0xdca],
  [0xdcf, 0xdd4],
  [0xdd6, 0xdd6],
  [0xdd8, 0xddf],
  [0xdf2, 0xdf3],
  [0xe31, 0xe31],
  [0xe34, 0xe3a],
  [0xe47, 0xe4e],
  [0xeb1, 0xeb1],
  [0xeb4, 0xebc],
  [0xec8, 0xece],
  [0xf18, 0xf19],
  [0xf35, 0xf35],
  [0xf37, 0xf37],
  [0xf39, 0xf39],
  [0xf3e, 0xf3f],
  [0xf71, 0xf84],
  [0xf86, 0xf87],
  [0xf8d, 0xf97],
  [0xf99, 0xfbc],
  [0xfc6, 0xfc6],
  [0x102d, 0x1037],
  [0x1039, 0x103e],
  [0x1056, 0x1059],
  [0x105e, 0x1060],
  [0x1071, 0x1074],
  [0x1082, 0x1082],
  [0x1084, 0x1086],
  [0x108d, 0x108d],
  [0x109d, 0x109d],
  [0x135d, 0x135f],
  [0x1712, 0x1715],
  [0x1732, 0x1734],
  [0x1752, 0x1753],
  [0x1772, 0x1773],
  [0x17b4, 0x17d3],
  [0x17dd, 0x17dd],
  [0x180b, 0x180d],
  [0x180f, 0x180f],
  [0x1885, 0x1886],
  [0x18a9, 0x18a9],
  [0x1920, 0x192b],
  [0x1930, 0x193b],
  [0x1a17, 0x1a1b],
  [0x1a55, 0x1a5e],
  [0x1a60, 0x1a60],
  [0x1a62, 0x1a62],
  [0x1a65, 0x1a7c],
  [0x1a7f, 0x1a7f],
  [0x1ab0, 0x1add],
  [0x1ae0, 0x1aeb],
  [0x1b00, 0x1b04],
  [0x1b34, 0x1b44],
  [0x1b6b, 0x1b73],
  [0x1b80, 0x1b82],
  [0x1ba1, 0x1bad],
  [0x1be6, 0x1bf3],
  [0x1c24, 0x1c37],
  [0x1cd0, 0x1cd2],
  [0x1cd4, 0x1ce8],
  [0x1ced, 0x1ced],
  [0x1cf4, 0x1cf4],
  [0x1cf7, 0x1cf9],
  [0x1dc0, 0x1dff],
  [0x200c, 0x200d],
  [0x20d0, 0x20f0],
  [0x2cef, 0x2cf1],
  [0x2d7f, 0x2d7f],
  [0x2de0, 0x2dff],
  [0x302a, 0x302d],
  [0x3099, 0x309a],
  [0xa66f, 0xa672],
  [0xa674, 0xa67d],
  [0xa69e, 0xa69f],
  [0xa6f0, 0xa6f1],
  [0xa802, 0xa802],
  [0xa806, 0xa806],
  [0xa80b, 0xa80b],
  [0xa823, 0xa827],
  [0xa82c, 0xa82c],
  [0xa880, 0xa881],
  [0xa8b4, 0xa8c5],
  [0xa8e0, 0xa8f1],
  [0xa8ff, 0xa8ff],
  [0xa926, 0xa92d],
  [0xa947, 0xa953],
  [0xa980, 0xa983],
  [0xa9b3, 0xa9c0],
  [0xa9e5, 0xa9e5],
  [0xaa29, 0xaa36],
  [0xaa43, 0xaa43],
  [0xaa4c, 0xaa4d],
  [0xaa7c, 0xaa7c],
  [0xaab0, 0xaab0],
  [0xaab2, 0xaab4],
  [0xaab7, 0xaab8],
  [0xaabe, 0xaabf],
  [0xaac1, 0xaac1],
  [0xaaeb, 0xaaef],
  [0xaaf5, 0xaaf6],
  [0xabe3, 0xabea],
  [0xabec, 0xabed],
  [0xfb1e, 0xfb1e],
  [0xfe00, 0xfe0e],
  [0xfe20, 0xfe2f],
  [0x101fd, 0x101fd],
  [0x102e0, 0x102e0],
  [0x10376, 0x1037a],
  [0x10a01, 0x10a03],
  [0x10a05, 0x10a06],
  [0x10a0c, 0x10a0f],
  [0x10a38, 0x10a3a],
  [0x10a3f, 0x10a3f],
  [0x10ae5, 0x10ae6],
  [0x10d24, 0x10d27],
  [0x10d69, 0x10d6d],
  [0x10eab, 0x10eac],
  [0x10efa, 0x10eff],
  [0x10f46, 0x10f50],
  [0x10f82, 0x10f85],
  [0x11000, 0x11002],
  [0x11038, 0x11046],
  [0x11070, 0x11070],
  [0x11073, 0x11074],
  [0x1107f, 0x11082],
  [0x110b0, 0x110ba],
  [0x110c2, 0x110c2],
  [0x11100, 0x11102],
  [0x11127, 0x11134],
  [0x11145, 0x11146],
  [0x11173, 0x11173],
  [0x11180, 0x11182],
  [0x111b3, 0x111c0],
  [0x111c9, 0x111cc],
  [0x111ce, 0x111cf],
  [0x1122c, 0x11237],
  [0x1123e, 0x1123e],
  [0x11241, 0x11241],
  [0x112df, 0x112ea],
  [0x11300, 0x11303],
  [0x1133b, 0x1133c],
  [0x1133e, 0x11344],
  [0x11347, 0x11348],
  [0x1134b, 0x1134d],
  [0x11357, 0x11357],
  [0x11362, 0x11363],
  [0x11366, 0x1136c],
  [0x11370, 0x11374],
  [0x113b8, 0x113c0],
  [0x113c2, 0x113c2],
  [0x113c5, 0x113c5],
  [0x113c7, 0x113ca],
  [0x113cc, 0x113d0],
  [0x113d2, 0x113d2],
  [0x113e1, 0x113e2],
  [0x11435, 0x11446],
  [0x1145e, 0x1145e],
  [0x114b0, 0x114c3],
  [0x115af, 0x115b5],
  [0x115b8, 0x115c0],
  [0x115dc, 0x115dd],
  [0x11630, 0x11640],
  [0x116ab, 0x116b7],
  [0x1171d, 0x1171f],
  [0x11722, 0x1172b],
  [0x1182c, 0x1183a],
  [0x11930, 0x11935],
  [0x11937, 0x11938],
  [0x1193b, 0x1193e],
  [0x11940, 0x11940],
  [0x11942, 0x11943],
  [0x119d1, 0x119d7],
  [0x119da, 0x119e0],
  [0x119e4, 0x119e4],
  [0x11a01, 0x11a0a],
  [0x11a33, 0x11a39],
  [0x11a3b, 0x11a3e],
  [0x11a47, 0x11a47],
  [0x11a51, 0x11a5b],
  [0x11a8a, 0x11a99],
  [0x11b60, 0x11b67],
  [0x11c2f, 0x11c36],
  [0x11c38, 0x11c3f],
  [0x11c92, 0x11ca7],
  [0x11ca9, 0x11cb6],
  [0x11d31, 0x11d36],
  [0x11d3a, 0x11d3a],
  [0x11d3c, 0x11d3d],
  [0x11d3f, 0x11d45],
  [0x11d47, 0x11d47],
  [0x11d8a, 0x11d8e],
  [0x11d90, 0x11d91],
  [0x11d93, 0x11d97],
  [0x11ef3, 0x11ef6],
  [0x11f00, 0x11f01],
  [0x11f03, 0x11f03],
  [0x11f34, 0x11f3a],
  [0x11f3e, 0x11f42],
  [0x11f5a, 0x11f5a],
  [0x13440, 0x13440],
  [0x13447, 0x13455],
  [0x1611e, 0x1612f],
  [0x16af0, 0x16af4],
  [0x16b30, 0x16b36],
  [0x16f4f, 0x16f4f],
  [0x16f51, 0x16f87],
  [0x16f8f, 0x16f92],
  [0x16fe4, 0x16fe4],
  [0x1bc9d, 0x1bc9e],
  [0x1cf00, 0x1cf2d],
  [0x1cf30, 0x1cf46],
  [0x1d165, 0x1d169],
  [0x1d16d, 0x1d172],
  [0x1d17b, 0x1d182],
  [0x1d185, 0x1d18b],
  [0x1d1aa, 0x1d1ad],
  [0x1d242, 0x1d244],
  [0x1da00, 0x1da36],
  [0x1da3b, 0x1da6c],
  [0x1da75, 0x1da75],
  [0x1da84, 0x1da84],
  [0x1da9b, 0x1da9f],
  [0x1daa1, 0x1daaf],
  [0x1e000, 0x1e006],
  [0x1e008, 0x1e018],
  [0x1e01b, 0x1e021],
  [0x1e023, 0x1e024],
  [0x1e026, 0x1e02a],
  [0x1e08f, 0x1e08f],
  [0x1e130, 0x1e136],
  [0x1e2ae, 0x1e2ae],
  [0x1e2ec, 0x1e2ef],
  [0x1e4ec, 0x1e4ef],
  [0x1e5ee, 0x1e5ef],
  [0x1e6e3, 0x1e6e3],
  [0x1e6e6, 0x1e6e6],
  [0x1e6ee, 0x1e6ef],
  [0x1e6f5, 0x1e6f5],
  [0x1e8d0, 0x1e8d6],
  [0x1e944, 0x1e94a],
  [0xe0020, 0xe007f],
  [0xe0100, 0xe01ef],
];

/** The code points that join a letter and that tmux 3.7b drew in columns after it: each with what it added after `a`. */
export const TMUX_JOINING_WIDER: readonly (readonly [number, number])[] = [
  [0x0e33, 1],
  [0x0eb3, 1],
  [0x302e, 2],
  [0x302f, 2],
  [0xfe0f, 1],
  [0xff9e, 1],
  [0xff9f, 1],
  [0x16ff0, 2],
  [0x16ff1, 2],
  [0x1f3fb, 2],
  [0x1f3fc, 2],
  [0x1f3fd, 2],
  [0x1f3fe, 2],
  [0x1f3ff, 2],
];

/** What the measurement found for each class of {@link whitelistStrings}: strings, and how many tmux drew exactly as `string-width` counts. */
export const TMUX_WHITELIST_EVIDENCE = {
  presentation: { strings: 207, exact: 207 },
  keycap: { strings: 12, exact: 12 },
  flag: { strings: 259, exact: 259 },
  tagFlag: { strings: 3, exact: 3 },
  zwj: { strings: 248, exact: 248 },
  modifier: { strings: 665, wider: 315 },
  hangul: { strings: 61_697, exact: 49_291, wider: 0 },
} as const;

const RGI = new RegExp('^\\p{RGI_Emoji}$', 'v');
const c = (...codes: readonly number[]): string => String.fromCodePoint(...codes);

/** The tag codes searched for a subdivision flag: `gb` and every three letters, and every three letters with nothing or `a` to `c` after them. */
function* tagCodes(): Generator<string> {
  const letters = 'abcdefghijklmnopqrstuvwxyz';
  for (const x of letters) for (const y of letters) for (const z of letters) yield `gb${x}${y}${z}`;
  for (const x of letters)
    for (const y of letters)
      for (const z of letters) for (const w of ['', 'a', 'b', 'c']) yield `${x}${y}${z}${w}`;
}

/** Every untoned recommended zero-width-joiner sequence of this runtime (the search of the module header). */
async function zwjSequences(): Promise<string[]> {
  const joiner = c(0x200d);
  const pictographs: string[] = [];
  for (let code = 0x20; code <= 0x1ffff; code += 1) {
    await yieldToRunner();
    const ch = c(code);
    if (/\p{Extended_Pictographic}/u.test(ch) && /\p{Emoji}/u.test(ch))
      pictographs.push(ch, `${ch}${c(0xfe0f)}`);
  }
  const found = new Set<string>();
  const members = new Set<string>();
  for (const a of pictographs) {
    await yieldToRunner();
    for (const b of pictographs)
      if (RGI.test(`${a}${joiner}${b}`)) {
        found.add(`${a}${joiner}${b}`);
        members.add(a);
        members.add(b);
      }
  }
  const second = [...members];
  const third = new Set<string>();
  for (const a of second) {
    await yieldToRunner();
    for (const b of second)
      for (const d of second)
        if (RGI.test(`${a}${joiner}${b}${joiner}${d}`)) {
          found.add(`${a}${joiner}${b}${joiner}${d}`);
          third.add(a).add(b).add(d);
        }
  }
  const fourth = [...third];
  for (const a of fourth) {
    await yieldToRunner();
    for (const b of fourth)
      for (const d of fourth)
        for (const e of fourth)
          if (RGI.test(`${a}${joiner}${b}${joiner}${d}${joiner}${e}`))
            found.add(`${a}${joiner}${b}${joiner}${d}${joiner}${e}`);
  }
  // review round 6 (I-1): a sequence with a member no smaller sequence holds (a kiss: `💋` inserted into a couple with a heart) is reached by
  // inserting every pictograph at every place of every sequence found, until nothing new is found (four members at most)
  let frontier = [...found];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const sequence of frontier) {
      await yieldToRunner();
      const parts = sequence.split(joiner);
      if (parts.length >= 4) continue;
      for (let at = 0; at <= parts.length; at += 1)
        for (const form of pictographs) {
          const candidate = [...parts.slice(0, at), form, ...parts.slice(at)].join(joiner);
          if (!found.has(candidate) && RGI.test(candidate)) {
            found.add(candidate);
            next.push(candidate);
          }
        }
    }
    frontier = next;
  }
  return [...found];
}

/** The Hangul strings of the measurement (see the module header), in its order and with its seed. */
async function hangulStrings(): Promise<string[]> {
  const out: string[] = [];
  for (let code = 0xac00; code <= 0xd7a3; code += 1) {
    await yieldToRunner();
    out.push(c(code, 0x11a8));
    if ((code - 0xac00) % 28 === 0) out.push(c(code, 0x1161));
  }
  for (let l = 0x1100; l <= 0x1112; l += 1)
    for (let v = 0x1161; v <= 0x1175; v += 1)
      for (let t = 0x11a7; t <= 0x11c2; t += 1) out.push(t === 0x11a7 ? c(l, v) : c(l, v, t));
  const leading: number[] = [];
  for (let l = 0x1100; l <= 0x115e; l += 1) leading.push(l);
  for (let l = 0xa960; l <= 0xa97c; l += 1) leading.push(l);
  const vowels: number[] = [];
  for (let v = 0x1161; v <= 0x11a7; v += 1) vowels.push(v);
  for (let v = 0xd7b0; v <= 0xd7c6; v += 1) vowels.push(v);
  const finals: number[] = [];
  for (let t = 0x11a8; t <= 0x11ff; t += 1) finals.push(t);
  for (let t = 0xd7cb; t <= 0xd7fb; t += 1) finals.push(t);
  for (const l of leading)
    for (const v of [0x1161, 0x1169, 0x1175, 0x1176, 0x11a7, 0xd7b0, 0xd7c6])
      for (const t of [0, 0x11a8, 0x11c2, 0x11c3, 0x11ff, 0xd7cb, 0xd7fb])
        out.push(t === 0 ? c(l, v) : c(l, v, t));
  for (const v of vowels) for (const t of finals) out.push(c(0x1100, v, t));
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const alone = (text: string): boolean => [...segmenter.segment(text)].length === 1;
  let state = 6601 >>> 0;
  const random = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = [...leading, ...vowels, ...finals, 0xac00, 0xac01, 0xd7a3, 0xb098, 0xb2e4].filter(
    (code) => code !== 0x115f && code !== 0x1160,
  );
  for (let runs = 0; runs < 20_000; ) {
    await yieldToRunner();
    const length = 2 + Math.floor(random() * 5);
    const text = c(
      ...Array.from({ length }, () => pool[Math.floor(random() * pool.length)] ?? 0x1100),
    );
    if (!alone(text)) continue;
    out.push(text);
    runs += 1;
  }
  return out;
}

type WhitelistStrings = Readonly<Record<keyof typeof TMUX_WHITELIST_EVIDENCE, readonly string[]>>;

let measured: Promise<WhitelistStrings> | undefined;

/**
 * Every string of the whitelist's measurement, by class (see the module header). The search takes seconds, so it runs once per test file and
 * its strings are shared read-only, and it lets the event loop turn as it goes (`../event-loop.test-support.ts`): run in one piece it kept a
 * worker from the test runner past its 60-second call timeout on CI.
 */
export function whitelistStrings(): Promise<WhitelistStrings> {
  measured ??= searchWhitelistStrings();
  return measured;
}

async function searchWhitelistStrings(): Promise<WhitelistStrings> {
  const presentation: string[] = [];
  const modifier: string[] = [];
  for (let code = 0x20; code <= 0x1ffff; code += 1) {
    await yieldToRunner();
    if (RGI.test(c(code, 0xfe0f))) presentation.push(c(code, 0xfe0f));
    for (let tone = 0x1f3fb; tone <= 0x1f3ff; tone += 1)
      if (RGI.test(c(code, tone))) modifier.push(c(code, tone));
  }
  const flag: string[] = [];
  for (let a = 0x1f1e6; a <= 0x1f1ff; a += 1)
    for (let b = 0x1f1e6; b <= 0x1f1ff; b += 1) if (RGI.test(c(a, b))) flag.push(c(a, b));
  const tagFlag: string[] = [];
  for (const code of tagCodes()) {
    await yieldToRunner();
    const text = c(0x1f3f4, ...[...code].map((ch) => 0xe0000 + (ch.codePointAt(0) ?? 0)), 0xe007f);
    if (RGI.test(text)) tagFlag.push(text);
  }
  const zwj = await zwjSequences();
  const hangul = await hangulStrings();
  return {
    presentation,
    keycap: [...'0123456789#*'].map((key) => `${key}${c(0xfe0f, 0x20e3)}`),
    flag,
    tagFlag,
    zwj,
    modifier,
    hangul,
  };
}

/**
 * What the measurement of {@link inContextStrings} found, each string through the screen's filter and measured on tmux 3.7b as the other tables were:
 * no string the layout counts narrower than tmux drew it. Before this round's filter (a joiner after U+FE0E or U+20E3 kept), 148 of them were, every
 * one in those 28 contexts and every one a sequence holding U+FE0F: one column short each (review round 6, R6-S-1).
 */
export const TMUX_IN_CONTEXT_EVIDENCE = {
  contexts: 44,
  sequences: 729,
  strings: 32_076,
  exact: 24_958,
  over: 7_118,
  under: 0,
} as const;

/**
 * The joins IN CONTEXT (review round 6, R6-S-1): every recommended sequence the whitelist keeps (presentation, keycap, flag, subdivision flag and
 * zero-width-joiner sequences: {@link whitelistStrings}) after each of 44 contexts, the measurement's: a letter with 0 to 13 combining marks and then
 * U+FE0E and a joiner, the same with U+20E3, and a letter, a space, a consonant, a consonant and its virama (and a joiner), an Arabic letter and a
 * joiner, a flag, a lone regional indicator, a keycap, a Hangul syllable, a leading jamo, an emoji and a joiner, a letter with five marks and a
 * joiner, and the sequence itself two, five and twenty times. The strings, filtered as the screen filters them, were measured on tmux:
 * {@link TMUX_IN_CONTEXT_EVIDENCE}.
 */
export async function inContextStrings(): Promise<(readonly [string, string])[]> {
  const w = await whitelistStrings();
  const sequences = [...w.presentation, ...w.keycap, ...w.flag, ...w.tagFlag, ...w.zwj];
  const marks = (count: number): string => c(0x301).repeat(count);
  const joiner = c(0x200d);
  const contexts: (readonly [string, (sequence: string) => string])[] = [];
  for (let count = 0; count <= 13; count += 1) {
    contexts.push([`vs15 ${String(count)}`, (q) => `a${marks(count)}${c(0xfe0e)}${joiner}${q}`]);
    contexts.push([
      `keycap mark ${String(count)}`,
      (q) => `a${marks(count)}${c(0x20e3)}${joiner}${q}`,
    ]);
  }
  contexts.push(
    ['letter', (q) => `a${q}`],
    ['space', (q) => ` ${q}`],
    ['consonant', (q) => `${c(0x915)}${q}`],
    ['consonant virama', (q) => `${c(0x915, 0x94d)}${q}`],
    ['consonant virama joiner', (q) => `${c(0x915, 0x94d)}${joiner}${q}`],
    ['Arabic joiner', (q) => `${c(0x628)}${joiner}${q}`],
    ['flag', (q) => `${c(0x1f1fa, 0x1f1f8)}${q}`],
    ['regional indicator', (q) => `${c(0x1f1fa)}${q}`],
    ['keycap', (q) => `#${c(0xfe0f, 0x20e3)}${q}`],
    ['Hangul syllable', (q) => `${c(0xac01)}${q}`],
    ['leading jamo', (q) => `${c(0x1100)}${q}`],
    ['twice', (q) => q.repeat(2)],
    ['five times', (q) => q.repeat(5)],
    ['twenty times', (q) => q.repeat(20)],
    ['emoji joiner', (q) => `${c(0x1f600)}${joiner}${q}`],
    ['five marks joiner', (q) => `a${marks(5)}${joiner}${q}`],
  );
  const out: (readonly [string, string])[] = [];
  for (const [name, build] of contexts)
    for (const sequence of sequences) out.push([name, build(sequence)]);
  return out;
}
