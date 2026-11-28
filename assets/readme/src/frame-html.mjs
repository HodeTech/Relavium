// A real terminal frame (cells) -> one HTML page: a pastel "terminal window" mock with a caption under it.
// The TEXT and its LAYOUT are the application's; only the colours are this theme's.

export const THEME = {
  page: '#F5F2FC',
  window: '#FEFDFF',
  windowBorder: '#E2DCF2',
  titleBar: '#F3F0FA',
  titleText: '#8B87A6',
  dots: ['#F2B8BD', '#F2DFA6', '#B6E0C8'],
  ink: '#3D3A55',
  dim: '#8A86A4',
  accent: '#6F8FDB', // the app's cyan
  accentDim: '#9A93E3', // the app's dim cyan (wordmark, rails)
  amber: '#C98750', // the app's yellow
  highlight: '#E5DEFB', // the app's inverse (a selected row)
  mint: '#4FA383',
  lavender: '#8B7BE0',
  faint: '#BDB8D6',
  keyBg: '#FCEADF',
  keyInk: '#B4673B',
  captionBg: '#ECE7FA',
  captionInk: '#4A4668',
  captionNum: '#8B7BE0',
};

const FONT_MONO = `Menlo, "SF Mono", ui-monospace, Consolas, "DejaVu Sans Mono", monospace`;
const FONT_SANS = `-apple-system, "SF Pro Text", "Segoe UI", Helvetica, Arial, sans-serif`;

/** Design-layer tints for the marks the screens draw; the application gives these no colour of its own. */
const MARK_TINT = new Map([
  ['✓', THEME.mint],
  ['◉', THEME.lavender],
  ['○', THEME.faint],
  ['›', THEME.lavender],
  ['▸', THEME.amber],
  ['✻', THEME.lavender],
]);

const esc = (s) => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

function colourOf(cell) {
  if (cell.fg === 'cyan') return cell.dim ? THEME.accentDim : THEME.accent;
  if (cell.fg === 'yellow') return THEME.amber;
  if (cell.fg === 'green') return THEME.mint;
  return cell.dim ? THEME.dim : THEME.ink;
}

/** Cells of one row -> HTML, with `[Key]` tokens drawn as small pills and every non-ASCII cell on a fixed one-column box. */
export function rowHtml(row) {
  const text = row.map((c) => c.ch).join('');
  const inToken = new Array(row.length).fill(false);
  for (const m of text.matchAll(/\[[A-Za-z0-9+/]{1,12}\]/g))
    for (let k = m.index; k < m.index + m[0].length; k += 1) inToken[k] = true;
  let out = '';
  row.forEach((cell, k) => {
    let colour = MARK_TINT.get(cell.ch) ?? colourOf(cell);
    let style = `color:${colour}`;
    let cls = 'c';
    if (cell.inverse) {
      style = `color:${THEME.ink};background:${THEME.highlight}`;
    } else if (inToken[k]) {
      style = `color:${THEME.keyInk};background:${THEME.keyBg}`;
    }
    if (cell.bold) style += ';font-weight:700';
    const ascii = cell.ch.codePointAt(0) < 128;
    cls += ascii ? '' : ' w';
    out += `<span class="${cls}" style="${style}">${cell.ch === ' ' ? '&nbsp;' : esc(cell.ch)}</span>`;
  });
  return `<div class="row">${out}</div>`;
}

/**
 * @param {{ grid: import('./ansi.mjs').Cell[][], title: string, caption: { step: number, text: string }, width: number, height: number }} f
 */
export function frameHtml(f) {
  const rows = f.grid.map((row) => rowHtml(row)).join('');
  const dots = THEME.dots.map((c) => `<i style="background:${c}"></i>`).join('');
  return `<!doctype html><meta charset="utf-8"><title>frame</title>
<style>
  html,body{margin:0;padding:0;background:${THEME.page}}
  body{width:${f.width}px;height:${f.height}px;position:relative;overflow:hidden;font-family:${FONT_SANS}}
  .win{position:absolute;left:40px;top:34px;width:${f.width - 80}px;background:${THEME.window};border:1px solid ${THEME.windowBorder};border-radius:14px;overflow:hidden}
  .bar{height:38px;background:${THEME.titleBar};border-bottom:1px solid ${THEME.windowBorder};position:relative}
  .bar i{position:absolute;top:13px;width:12px;height:12px;border-radius:6px}
  .bar i:nth-child(1){left:18px}.bar i:nth-child(2){left:38px}.bar i:nth-child(3){left:58px}
  .bar b{position:absolute;left:0;right:0;top:0;line-height:38px;text-align:center;font:500 13px/38px ${FONT_SANS};color:${THEME.titleText};letter-spacing:.02em}
  .term{padding:16px 22px 18px 22px;font:16px/20px ${FONT_MONO};color:${THEME.ink};font-variant-ligatures:none}
  .row{height:20px;white-space:pre;display:block}
  .c{display:inline-block;width:1ch;text-align:left}
  .w{width:1ch;overflow:visible;text-align:center}
  .cap{position:absolute;left:0;right:0;bottom:22px;text-align:center}
  .cap span{display:inline-block;background:${THEME.captionBg};color:${THEME.captionInk};border-radius:999px;padding:9px 20px 9px 12px;font:500 15px/20px ${FONT_SANS}}
  .cap em{display:inline-block;font-style:normal;background:${THEME.window};color:${THEME.captionNum};border-radius:999px;min-width:22px;height:22px;line-height:22px;text-align:center;margin-right:10px;font-weight:700;font-size:13px}
</style>
<div class="win"><div class="bar">${dots}<b>${esc(f.title)}</b></div><div class="term">${rows}</div></div>
<div class="cap"><span><em>${f.caption.step}</em>${esc(f.caption.text)}</span></div>`;
}
