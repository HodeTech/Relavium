// Drives spike-render.mjs inside a private tmux server (a real terminal emulator state) and checks every capture
// against the cell-for-cell model. Prints PASS/FAIL lines and writes the raw captures to ./out/.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { expectedFrame, rect, POPUP_W, POPUP_H } from './model.mjs';

const SOCK = 'mvp11spike';
// The tmux binary by an absolute path (set TMUX_BIN to use another): a program found through PATH is whatever PATH holds first.
const TMUX = process.env.TMUX_BIN ?? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
if (TMUX === undefined) throw new Error('tmux not found: set TMUX_BIN to its absolute path');
const ESC = String.fromCharCode(27);
const S = 's1';
const here = new URL('.', import.meta.url).pathname;
mkdirSync(here + 'out', { recursive: true });
const tmux = (...a) => execFileSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};

const trimFrame = (txt) => {
  const rows = txt.split('\n').map((l) => l.replace(/ +$/, ''));
  while (rows.length && rows[rows.length - 1] === '') rows.pop();
  return rows;
};
const capture = (tag) => {
  const text = tmux('capture-pane', '-t', S, '-p');
  const esc = tmux('capture-pane', '-t', S, '-p', '-e');
  writeFileSync(`${here}out/${tag}.txt`, text);
  writeFileSync(`${here}out/${tag}.esc.txt`, esc.replaceAll(ESC, '␛'));
  return { text: trimFrame(text), esc };
};
const diff = (got, want) => {
  const n = Math.max(got.length, want.length);
  const bad = [];
  for (let i = 0; i < n; i++) if ((got[i] ?? '') !== (want[i] ?? '')) bad.push(i);
  return bad;
};

// per-cell dim flags for the whole capture. tmux's -e output only emits an SGR when the attribute CHANGES, and the
// state carries across line ends, so the parser must carry it too.
function dimGrid(escText) {
  const rowsOut = [];
  let dim = false;
  for (const line of escText.split('\n')) {
    const flags = [];
    const re = new RegExp(`${ESC}\\[([0-9;:]*)m|([^${ESC}])`, 'gu');
    let m;
    while ((m = re.exec(line))) {
      if (m[2] !== undefined) { flags.push(dim); continue; }
      const ps = m[1] === '' ? [0] : m[1].split(/[;:]/).map(Number);
      for (const p of ps) { if (p === 0 || p === 22) dim = false; else if (p === 2) dim = true; }
    }
    rowsOut.push(flags);
  }
  return rowsOut;
}

const size = (c, r) => tmux('resize-window', '-t', S, '-x', String(c), '-y', String(r));
const keys = (...k) => tmux('send-keys', '-t', S, ...k);
const flags = process.argv.slice(2);

try { tmux('kill-server'); await sleep(400); } catch {}
const cmd = `cd ${here} && node spike-render.mjs ${flags.join(' ')}; echo EXIT-CODE:$?; sleep 60`;
tmux('new-session', '-d', '-s', S, '-x', '80', '-y', '24', cmd);
// wait for the FIRST frame instead of a fixed sleep (a fixed 1.5 s raced the app's start on a busy machine)
for (let i = 0; i < 100; i++) {
  await sleep(100);
  if (tmux('capture-pane', '-t', S, '-p').includes('01 │') && tmux('display-message', '-p', '-t', S, '#{alternate_on}').trim() === '1') break;
}
await sleep(300);

console.log(`TERM inside tmux: ${tmux('display-message', '-p', '-t', S, '#{pane_width}x#{pane_height} alt=#{alternate_on}').trim()}`);

// 0  idle, alternate screen
const t0 = capture('0-idle');
check('alternate screen is on while the app runs', tmux('display-message', '-p', '-t', S, '#{alternate_on}').trim() === '1');
check('idle frame equals the model (80x24)', diff(t0.text, expectedFrame(80, 24)).length === 0, `bad rows: ${diff(t0.text, expectedFrame(80, 24)).join(',')}`);

