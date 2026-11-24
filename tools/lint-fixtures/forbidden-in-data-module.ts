/**
 * The CLI data-module fence fixture (ADR-0145 §10): a file on the named list of data modules that imports what a data module must not
 * (`ink`, `react`, `react-dom`, `chalk`, a `node:` module, a bare Node built-in, a subpath of them, and a vendor SDK of the seam, bare and as
 * a subpath). `assert-fence.mjs` reads the exact error count as the spec, so a form that stops being policed changes the count and fails CI
 * instead of passing on the others.
 *
 * Quarantined here for the same reason the seam fixture is: this file exists to trip the rule.
 */
import chalk from 'chalk';
import { Text } from 'ink';
import OpenAI from 'openai';
import 'openai/resources';
import { useState } from 'react';
import { createRoot } from 'react-dom';
import { readFileSync } from 'node:fs';
import { join } from 'path';
import { jsx } from 'react/jsx-runtime';

export const used = [chalk, Text, OpenAI, useState, createRoot, readFileSync, join, jsx];
