import { basename, dirname, sep } from 'node:path';

/**
 * The consumer's node_modules directory that owns an installed package's real path. With pnpm's
 * virtual store that path is `<owner>/.pnpm/<id>/node_modules/<name>`, so the owner is the
 * directory holding the store, not the store's per-package node_modules; without a virtual store
 * it is the nearest node_modules ancestor. An unrelated node_modules further up never owns it.
 * @param {string} packageRoot the installed package's absolute real path
 * @returns {string | undefined}
 */
export function installedModulesOwner(packageRoot) {
  const store = `${sep}node_modules${sep}.pnpm${sep}`;
  const index = packageRoot.lastIndexOf(store);
  if (index >= 0) return packageRoot.slice(0, index + `${sep}node_modules`.length);
  for (let parent = dirname(packageRoot); parent !== dirname(parent); parent = dirname(parent)) {
    if (basename(parent) === 'node_modules') return parent;
  }
  return undefined;
}
