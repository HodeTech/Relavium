import { register } from 'node:module';
import './dependency-runtime.mjs';
register('./loader.mjs', import.meta.url);
