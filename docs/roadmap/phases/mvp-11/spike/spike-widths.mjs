// MVP-11 Step 1 spike, part 2: how does THIS terminal measure the glyphs the CLI draws?
// It prints each glyph, asks the terminal where the cursor is (CSI 6 n, a cursor position report) and compares
// the answer with the width the renderer assumes (string-width). Run it in any terminal:
//     node spike-widths.mjs [--out report.txt]
import stringWidth from 'string-width';
import { writeFileSync } from 'node:fs';

const GLYPHS = [
  ['◉', 'rail node, new'], ['╌', 'rail dashed'], ['◌', 'pending'], ['✓', 'done'], ['✗', 'failed'], ['⊘', 'skipped'],
  ['⚠', 'warning'], ['↻', 'retry'], ['›', 'speaker marker / selection'], ['▸', 'tool row'], ['○', 'empty node'],
  ['●', 'filled node'], ['◐', 'half node'], ['━', 'heavy rule'], ['─', 'light rule'], ['‖', 'paused (new)'],
  ['▶', 'play'], ['■', 'stop'], ['★', 'star'], ['▲', 'up'], ['▼', 'down'], ['◆', 'diamond'], ['•', 'bullet'],
  ['…', 'ellipsis'], ['→', 'arrow'], ['█', 'cursor block'], ['▌', 'half block'], ['⏸', 'paused (retiring)'],
  ['╭', 'frame'], ['╮', 'frame'], ['╰', 'frame'], ['╯', 'frame'], ['│', 'frame / gutter'], ['·', 'legend separator'],
  ['—', 'em dash'], ['✎', 'host glyph'], ['╿', 'host glyph'],
];
const out = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : undefined;
if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('needs a terminal'); process.exit(2); }

process.stdin.setRawMode(true);
process.stdin.resume();
let buf = '';
let waiter;
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  const m = /\x1b\[(\d+);(\d+)R/.exec(buf);
  if (m && waiter) { const w = waiter; waiter = undefined; buf = buf.slice(m.index + m[0].length); w({ row: +m[1], col: +m[2] }); }
});
const ask = (ms = 1500) => new Promise((res) => {
  waiter = res;
  setTimeout(() => { if (waiter === res) { waiter = undefined; res(undefined); } }, ms);
});

const rows = [];
for (const [g, role] of GLYPHS) {
  process.stdout.write('\r\x1b[2K' + g + '\x1b[6n');
  const pos = await ask();
  rows.push({ g, role, cp: 'U+' + g.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'), assumed: stringWidth(g), measured: pos ? pos.col - 1 : undefined });
}
// a framed line, the way the popup draws one: does the right border land where the renderer thinks?
const probe = '│ ◉ ✓ ⚠ ● ━ ▸ …│';
process.stdout.write('\r\x1b[2K' + probe + '\x1b[6n');
const frame = await ask();
process.stdout.write('\r\x1b[2K');
process.stdin.setRawMode(false);
process.stdin.pause();

const lines = [];
lines.push(`terminal: TERM=${process.env.TERM ?? ''} TERM_PROGRAM=${process.env.TERM_PROGRAM ?? ''} ${process.env.TERM_PROGRAM_VERSION ?? ''} COLORTERM=${process.env.COLORTERM ?? ''} size=${process.stdout.columns}x${process.stdout.rows} LANG=${process.env.LANG ?? ''}`);
lines.push('glyph  codepoint  role                         assumed  measured');
for (const r of rows) lines.push(`${r.g}      ${r.cp}     ${r.role.padEnd(27)}  ${r.assumed}        ${r.measured ?? 'no answer'}${r.measured !== undefined && r.measured !== r.assumed ? '   <-- DIFFERS' : ''}`);
lines.push(`framed probe "${probe}": renderer assumes ${stringWidth(probe)} columns, terminal reports ${frame ? frame.col - 1 : 'no answer'}`);
const differs = rows.filter((r) => r.measured !== undefined && r.measured !== r.assumed).map((r) => r.g);
const silent = rows.filter((r) => r.measured === undefined).length;
lines.push(`SUMMARY: ${rows.length} glyphs, ${differs.length} measured differently from the renderer${differs.length ? ' (' + differs.join(' ') + ')' : ''}, ${silent} unanswered`);
const text = lines.join('\n') + '\n';
process.stdout.write(text);
if (out) writeFileSync(out, text);
