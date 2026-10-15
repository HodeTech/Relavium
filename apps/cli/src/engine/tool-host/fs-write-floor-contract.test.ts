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

  it.each(['main.tf', 'terraform.rc.txt', 'config.worktree', 'environment.txt', 'config.json'])(
    'keeps ordinary lookalikes available: %s',
    (path) => {
      expect(isSensitiveReadPath(`/workspace/${path}`)).toBe(false);
      expect(isProtectedPath(`/workspace/${path}`)).toBe(false);
    },
  );
});
