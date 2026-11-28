// Parses the text `tmux capture-pane -p -e` prints (SGR colour sequences and plain characters) into a grid of cells.
// Only what a terminal screen holds: no cursor movement is expected in a capture.

/** @typedef {{ ch: string, fg: string | undefined, bold: boolean, dim: boolean, inverse: boolean }} Cell */

const BASIC = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/** @param {string} text @param {number} cols @param {number} rows @returns {Cell[][]} */
export function parseAnsi(text, cols, rows) {
  const lines = text.replace(/\n$/, '').split('\n');
  /** @type {Cell[][]} */
  const grid = [];
  for (let r = 0; r < rows; r += 1) {
    const line = lines[r] ?? '';
    /** @type {Cell[]} */
    const row = [];
    let state = { fg: undefined, bold: false, dim: false, inverse: false };
    let i = 0;
    while (i < line.length) {
      if (line[i] === '\x1b' && line[i + 1] === '[') {
        const end = line.indexOf('m', i);
        if (end < 0) break;
        state = applySgr(state, line.slice(i + 2, end));
        i = end + 1;
        continue;
      }
      const cp = line.codePointAt(i);
      const ch = String.fromCodePoint(cp);
      row.push({ ch, ...state });
      i += ch.length;
    }
    while (row.length < cols)
      row.push({ ch: ' ', fg: undefined, bold: false, dim: false, inverse: false });
    grid.push(row.slice(0, cols));
  }
  return grid;
}

const PLAIN = { fg: undefined, bold: false, dim: false, inverse: false };

/** Attributes that one SGR code sets or clears on its own. */
const SINGLE = new Map([
  [0, () => ({ ...PLAIN })],
  [1, (st) => ({ ...st, bold: true })],
  [2, (st) => ({ ...st, dim: true })],
  [22, (st) => ({ ...st, bold: false, dim: false })],
  [7, (st) => ({ ...st, inverse: true })],
  [27, (st) => ({ ...st, inverse: false })],
  [39, (st) => ({ ...st, fg: undefined })],
]);

/** A colour code that stands alone (30-37, 90-97), as a name; `undefined` when `c` is not one. */
function basicColour(c) {
  if (c >= 30 && c <= 37) return BASIC[c - 30];
  if (c >= 90 && c <= 97) return `bright-${BASIC[c - 90]}`;
  return undefined;
}

/** The colour of `38;5;n` or `38;2;r;g;b`, kept as a tagged string (the theme decides), and how many codes it used. */
function extendedColour(codes, k) {
  if (codes[k + 1] === 5) return { fg: `256:${codes[k + 2]}`, used: 2 };
  if (codes[k + 1] === 2)
    return { fg: `rgb:${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`, used: 4 };
  return { fg: undefined, used: 0 };
}

function applySgr(state, params) {
  const codes = params === '' ? [0] : params.split(/[;:]/).map(Number);
  let next = { ...state };
  for (let k = 0; k < codes.length; k += 1) {
    const c = codes[k];
    const single = SINGLE.get(c);
    if (single !== undefined) next = single(next);
    else if (basicColour(c) !== undefined) next.fg = basicColour(c);
    else if (c === 38) {
      const { fg, used } = extendedColour(codes, k);
      if (fg !== undefined) next.fg = fg;
      k += used;
    }
    // background colours (40-47, 48;...) are not used by the screens captured here
  }
  return next;
}