// 1  open the popup
keys('o'); await sleep(700);
const t1 = capture('1-popup-open');
const want1 = expectedFrame(80, 24, { popup: true });
const bad1 = diff(t1.text, want1);
check('popup open: every cell equals the model (opaque, centred, border straight)', bad1.length === 0, `bad rows: ${bad1.join(',')}`);

// dim: outside the popup rectangle dim, inside not
{
  const grid = dimGrid(t1.esc);
  const r = rect(80, 24);
  let outsideDim = 0, outsideTotal = 0, insideDim = 0, insideTotal = 0;
  for (let y = 0; y < 23; y++) {
    const flagsRow = grid[y] ?? [];
    for (let x = 0; x < 80; x++) {
      const inside = y >= r.top && y < r.top + POPUP_H && x >= r.left && x < r.left + POPUP_W;
      if (inside) { insideTotal++; if (flagsRow[x]) insideDim++; }
      else { outsideTotal++; if (flagsRow[x]) outsideDim++; }
    }
  }
  check('backdrop is dimmed outside the popup', outsideDim / outsideTotal > 0.95, `${outsideDim}/${outsideTotal} cells`);
  check('popup cells are not dimmed', insideDim === 0, `${insideDim}/${insideTotal} cells dimmed`);
}

// 2  close: no residue
keys('Escape'); await sleep(700);
const t2 = capture('2-after-esc');
check('Esc closes the popup and the frame equals the idle frame (no residue)', diff(t2.text, t0.text).length === 0 && diff(t2.text, expectedFrame(80, 24)).length === 0, `bad rows: ${diff(t2.text, expectedFrame(80, 24)).join(',')}`);
{
  const any = dimGrid(t2.esc).slice(0, 23).some((row) => row.some(Boolean));
  check('the dim style is gone after close', !any);
}

// 3  a later sibling covers popup rows
keys('o'); await sleep(500); keys('s'); await sleep(700);
const t3 = capture('3-occluded');
const want3 = expectedFrame(80, 24, { popup: true, occluder: true });
check('a LATER sibling is drawn over the popup (z-order is tree order; the hazard is real)', diff(t3.text, want3).length === 0, `bad rows: ${diff(t3.text, want3).join(',')}`);
keys('s'); await sleep(500);
const t3b = capture('3b-occluder-gone');
check('removing the sibling restores the popup rows', diff(t3b.text, want1).length === 0, `bad rows: ${diff(t3b.text, want1).join(',')}`);

// 4  resize larger with the popup open
size(100, 30); await sleep(900);
const t4 = capture('4-resize-100x30');
const bad4 = diff(t4.text, expectedFrame(100, 30, { popup: true }));
check('resize to 100x30 with the popup open: re-centred, frame equals the model, no leftovers', bad4.length === 0, `bad rows: ${bad4.join(',')}`);

// 5  below the floor
size(70, 20); await sleep(900);
const t5 = capture('5-resize-70x20');
check('below 80x24 the popup is replaced by the notice', t5.text.join('\n').includes('Too small for a popup') && !t5.text.join('\n').includes('Doctor · this machine'));

// 6  back to 80x24
size(80, 24); await sleep(900);
const t6 = capture('6-back-80x24');
const bad6 = diff(t6.text, want1);
check('back to 80x24: the popup returns and the frame equals the model', bad6.length === 0, `bad rows: ${bad6.join(',')}`);

// 7  close then quit: the primary buffer is intact
keys('Escape'); await sleep(500);
const t7 = capture('7-closed-again');
check('closed again after the resizes: frame equals idle', diff(t7.text, expectedFrame(80, 24)).length === 0, `bad rows: ${diff(t7.text, expectedFrame(80, 24)).join(',')}`);
keys('q'); await sleep(1200);
const alt = tmux('display-message', '-p', '-t', S, '#{alternate_on}').trim();
const t8 = capture('8-after-quit');
check('quit leaves the alternate screen', alt === '0');
check('the shell scrollback shows SPIKE-EXIT and the exit code, none of the frame', t8.text.join('\n').includes('SPIKE-EXIT') && !t8.text.join('\n').includes('the quick brown fox'), t8.text.slice(0, 3).join(' | '));

try { tmux('kill-server'); } catch {}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
