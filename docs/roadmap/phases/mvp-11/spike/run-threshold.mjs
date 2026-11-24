import { execFileSync } from 'node:child_process';
const SOCK = 'mvp11spike3', S = 's3';
const here = new URL('.', import.meta.url).pathname;
const tmux = (...a) => execFileSync('tmux', ['-L', SOCK, ...a], { encoding: 'utf8' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hist = () => tmux('capture-pane', '-t', S, '-p', '-S', '-', '-E', '-');
for (const body of [0, 1, 2, 3]) {
  const total = body + 21 + 1;
  try { tmux('kill-server'); await sleep(300); } catch {}
  tmux('new-session', '-d', '-s', S, '-x', '80', '-y', '24', `cd ${here} && seq 1 120 | sed 's/^/SCROLLBACK /'; node spike-render.mjs --inline --body=${body}; sleep 30`);
  for (let i = 0; i < 100; i++) { await sleep(100); if (tmux('capture-pane', '-t', S, '-p').includes('type a message')) break; }
  await sleep(300);
  const before = hist().includes('SCROLLBACK 1\n');
  tmux('send-keys', '-t', S, 'o'); await sleep(700);
  const open = hist().includes('SCROLLBACK 1\n');
  tmux('send-keys', '-t', S, 'Escape'); await sleep(700);
  const closed = hist().includes('SCROLLBACK 1\n');
  console.log(`live region ${String(total).padStart(2)} rows of 24 (${total <= 23 ? '<= rows-1' : '>= rows'}): scrollback kept before open ${before}, popup open ${open}, after close ${closed}`);
  tmux('send-keys', '-t', S, 'q');
}
try { tmux('kill-server'); } catch {}
