import { mkdtemp, copyFile, rm, rmdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
const directory = await mkdtemp(join(tmpdir(), 'cashbook-function-import-'));
const file = join(directory, 'api.mjs');
try {
  await copyFile('.netlify/functions-src/api.mjs', file);
  const { default: handler } = await import(pathToFileURL(file).href);
  const response = await handler(new Request('https://unconfigured.invalid/api/me'));
  if (response.status !== 503) throw new Error('Unconfigured function did not fail closed');
  console.log('PASS: API bundle imports outside project node_modules and fails closed without deployment configuration.');
} finally { await rm(file, { force: true }); await rmdir(directory); }
