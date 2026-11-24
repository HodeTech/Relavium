/**
 * Test-only side effect: make chalk level 0, as it is under `--no-color` (argv), `FORCE_COLOR=0` and `TERM=dumb`.
 *
 * The counterpart of `force-color.ts`: `import './force-color.js'` raises chalk to truecolor so a frame can SEE a style, which MASKS every
 * path where chalk is off. A test of such a path imports this module first instead. As there, it must be a separate module so the
 * assignment runs before ink (and chalk) is evaluated.
 */
process.env['FORCE_COLOR'] = '0';
