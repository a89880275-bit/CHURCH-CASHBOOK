import { build } from 'esbuild';
import { mkdir } from 'node:fs/promises';
await mkdir('.netlify/functions-src', { recursive: true });
// Netlify v2 forces NFT unless bundling is explicitly disabled. A self-contained
// ESM bundle avoids platform-dependent pnpm symlink tracing during manual deploys.
await build({ entryPoints: ['netlify/functions/api.ts'], outfile: '.netlify/functions-src/api.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', sourcemap: false, external: ['pg-native'], banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } });
console.log('PASS: self-contained Netlify API bundle built; environment values remain runtime reads.');
