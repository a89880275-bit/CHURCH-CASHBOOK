// Local build inspection only. No secrets or filenames containing values printed.
import { readFile, readdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { join } from 'node:path';
try {
  const local = parseEnv(await readFile('.env.local', 'utf8'));
  const management = parseEnv(await readFile('.private/deployment/auth0-management-input.env', 'utf8'));
  const values = [local.DATABASE_URL, local.DATABASE_URL_UNPOOLED, local.OIDC_CLIENT_SECRET, local.COOKIE_KEY, management.AUTH0_MGMT_CLIENT_SECRET];
  for (const name of ['DATABASE_URL', 'DATABASE_URL_UNPOOLED']) if (local[name]) values.push(decodeURIComponent(new URL(local[name]).password));
  const secrets = values.filter(value => typeof value === 'string' && value.length >= 12);
  if (secrets.length < 4) throw new Error('PRIVATE_INPUT_REQUIRED');
  let files = 0;
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await scan(path);
      else {
        if (entry.name.endsWith('.map') || entry.name.startsWith('.env')) throw new Error('UNEXPECTED_PRIVATE_ARTIFACT');
        const contents = await readFile(path);
        if (secrets.some(value => contents.includes(Buffer.from(value)))) throw new Error('SECRET_FOUND_IN_BUILD');
        files++;
      }
    }
  }
  await scan('dist'); await scan('.netlify/functions-src');
  console.log(`PASS: ${files} built files scanned; no configured database passwords, OIDC/Management client secrets or cookie key found; no source maps or env files.`);
} catch (error) {
  const code = error?.message ?? '';
  console.error('CHECK FAILED: ' + (/^[A-Z_]+$/.test(code) ? code : 'PRIVATE_BUILD_CHECK_FAILED')); process.exitCode = 1;
}
