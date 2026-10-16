import { resolveHomeDir } from '../config/load.js';
import { loadCachedCatalog } from './catalog-refresh.js';

/** Read only the existing offline file cache; never fetch or write. Invocation ownership prevents late reseeds. */
export function seedFileCatalog(): void {
  loadCachedCatalog(resolveHomeDir({}));
}
