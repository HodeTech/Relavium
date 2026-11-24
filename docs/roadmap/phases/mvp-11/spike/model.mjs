// Pure frame model for the MVP-11 popup spike: what the screen SHOULD show, cell for cell.
import stringWidth from 'string-width';

export const POPUP_W = Number(process.env.SPIKE_W ?? 68);
export const POPUP_H = Number(process.env.SPIKE_H ?? 21);
export const GLYPHS = '◉ ╌ ◌ ✓ ✗ ⊘ ⚠ ↻ › ▸ ○ ● ◐ ━ ─ ‖ ▶ ■ ★ ▲ ▼ ◆ • … → █ ▌';

export function pad(text, width) {
  const w = stringWidth(text);
  if (w > width) throw new Error(`line wider than ${width}: ${text}`);
  return text + ' '.repeat(width - w);
}

export function bodyLines(cols, rows) {
  const out = [];
  const base = 'the quick brown fox jumps over the lazy dog and keeps running through the transcript ';
  for (let i = 0; i < rows - 1; i++) {
    const head = `${String(i + 1).padStart(2, '0')} │ `;
    let line = head + base.repeat(4);
    // keep every body line exactly `cols` wide so a leak is visible
    line = [...line].slice(0, cols).join('');
    out.push(pad(line, cols));
  }
  return out; // rows - 1 lines; the prompt line is separate
}

export const promptLine = (cols) => pad('› type a message, or / for commands', cols);

export function popupLines() {
  const inner = POPUP_W - 2;
  const title = ' Doctor · this machine ';
  const top = '╭─' + title + '─'.repeat(inner - 1 - stringWidth(title)) + '╮';
  const rows = [top];
  const body = [
    ' ● Relavium doctor — nothing leaves this machine',
    '',
    ' ✓ node 22.23.1 · keychain reachable',
    ' ⚠ no provider key yet — /providers adds one',
    ' ✗ models.dev catalogue older than 7 days',
    ' ↻ ' + 'a check is running…',
    '',
    ' glyphs: ' + GLYPHS,
    '',
    ' ▸ Re-check              [r]',
    '   Deep check (network)  [d]',
    '',
    '',
    '',
    '',
    '',
    '',
    '',
    ' Esc close · [r] re-check · [d] deep check',
  ];
  const legend = body.pop();
  while (body.length < POPUP_H - 3) body.push('');
  body.push(legend);
  for (const b of body) rows.push('│' + pad(b, inner) + '│');
  rows.push('╰' + '─'.repeat(inner) + '╯');
  if (rows.length !== POPUP_H) throw new Error(`popup has ${rows.length} rows, want ${POPUP_H}`);
  return rows;
}

export function rect(cols, rows) {
  return { top: Math.floor((rows - POPUP_H) / 2), left: Math.floor((cols - POPUP_W) / 2), width: POPUP_W, height: POPUP_H };
}

/** The later sibling that deliberately covers the popup's middle rows. */
export const OCCLUDER = ' LATER SIBLING (toast) ';
export function occluderRect(cols, rows) {
  const r = rect(cols, rows);
  return { top: r.top + 9, left: r.left + 10, width: stringWidth(OCCLUDER), height: 1 };
}

export function expectedFrame(cols, rows, { popup = false, occluder = false } = {}) {
  const grid = [...bodyLines(cols, rows).map((l) => [...l]), [...promptLine(cols)]];
  if (popup) {
    const r = rect(cols, rows);
    popupLines().forEach((line, i) => {
      [...line].forEach((ch, j) => {
        grid[r.top + i][r.left + j] = ch;
      });
    });
  }
  if (occluder) {
    const o = occluderRect(cols, rows);
    [...OCCLUDER].forEach((ch, j) => {
      grid[o.top][o.left + j] = ch;
    });
  }
  return grid.map((row) => row.join('').replace(/ +$/, ''));
}
