// Run shipping CLI TypeScript through the existing native-test resolver; packages use their builds.
import { register } from 'node:module';
register('./ts-resolve-hook.mjs', import.meta.url);
