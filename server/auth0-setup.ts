import { randomBytes } from 'node:crypto';

export const TEST_APP_ORIGIN = 'https://cool-scone-571b5f.netlify.app';
export const TEST_NEON_BRANCH = 'br-fancy-bird-azmi6jh6';
export function auth0TestSettings(input: Record<string, string | undefined>, current: Record<string, string | undefined>) {
  if (current.NEON_BRANCH_ID !== TEST_NEON_BRANCH || current.STORAGE_DRIVER !== 'postgres' || current.ACCOUNTING_WRITES_ENABLED !== 'false') throw new Error('TEST_ENV_REQUIRED');
  if (current.APP_ORIGIN && current.APP_ORIGIN !== TEST_APP_ORIGIN) throw new Error('ORIGIN_CONFLICT');
  const domain = input.AUTH0_DOMAIN?.trim();
  if (!domain || domain.includes('://') || !/^[a-zA-Z0-9.-]+$/.test(domain) || !domain.includes('.') || domain.startsWith('.') || domain.endsWith('.')) throw new Error('AUTH0_DOMAIN_INVALID');
  const clientId = input.AUTH0_CLIENT_ID?.trim(), secret = input.AUTH0_CLIENT_SECRET?.trim();
  const safe = /^[a-zA-Z0-9._~+\/-]+={0,2}$/;
  if (!clientId || !secret || clientId.length > 255 || secret.length > 1024 || !safe.test(clientId) || !safe.test(secret)) throw new Error('AUTH0_CREDENTIAL_INPUT_INVALID');
  const cookieKey = current.COOKIE_KEY ?? randomBytes(32).toString('hex');
  if (!/^[a-fA-F0-9]{64}$/.test(cookieKey)) throw new Error('COOKIE_KEY_INVALID');
  return { APP_ORIGIN: TEST_APP_ORIGIN, OIDC_ISSUER: `https://${domain.toLowerCase()}/`, OIDC_CLIENT_ID: clientId, OIDC_CLIENT_SECRET: secret, COOKIE_KEY: cookieKey };
}
export function mergeAuth0Env(source: string, settings: ReturnType<typeof auth0TestSettings>) {
  const keys = new Set(Object.keys(settings));
  const retained = source.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/);
    return !match || !keys.has(match[1]);
  }).join('\n').trimEnd();
  return retained + '\n\n# Test-only Auth0 OIDC configuration. Never commit this file.\n' + Object.entries(settings).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n') + '\n';
}
