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

function applySgr(state, params) {
  const codes = params === '' ? [0] : params.split(/[;:]/).map(Number);
  let next = { ...state };
  for (let k = 0; k < codes.length; k += 1) {
    const c = codes[k];
    if (c === 0) next = { fg: undefined, bold: false, dim: false, inverse: false };
    else if (c === 1) next.bold = true;
    else if (c === 2) next.dim = true;
    else if (c === 22) {
      next.bold = false;
      next.dim = false;
    } else if (c === 7) next.inverse = true;
    else if (c === 27) next.inverse = false;
    else if (c === 39) next.fg = undefined;
    else if (c >= 30 && c <= 37) next.fg = BASIC[c - 30];
    else if (c >= 90 && c <= 97) next.fg = `bright-${BASIC[c - 90]}`;
    else if (c === 38) {
      // 38;5;n or 38;2;r;g;b: kept as a tagged string, the theme decides
      if (codes[k + 1] === 5) {
        next.fg = `256:${codes[k + 2]}`;
        k += 2;
      } else if (codes[k + 1] === 2) {
        next.fg = `rgb:${codes[k + 2]},${codes[k + 3]},${codes[k + 4]}`;
        k += 4;
      }
    }
    // background colours (40-47, 48;...) are not used by the screens captured here
  }
  return next;
}
