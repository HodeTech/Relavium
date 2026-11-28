// The inline form: the popup is a framed block in Ink's live region, no alternate screen, no absolute node.
// Checks: it appears in flow above the prompt; closing leaves no popup row; the scrollback is not polluted by
// repeated open/close; and the case where the live region is as tall as the terminal.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { popupLines } from './model.mjs';
const SOCK = 'mvp11spike2', S = 's2';
// The tmux binary by an absolute path (set TMUX_BIN to use another): a program found through PATH is whatever PATH holds first.
const TMUX = process.env.TMUX_BIN ?? ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux'].find((p) => existsSync(p));
if (TMUX === undefined) throw new Error('tmux not found: set TMUX_BIN to its absolute path');
const here = new URL('.', import.meta.url).pathname;
mkdirSync(here + 'out', { recursive: true });
const tmux = (...a) => execFileSync(TMUX, ['-L', SOCK, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const res = [];
const check = (n, ok, d = '') => { res.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  — ' + d : ''}`); };
const rows = (t) => t.split('\n').map((l) => l.replace(/ +$/, ''));
const hist = () => tmux('capture-pane', '-t', S, '-p', '-S', '-', '-E', '-');
const visible = () => tmux('capture-pane', '-t', S, '-p');
const count = (t, needle) => t.split(needle).length - 1;

async function scenario(flag, title) {
  console.log(`\n--- ${title}`);
  try { tmux('kill-server'); await sleep(400); } catch {}
  tmux('new-session', '-d', '-s', S, '-x', '80', '-y', '24', `cd ${here} && seq 1 120 | sed 's/^/SCROLLBACK /'; node spike-render.mjs ${flag}; echo EXIT-CODE:$?; sleep 60`);
  for (let i = 0; i < 100; i++) { await sleep(100); if (visible().includes('type a message')) break; }
  await sleep(300);
  check('alternate screen is NOT used', tmux('display-message', '-p', '-t', S, '#{alternate_on}').trim() === '0');
  const k = (...a) => tmux('send-keys', '-t', S, ...a);
  const keptBefore = count(hist(), 'SCROLLBACK 1\n');
  const pre = hist().includes('SCROLLBACK 1\n');
  k('o'); await sleep(700);
  const open = visible();
  writeFileSync(`${here}out/inline-${flag.replace(/\W+/g, '')}-open.txt`, open);
  const want = popupLines().map((l) => l.replace(/ +$/, ''));
  const got = rows(open);
  const at = got.findIndex((l) => l === want[0]);
  check('the whole popup is on screen', at >= 0 && want.every((l, i) => got[at + i] === l), at >= 0 ? `first row at line ${at + 1}` : `popup first row not found; ${got.filter(Boolean).length} non-empty rows`);
  check('the prompt is still visible below it', open.includes('type a message'));
  const preOpen = hist().includes('SCROLLBACK 1\n');
  check('the shell scrollback BEFORE the app is still there while the popup is open', preOpen, `before open: ${pre}, with popup open: ${preOpen}`);
  k('Escape'); await sleep(700);
  const closed = visible();
  check('closed: no popup row is left on screen', !closed.includes('Doctor · this machine') && !closed.includes('╰───'));
  // scrollback pollution across repeated open/close
  const before = count(hist(), 'Doctor · this machine');
  for (let i = 0; i < 3; i++) { k('o'); await sleep(500); k('Escape'); await sleep(500); }
  const after = count(hist(), 'Doctor · this machine');
  check('repeated open/close does not leave popup copies in the scrollback', after === before, `copies before ${before}, after 3 more cycles ${after}`);
  writeFileSync(`${here}out/inline-${flag.replace(/\W+/g, '')}-history.txt`, hist());
  check('the shell scrollback survives repeated open/close', hist().includes('SCROLLBACK 1\n') && hist().includes('SCROLLBACK 120'));
  k('q'); await sleep(800);
}

await scenario('--inline', 'inline, body empty (live region = popup 21 + prompt 1 = 22 rows of 24)');
await scenario('--inline --tall', 'inline, 5 body rows + popup 21 + prompt 1 = 27 rows on a 24-row terminal');
try { tmux('kill-server'); } catch {}
console.log(`\n${res.filter(Boolean).length}/${res.length} checks passed`);
process.exit(res.length > 0 && res.every(Boolean) ? 0 : 1); // a failed (or absent) check fails the run, as run-tmux.mjs does
