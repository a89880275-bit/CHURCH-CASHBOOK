// Operator-only setup: preserves existing login/database values, never prints secrets.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
try {
  const source = await readFile('.env.local', 'utf8'), current = parseEnv(source);
  const input = parseEnv(await readFile('.private/deployment/auth0-management-input.env', 'utf8'));
  if (current.APP_ORIGIN !== 'https://cool-scone-571b5f.netlify.app' || current.NEON_BRANCH_ID !== 'br-fancy-bird-azmi6jh6' || current.STORAGE_DRIVER !== 'postgres' || current.ACCOUNTING_WRITES_ENABLED !== 'true') throw Error('TEST_ENV_REQUIRED');
  const domain = input.AUTH0_MGMT_DOMAIN?.trim().toLowerCase(), id = input.AUTH0_MGMT_CLIENT_ID?.trim(), secret = input.AUTH0_MGMT_CLIENT_SECRET?.trim();
  if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain) || new URL(current.OIDC_ISSUER).origin !== `https://${domain}` || !id || !secret || id === current.OIDC_CLIENT_ID || !/^[a-zA-Z0-9._~+\/-]+={0,2}$/.test(secret)) throw Error('MANAGEMENT_INPUT_INVALID');
  const settings = { AUTH0_MGMT_DOMAIN: domain, AUTH0_MGMT_CLIENT_ID: id, AUTH0_MGMT_CLIENT_SECRET: secret, AUTH0_DATABASE_CONNECTION: 'Username-Password-Authentication', AUTH0_INVITATIONS_ENABLED: 'true' };
  const keys = new Set(Object.keys(settings));
  const retained = source.split(/\r?\n/).filter(line => { const m = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/); return !m || !keys.has(m[1]); }).join('\n').trimEnd();
  const next = retained + '\n\n# Test-only server invitation settings. Never expose via VITE_ variables.\n' + Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
  const parsed = parseEnv(next);
  if (Object.entries(current).some(([key, value]) => !keys.has(key) && parsed[key] !== value)) throw Error('EXISTING_SETTINGS_CHANGED');
  await writeFile(`.private/deployment/env-before-invitations-${randomUUID()}.env`, source, { flag: 'wx', mode: 0o600, flush: true });
  const temp = `.env.invitation-${randomUUID()}`;
  await writeFile(temp, next, { flag: 'wx', mode: 0o600, flush: true });
  await rename(temp, '.env.local');
  console.log('PASS: test-only server invitation settings saved; all existing login, database and cookie settings preserved; private backup created. No external accounts or emails changed.');
} catch (error) {
  const message = error?.message ?? '';
  console.error('SETUP STOPPED: ' + (/^[A-Z_]+$/.test(message) ? message : 'INVITATION_SETUP_FAILED'));
  process.exitCode = 1;
}
