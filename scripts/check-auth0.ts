import { login } from '../server/auth';
import { TEST_APP_ORIGIN, TEST_NEON_BRANCH } from '../server/auth0-setup';

try {
  if (process.env.APP_ORIGIN !== TEST_APP_ORIGIN || process.env.NEON_BRANCH_ID !== TEST_NEON_BRANCH || process.env.ACCOUNTING_WRITES_ENABLED !== 'false') throw new Error('TEST_ENV_REQUIRED');
  const config = { origin: TEST_APP_ORIGIN, issuer: process.env.OIDC_ISSUER ?? '', clientId: process.env.OIDC_CLIENT_ID ?? '', clientSecret: process.env.OIDC_CLIENT_SECRET ?? '', cookieKey: process.env.COOKIE_KEY ?? '' };
  const response = await login(config);
  const authorization = new URL(response.headers.get('location') ?? '');
  if (response.status !== 302 || authorization.origin !== new URL(config.issuer).origin || authorization.searchParams.get('client_id') !== config.clientId || authorization.searchParams.get('redirect_uri') !== TEST_APP_ORIGIN + '/api/auth/callback' || authorization.searchParams.get('response_type') !== 'code' || authorization.searchParams.get('code_challenge_method') !== 'S256' || !authorization.searchParams.get('code_challenge') || !authorization.searchParams.get('state') || !authorization.searchParams.get('nonce')) throw new Error('LOGIN_REQUEST_INVALID');
  const cookie = response.headers.get('set-cookie') ?? '';
  for (const part of ['__Host-oidc=', 'HttpOnly', 'Secure', 'SameSite=Lax', 'Max-Age=600']) if (!cookie.includes(part)) throw new Error('FLOW_COOKIE_INVALID');
  console.log('PASS: live Auth0 OIDC discovery; existing login route creates Authorization Code + PKCE, state, nonce and secure flow cookie.');
  // This sends only the public authorization request, never a password or client secret.
  const remote = await fetch(authorization, { redirect: 'manual', signal: AbortSignal.timeout(20000) });
  const next = remote.headers.get('location');
  if (![302, 303].includes(remote.status) || !next) throw new Error('AUTH0_AUTHORIZATION_NOT_ACCEPTED');
  const destination = new URL(next, authorization);
  if (destination.origin !== authorization.origin || destination.searchParams.has('error') || !destination.pathname.startsWith('/u/')) throw new Error('AUTH0_LOGIN_REDIRECT_NOT_CONFIRMED');
  console.log('PASS: Auth0 accepted the public client/callback request and redirected to Universal Login.');
  console.log('PENDING: real user sign-in, Client Secret token exchange, initial administrator mapping and deployed callback verification. No application session issued.');
} catch (error) {
  // Provider errors can contain request URLs: print only our own bounded codes.
  const message = (error as Error).message;
  console.error('CHECK FAILED: ' + (/^[A-Z_]+$/.test(message) ? message : 'AUTH0_CONNECTION_CHECK_FAILED'));
  process.exitCode = 1;
}
