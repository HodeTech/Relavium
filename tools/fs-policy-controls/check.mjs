/** Thin filesystem entry point; shared mechanics retain the full evidence authority. */
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runControls } from '../causal-controls/run.mjs';
import { mutations } from './mutations.mjs';
await runControls({
  repository: realpathSync(fileURLToPath(new URL('../../', import.meta.url))),
  evidenceKind: 'filesystem',
  mutations,
  toolRoots: ['tools/causal-controls', 'tools/fs-policy-controls'],
});
