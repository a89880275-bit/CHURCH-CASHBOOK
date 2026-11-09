// Read-only test-environment probe. Never prints provider bodies or credentials.
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

const fail = code => { throw new Error(code); };
try {
  const current = parseEnv(await readFile(new URL('../.env.local', import.meta.url), 'utf8'));
  const input = parseEnv(await readFile(new URL('../.private/deployment/auth0-management-input.env', import.meta.url), 'utf8'));
  if (current.APP_ORIGIN !== 'https://cool-scone-571b5f.netlify.app' || current.NEON_BRANCH_ID !== 'br-fancy-bird-azmi6jh6') fail('TEST_TARGET_REQUIRED');
  const domain = input.AUTH0_MGMT_DOMAIN?.trim();
  if (!domain || !/^[a-zA-Z0-9.-]+$/.test(domain)) fail('DOMAIN_INVALID');
  const origin = `https://${domain.toLowerCase()}`;
  if (origin !== new URL(current.OIDC_ISSUER).origin) fail('LOGIN_TENANT_MISMATCH');
  const clientId = input.AUTH0_MGMT_CLIENT_ID?.trim();
  const secret = input.AUTH0_MGMT_CLIENT_SECRET?.trim();
  if (!clientId || !secret) fail('CREDENTIALS_MISSING');
  if (clientId === current.OIDC_CLIENT_ID) fail('SEPARATE_SERVER_APP_REQUIRED');
  const response = await fetch(origin + '/oauth/token', {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ grant_type: 'client_credentials', client_id: clientId, client_secret: secret, audience: origin + '/api/v2/', scope: 'read:users create:users' }),
  });
  if (!response.ok) fail(`TOKEN_HTTP_${response.status}`);
  const token = await response.json();
  if (typeof token.access_token !== 'string' || token.token_type?.toLowerCase() !== 'bearer') fail('TOKEN_INVALID');
  // The scope is read from the HTTPS token endpoint response, not client input.
  const scope = new Set(String(token.scope ?? '').split(' '));
  if (!scope.has('read:users') || !scope.has('create:users')) fail('GRANTED_SCOPES_NOT_CONFIRMED');
  console.log('PASS: separate server application authenticated against the existing test Auth0 tenant.');
  console.log('PASS: token endpoint granted read:users and create:users.');
  const users = await fetch(origin + '/api/v2/users?per_page=1&fields=user_id&include_fields=true', {
    redirect: 'error', signal: AbortSignal.timeout(20000), headers: { authorization: `Bearer ${token.access_token}` },
  });
  if (!users.ok) fail(`READ_USERS_HTTP_${users.status}`);
  if (!Array.isArray(await users.json())) fail('READ_USERS_RESPONSE_INVALID');
  console.log('PASS: Management API read-only user request succeeded. No identities printed.');
  console.log('NOT TESTED: account creation, invitation email delivery and deployment. No users or database records changed.');
} catch (error) {
  const code = error?.message ?? '';
  console.error('CHECK FAILED: ' + (/^[A-Z][A-Z0-9_]+$/.test(code) ? code : 'MANAGEMENT_CONNECTION_CHECK_FAILED'));
  process.exitCode = 1;
}
