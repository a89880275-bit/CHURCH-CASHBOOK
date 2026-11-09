import { readFile, writeFile, rename, rm, mkdir } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { auth0TestSettings, mergeAuth0Env } from '../server/auth0-setup';

const target = '.env.local', temporary = `${target}.${randomUUID()}.tmp`;
try {
  const source = await readFile(target, 'utf8');
  const input = parseEnv(await readFile('.private/deployment/auth0-input.env', 'utf8'));
  const settings = auth0TestSettings(input, parseEnv(source));
  const merged = mergeAuth0Env(source, settings);
  const parsed = parseEnv(merged);
  if (Object.entries(settings).some(([key, value]) => parsed[key] !== value)) throw new Error('ENV_ROUNDTRIP_FAILED');
  await mkdir('.private/deployment', { recursive: true, mode: 0o700 });
  await writeFile(`.private/deployment/env-before-auth0-${randomUUID()}.env`, source, { flag: 'wx', mode: 0o600, flush: true });
  await writeFile(temporary, merged, { flag: 'wx', mode: 0o600, flush: true });
  await rename(temporary, target);
  console.log('PASS: test-only Auth0 variables configured; existing DB variables preserved; cookie key generated or retained. No secret values printed.');
} catch {
  console.error('NOT_CONFIGURED: check private input fields and the expected read-only test environment. No credentials printed.');
  process.exitCode = 1;
} finally { await rm(temporary, { force: true }); }
