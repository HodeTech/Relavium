import { COMMAND_DESCRIPTORS } from './descriptors.js';
import { buildMediaPruneArgs } from './media-input.js';
import type { DispatchCommand } from './input.js';
import { CliError } from '../process/cli-error.js';

/** Fixed module edges only; command/model/user strings never become import paths. */
const loadRuntime = () => import('./dispatch.js');
const RUNTIME_IDS = Object.freeze([
  'run',
  'chat',
  'chat-resume',
  'chat-list',
  'chat-export',
  'create',
  'export',
  'import',
  'agent.run',
  'gate',
  'budget.resume',
  'gate.list',
  'list',
  'logs',
  'status',
  'models',
  'models.refresh',
  'models.pricing',
  'provider.list',
  'provider.add',
  'provider.set-key',
  'provider.remove-key',
  'provider.test',
]);

const routes = new Map<string, DispatchCommand>();
for (const id of RUNTIME_IDS) {
  routes.set(id, async (_id, input, ctx) => {
    let runtime: Awaited<ReturnType<typeof loadRuntime>>;
    try {
      runtime = await loadRuntime();
    } catch (cause) {
      throw new CliError('internal', 'The CLI runtime could not be loaded.', { cause });
    }
    return runtime.executeCommand(id, input, ctx);
  });
}
routes.set('media.prune-temporaries', async (_id, input, ctx) => {
  const args = buildMediaPruneArgs(input);
  const { pruneTemporariesCommand } = await import('./media.js');
  return pruneTemporariesCommand(args, ctx);
});

export const LAZY_COMMAND_IDS: readonly string[] = Object.freeze([...routes.keys()]);
const advertised = COMMAND_DESCRIPTORS.flatMap((entry) =>
  entry.executorId === undefined ? [] : [entry.executorId],
);
if (advertised.length !== routes.size || advertised.some((id) => !routes.has(id)))
  throw new CliError('cli_internal', '');

const PRICED_IDS = new Set([
  'run',
  'chat',
  'chat-resume',
  'agent.run',
  'gate',
  'budget.resume',
  'models',
  'models.refresh',
  'models.pricing',
]);

/** Read the offline cache before the runtime's first metadata consumer; fixtures/media never seed it. */
export const executeLazyCommand: DispatchCommand = async (id, input, ctx) => {
  const route = routes.get(id);
  if (route === undefined) throw new CliError('invalid_invocation', 'unknown command.');
  if (
    (ctx.global.allowFsRoots?.length ?? 0) > 0 &&
    !['chat', 'chat-resume', 'agent.run'].includes(id)
  ) {
    throw new CliError(
      'invalid_invocation',
      '--allow-fs-root applies only to Home, chat, chat-resume and agent run.',
    );
  }
  if (PRICED_IDS.has(id) && !(id === 'agent.run' && typeof input.options['fixture'] === 'string'))
    await ctx.invocation?.seedFileCatalogOnce();
  return route(id, input, ctx);
};
