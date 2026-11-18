/** Stage previously verified assets after tsup's clean, without compiling or modifying final JS. */
import { fileURLToPath } from 'node:url';
import { copyNativeAssets } from './assets.mjs';
const repository = fileURLToPath(new URL('../..', import.meta.url));
copyNativeAssets({ repository });
