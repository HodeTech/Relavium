import { register } from 'node:module';

// register() is available at the supported Node 22.13 floor; registerHooks() is not.
register('./media-prune-loader.ts', import.meta.url);
