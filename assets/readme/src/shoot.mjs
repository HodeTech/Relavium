// Rasterizes an HTML file with headless Chromium (Brave here); nothing is installed.
// The browser is started for one screenshot and stopped as soon as the file is written and stable: a headless
// Chromium may linger after writing it, and waiting for its exit would cost a minute a frame.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, statSync } from 'node:fs';

const BROWSERS = [
  process.env.RELAVIUM_ASSET_BROWSER,
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
].filter(Boolean);

export function browserPath() {
  const found = BROWSERS.find((p) => existsSync(p));
  if (found === undefined)
    throw new Error('no Chromium-based browser found (set RELAVIUM_ASSET_BROWSER)');
  return found;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Starts the browser once in a new profile directory and stops it, so that the profile is usable (see {@link shoot}). */
async function prime(profileDir) {
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(
    browserPath(),
    [
      '--headless',
      '--disable-gpu',
      '--no-first-run',
      '--no-sandbox',
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await sleep(15_000);
  child.kill('SIGKILL');
}

/** @param {string} html absolute path @param {string} png absolute path @param {number} width @param {number} height @param {string} profileDir */
export async function shoot(html, png, width, height, profileDir, budgetMs = 2500, scale = 1) {
  // A brand new profile gives no screenshot (measured: none in over six minutes) until the browser has been started in it once and
  // stopped: one start on a blank page, killed after a few seconds, makes the next screenshots take about a second.
  if (!existsSync(profileDir)) await prime(profileDir);
  const limitMs = 90_000;
  mkdirSync(profileDir, { recursive: true });
  // a fresh file name per shot: a stale file of the same name must not be mistaken for the new screenshot
  const target = png.replace(/\.png$/u, `.${process.pid}-${Date.now()}.new.png`);
  const child = spawn(
    browserPath(),
    [
      '--headless',
      '--disable-gpu',
      '--hide-scrollbars',
      `--force-device-scale-factor=${scale}`,
      '--no-first-run',
      '--no-sandbox',
      `--virtual-time-budget=${budgetMs}`,
      `--user-data-dir=${profileDir}`,
      `--screenshot=${target}`,
      `--window-size=${width},${height}`,
      `file://${html}`,
    ],
    { stdio: 'ignore' },
  );
  try {
    let last = -1;
    for (let waited = 0; waited < limitMs; waited += 250) {
      await sleep(250);
      if (!existsSync(target)) continue;
      const size = statSync(target).size;
      if (size > 0 && size === last) {
        renameSync(target, png);
        return;
      }
      last = size;
    }
    throw new Error(`no screenshot of ${html} within ${String(limitMs / 1000)} s`);
  } finally {
    child.kill('SIGKILL');
  }
}
