import { register } from 'node:module';
import { installRequireFence, runtimeState } from './source-graph.mjs';
installRequireFence(runtimeState());
register('./loader.mjs', import.meta.url);
