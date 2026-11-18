import { describe, expect, it } from 'vitest';

import { isProtectedPath, isSensitiveReadPath } from './fs.js';

// These are contractual credential classes, independent of the predicate's sets.
const credentialPaths = [
  '.ssh/id_ed25519',
  '.relavium/config.toml',
  '.aws/credentials',
  '.env/production',
  '.kube/config',
  '.azure/accessTokens.json',
  '.terraform.d/credentials.tfrc.json',
  '.config/gcloud/configurations/config_default',
  'legacy_credentials/account/adc.json',
  '.env',
  '.env.production',
  '.docker/config.json',
  '.git/config',
  '.git/worktrees/linked/config.worktree',
  'bare.git/config',
  'bare.git/config.worktree',
  '.config/git/credentials',
  '.gitconfig',
  '.git-credentials',
  '.netrc',
  '.npmrc',
  '.pypirc',
  '.pgpass',
  '.envrc',
  '.dockercfg',
  'application_default_credentials.json',
  'credentials.tfrc.json',
  '.terraformrc',
  'terraform.rc',
  // Further real credential stores (private keys, password databases, keychains, tokens).
  '.gnupg/private-keys-v1.d/a.key',
  '.password-store/x.gpg',
  'Library/Keychains/login.keychain-db',
  '.local/share/keyrings/login.keyring',
  '.config/gh/hosts.yml',
  'GitHub CLI/hosts.yml', // the Windows GitHub CLI directory under %APPDATA%
  '.config/op/config',
  '.config/gnupg/private-keys-v1.d/a.key', // XDG GnuPG home
];

describe('the protected-write floor inherits every sensitive-read credential class', () => {
  it.each(credentialPaths)('protects direct and folded Windows spellings of %s', (path) => {
    for (const spelling of [
      `/workspace/${path}`,
      `C:\\workspace\\${path.toUpperCase().replaceAll('/', '\\')}`,
      `C:\\workspace\\${path.replaceAll('/', '\\')}. `,
      `C:\\workspace\\${path.replaceAll('/', '\\')}::$DATA`,
    ]) {
      expect(isSensitiveReadPath(spelling)).toBe(true);
      expect(isProtectedPath(spelling)).toBe(true);
    }
  });

  // A predicate is exported, so it may be handed an unnormalised absolute path: an empty segment (`a//b`) or a `.`
  // segment (`a/./b`) must not split a credential-store run or the `gh` parent of `hosts.yml`.
  it.each(
    credentialPaths.filter(
      (path) => path.includes('/') && !path.startsWith('.git/') && !path.startsWith('bare.git/'),
    ),
  )('protects the unnormalised spellings of %s', (path) => {
    const segments = path.split('/');
    for (const spelling of [
      `/workspace/${segments.join('//')}`,
      `/workspace/${segments.join('/./')}`,
      `/workspace/./${segments.join('/./')}`,
      `/workspace/${segments.join('///')}`,
      `C:\\workspace\\${segments.join('\\\\')}`,
      `C:\\workspace\\${segments.join('\\.\\')}`,
      `C:\\workspace/${segments.join('/\\./')}`,
    ]) {
      expect(isSensitiveReadPath(spelling), spelling).toBe(true);
      expect(isProtectedPath(spelling), spelling).toBe(true);
    }
  });

  it.each([
    '.git/hooks/pre-commit',
    '.bashrc',
    '.zshenv',
    '.profile',
    'config.fish',
    'profile.ps1',
  ])('additionally protects %s while retaining its readable status', (path) => {
    expect(isSensitiveReadPath(`/workspace/${path}`)).toBe(false);
    expect(isProtectedPath(`/workspace/${path}`)).toBe(true);
  });

  it.each([
    'main.tf',
    'terraform.rc.txt',
    'config.worktree',
    'environment.txt',
    'config.json',
    // Multi-segment classes must not over-deny their bare or neighbouring names.
    'keyrings/data.txt',
    '.local/share/applications/app.desktop',
    'Library/Preferences/app.plist',
    '.config/gh/config.yml',
    '.config/opencode/state.json',
    'hosts.yml',
    'gh/inventory/hosts.yml',
    'ansible/hosts.yml',
    'github/hosts.yml',
    'github cli/inventory/hosts.yml',
    '.config/gnupgx/notes.txt',
    '.config/gnupg-notes.md',
    'password-store.md',
    'gnupg-notes.md',
  ])('keeps ordinary lookalikes available: %s', (path) => {
    expect(isSensitiveReadPath(`/workspace/${path}`)).toBe(false);
    expect(isProtectedPath(`/workspace/${path}`)).toBe(false);
    // Removing empty and `.` segments must not join unrelated segments into a credential run.
    const unnormalised = `/workspace/${path.split('/').join('//')}`;
    expect(isSensitiveReadPath(unnormalised), unnormalised).toBe(false);
    expect(isProtectedPath(unnormalised), unnormalised).toBe(false);
  });
});
