/**
 * The CLI data-module fence fixture (ADR-0145 §10): a file on the named list of data modules that does what a data module must not: import
 * `ink`, `react`, `react-dom`, `chalk`, an `ink-*` package, a `node:` module, a bare Node built-in, a subpath of them, or a vendor SDK of the
 * seam, bare and as a subpath (the STATIC forms: `no-restricted-imports`); import the same by a dynamic `import()`, an import-type query or a
 * `require` (the SYNTAX forms); and read `process` or `Buffer` (the GLOBALS). It also carries an `eslint-disable` comment above an `ink` import,
 * which must lift nothing. `assert-fence.mjs` reads the exact error count of each of the three as the spec, so a form that stops being policed
 * changes a count and fails CI instead of passing on the others.
 *
 * Quarantined here for the same reason the seam fixture is: this file exists to trip the rules.
 */
import chalk from 'chalk';
import { Text } from 'ink';
import 'ink-spinner';
import OpenAI from 'openai';
import 'openai/resources';
import { useState } from 'react';
import { createRoot } from 'react-dom';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { jsx } from 'react/jsx-runtime';
// An inline directive does not lift the fence from the module it is written in.
// eslint-disable-next-line @typescript-eslint/no-restricted-imports
import { Box } from 'ink';

// The forms `no-restricted-imports` cannot see.
export const dynamicInk = () => import('ink');
export const dynamicReact = () => import('react/jsx-runtime');
export const dynamicChalk = () => import('chalk');
export const dynamicInkPackage = () => import('ink-spinner');
export const dynamicNodeColon = () => import('node:fs');
export const dynamicBareBuiltin = () => import('fs/promises');
export type ReactNodeByQuery = import('react').ReactNode;
declare const require: (specifier: string) => unknown;
export const required = require('node:os');

// The globals.
export const platform = process.platform;
export const bytes = Buffer.from('x');
export const viaGlobalThis = globalThis.process;

export const used = [chalk, Text, OpenAI, useState, createRoot, readFileSync, join, jsx, Box];
