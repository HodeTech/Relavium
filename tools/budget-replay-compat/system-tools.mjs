/** Use standard OS-owned installation paths, never a repository or inherited PATH entry. */
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';

export function systemTool(name) {
  assert.ok(name === 'git' || name === 'tar');
  let paths = [`/usr/bin/${name}`, `/bin/${name}`];
  if (process.platform === 'win32') {
    paths = ['C:/Windows/System32/tar.exe'];
    if (name === 'git')
      paths = ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe'];
  }
  const path = paths.find((candidate) => existsSync(candidate));
  assert.ok(path, `${name} is required at a standard OS installation path`);
  return realpathSync(path);
}
