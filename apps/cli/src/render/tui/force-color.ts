/**
 * Test-only side effect: make chalk emit real ANSI so a frame snapshot can SEE styling.
 *
 * ink 7 renders `<Text inverse>` through the chalk singleton, whose `level` is resolved once, at chalk's import, from
 * `supports-color`. Under vitest stdout is not a TTY, so the level is 0 and every style attribute vanishes from
 * `lastFrame()` — a selection highlight that never renders would ship green. Importing this module BEFORE ink (the
 * import order is the mechanism) sets the level to truecolor for that test file.
 *
 * It must be a separate module: `import` statements are hoisted, so an assignment at the top of the test file would
 * run after ink — and chalk — had already been evaluated.
 */
process.env['FORCE_COLOR'] = '3';
