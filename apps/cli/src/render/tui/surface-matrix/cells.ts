import { mountHostedChat, mountStandaloneChat } from './chat-host.js';
import { mountHome } from './home-host.js';
import type { MountOptions } from './mount.js';
import { observe, type CellResult } from './run-cell.js';
import type { Surface } from './surface-types.js';
import type { Variant } from './variants.js';

type SetupFunction<T> = (variant: Variant) => T | Promise<T>;

const isSetupFunction = <T extends object>(
  setup: T | SetupFunction<T>,
): setup is SetupFunction<T> => typeof setup === 'function';

/** A setup is a value, or a function of the cell (possibly asynchronous: a fixture database is seeded) when it depends on the renderer or the size. */
async function resolve<T extends object>(
  setup: T | SetupFunction<T> | undefined,
  variant: Variant,
): Promise<T | undefined> {
  if (setup === undefined) return undefined;
  return isSetupFunction(setup) ? await setup(variant) : setup;
}

/**
 * Mount one surface in one cell, put it on screen, and read what the terminal shows and was sent. The mount is always torn down, and a
 * surface that throws while opening is a failure of the cell, never a hang.
 */
export async function runCell(
  entry: Surface,
  variant: Variant,
  options: MountOptions = {},
): Promise<CellResult> {
  if (entry.host === 'home') {
    const setup = await resolve(entry.setup, variant);
    const mount = mountHome(variant, setup, options);
    try {
      await mount.settle();
      await entry.open(mount);
      await mount.settle();
      return observe(entry, mount);
    } finally {
      mount.unmount();
      setup?.dispose?.();
    }
  }
  const setup = await resolve(entry.setup, variant);
  const mount =
    entry.host === 'chat'
      ? await mountHostedChat(variant, setup, options)
      : mountStandaloneChat(variant, setup, options);
  try {
    await mount.settle();
    await entry.open(mount);
    await mount.settle();
    return observe(entry, mount);
  } finally {
    mount.unmount();
  }
}
