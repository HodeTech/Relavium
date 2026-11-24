/**
 * The CLI data-module fence fixture (ADR-0145 §10): a file on the named list of data modules that imports what a data module must not
 * (`ink`, `react`, a `node:` module, a bare Node built-in, a subpath of them). `assert-fence.mjs` reads the exact error count as the spec, so
 * a form that stops being policed changes the count and fails CI instead of passing on the others.
 *
 * Quarantined here for the same reason the seam fixture is: this file exists to trip the rule.
 */
import { Text } from 'ink';
import { useState } from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { jsx } from 'react/jsx-runtime';

export const used = [Text, useState, readFileSync, join, jsx];
