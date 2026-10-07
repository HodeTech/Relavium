/** Use standard OS-owned installation paths, never a repository or inherited PATH entry. */
import assert from 'node:assert/strict';
import { existsSync, realpathSync } from 'node:fs';

export function systemTool(name) {
  assert.ok(name === 'git' || name === 'tar');
  const paths =
    process.platform === 'win32'
      ? name === 'git'
        ? ['C:/Program Files/Git/cmd/git.exe', 'C:/Program Files/Git/bin/git.exe']
        : ['C:/Windows/System32/tar.exe']
      : [`/usr/bin/${name}`, `/bin/${name}`];
  const path = paths.find((candidate) => existsSync(candidate));
  assert.ok(path, `${name} is required at a standard OS installation path`);
  return realpathSync(path);
}
