#!/usr/bin/env node
import { processIo } from './process/io.js';
import { startNativeCli } from './process/native-bootstrap.js';

// The coordinator owns exitCode, including late background failures; never overwrite it after completion.
await startNativeCli(process.argv, processIo()).finished;
