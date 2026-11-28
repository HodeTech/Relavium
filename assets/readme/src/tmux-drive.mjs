// Drives a REAL program inside tmux and captures its screen (with ANSI colour) after each step.
// Usage: import { runScenario } from './tmux-drive.mjs'
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {{ socket: string, cwd: string, env: Record<string,string>, command: string[], cols: number, rows: number,
 *           outDir: string, steps: Array<{ label: string, keys?: string[], text?: string, wait: number, shoot?: boolean }> }} s
 */
export async function runScenario(s) {
  const tmux = (...args) =>
    execFileSync('tmux', ['-L', s.socket, '-f', '/dev/null', ...args], { encoding: 'utf8' });
  mkdirSync(s.outDir, { recursive: true });
  const envArgs = Object.entries(s.env).map(([k, v]) => `${k}=${v}`);
  const session = 'v';
  tmux(
    'new-session',
    '-d',
    '-s',
    session,
    '-x',
    String(s.cols),
    '-y',
    String(s.rows),
    '-c',
    s.cwd,
    'env',
    ...envArgs,
    ...s.command,
  );
  const frames = [];
  try {
    await sleep(2500);
    let index = 0;
    for (const step of s.steps) {
      if (step.text !== undefined) tmux('send-keys', '-t', session, '-l', step.text);
      for (const key of step.keys ?? []) tmux('send-keys', '-t', session, key);
      await sleep(step.wait);
      if (step.shoot !== false) {
        const ansi = tmux('capture-pane', '-t', session, '-p', '-e');
        const name = `${String(index).padStart(2, '0')}-${step.label}`;
        writeFileSync(join(s.outDir, `${name}.ans`), ansi);
        frames.push({ name, ansi, step });
        index += 1;
      }
    }
  } finally {
    try {
      tmux('kill-session', '-t', session);
    } catch {
      /* already gone */
    }
  }
  return frames;
}
