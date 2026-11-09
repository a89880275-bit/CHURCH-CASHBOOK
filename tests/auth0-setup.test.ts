import { describe, expect, it } from 'vitest';
import { parseEnv } from 'node:util';
import { auth0TestSettings, mergeAuth0Env, TEST_APP_ORIGIN, TEST_NEON_BRANCH } from '../server/auth0-setup';
const current = { NEON_BRANCH_ID: TEST_NEON_BRANCH, STORAGE_DRIVER: 'postgres', ACCOUNTING_WRITES_ENABLED: 'false', DATABASE_URL: 'unchanged-test-url' };
const input = { AUTH0_DOMAIN: 'tenant.example.auth0.com', AUTH0_CLIENT_ID: 'test-client', AUTH0_CLIENT_SECRET: 'non-live_test-secret' };
describe('test-only Auth0 environment setup', () => {
  it('normalizes the issuer and generates a valid cookie key', () => { const s = auth0TestSettings(input, current); expect(s.APP_ORIGIN).toBe(TEST_APP_ORIGIN); expect(s.OIDC_ISSUER).toBe('https://tenant.example.auth0.com/'); expect(s.COOKIE_KEY).toMatch(/^[a-f0-9]{64}$/); });
  it('retains an existing cookie key instead of invalidating sessions', () => { expect(auth0TestSettings(input, { ...current, COOKIE_KEY: 'a'.repeat(64) }).COOKIE_KEY).toBe('a'.repeat(64)); });
  it('refuses another DB branch, enabled writes and another site origin', () => { for (const change of [{ NEON_BRANCH_ID: 'another-branch' }, { ACCOUNTING_WRITES_ENABLED: 'true' }, { APP_ORIGIN: 'https://production.example' }]) expect(() => auth0TestSettings(input, { ...current, ...change })).toThrow(); });
  it('rejects missing credentials, URL/path injection and dotenv line injection', () => { for (const change of [{ AUTH0_DOMAIN: 'https://tenant.auth0.com' }, { AUTH0_DOMAIN: 'tenant.auth0.com/path' }, { AUTH0_DOMAIN: 'user@tenant.auth0.com' }, { AUTH0_CLIENT_ID: '' }, { AUTH0_CLIENT_SECRET: '' }, { AUTH0_CLIENT_SECRET: 'secret\nDATABASE_URL=changed' }]) expect(() => auth0TestSettings({ ...input, ...change }, current)).toThrow(); });
  it('preserves DB settings and unrelated secrets while replacing only auth settings', () => {
    const source = 'DATABASE_URL="unchanged-test-url"\nOTHER_SECRET=unchanged\nOIDC_ISSUER="https://old.example/"\nexport OIDC_CLIENT_ID=old\n';
    const settings = auth0TestSettings(input, current), merged = mergeAuth0Env(source, settings), parsed = parseEnv(merged);
    expect(parsed.DATABASE_URL).toBe('unchanged-test-url'); expect(parsed.OTHER_SECRET).toBe('unchanged'); expect(parsed.OIDC_CLIENT_ID).toBe('test-client'); expect(merged.match(/^OIDC_ISSUER=/gm)).toHaveLength(1);
    for (const [key, value] of Object.entries(settings)) expect(parsed[key]).toBe(value);
  });
});
