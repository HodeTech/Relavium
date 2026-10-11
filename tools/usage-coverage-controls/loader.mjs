import { existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  installRequireFence,
  instrument,
  relativeSource,
  rejectUnknownAlias,
  runtimeState,
  verifyResolved,
} from './source-graph.mjs';
const state = runtimeState();
installRequireFence(state);
export async function resolve(specifier, context, next) {
  rejectUnknownAlias(specifier);
  const parent = context.parentURL?.startsWith('file:')
    ? fileURLToPath(context.parentURL)
    : undefined;
  const mapped = relativeSource(state, specifier, parent);
  const result =
    mapped === undefined
      ? await next(specifier, context)
      : { url: pathToFileURL(mapped).href, shortCircuit: true };
  if (result.url.startsWith('file:')) verifyResolved(state, fileURLToPath(result.url));
  return result;
}
export async function load(url, context, next) {
  if (url.startsWith('file:')) {
    const path = fileURLToPath(url);
    if (existsSync(path)) {
      const checked = verifyResolved(state, path);
      if (
        checked.owned &&
        /\.(?:[cm]?[jt]s|tsx)$/.test(path) &&
        !path.includes('/tools/usage-coverage-controls/')
      ) {
        const output = instrument(state, path);
        return {
          format: 'module',
          source: `${output.code}\n//# sourceMappingURL=data:application/json;base64,${Buffer.from(JSON.stringify(output.map)).toString('base64')}`,
          shortCircuit: true,
        };
      }
    }
  }
  return next(url, context);
}
