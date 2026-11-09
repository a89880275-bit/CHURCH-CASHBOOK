import EmbeddedPostgres from 'embedded-postgres';
import { cp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from 'pg';
import { tmpdir } from 'node:os';
const run = promisify(execFile);

export async function startTestPostgres(root: string, port: number, password: string) {
  const db = join(root, 'db'), user = 'cashbook_test';
  let child: ChildProcess | undefined, embedded: EmbeddedPostgres | undefined, pgctl = '';
  if (process.platform === 'win32') {
    // Native PostgreSQL on Windows cannot initialise from a non-ASCII installation
    // path. Copy only the test binary distribution into this isolated temp directory.
    const require = createRequire(import.meta.url), fromEmbedded = createRequire(require.resolve('embedded-postgres'));
    const entry = fromEmbedded.resolve('@embedded-postgres/windows-x64');
    const native = join(root, 'native'); await cp(resolve(dirname(entry), '../native'), native, { recursive: true });
    const pwfile = join(root, 'init-password'); await writeFile(pwfile, password, { mode: 0o600 });
    try { await run(join(native, 'bin/initdb.exe'), ['-D', db, '-U', user, '--pwfile=' + pwfile, '--auth=scram-sha-256', '--locale=C', '--encoding=UTF8'], { cwd: root, windowsHide: true }); }
    finally { await rm(pwfile, { force: true }); }
    pgctl = join(native, 'bin/pg_ctl.exe');
    child = spawn(join(native, 'bin/postgres.exe'), ['-D', db, '-h', '127.0.0.1', '-p', String(port)], { cwd: root, windowsHide: true, stdio: 'ignore' });
  } else {
    embedded = new EmbeddedPostgres({ databaseDir: db, port, user, password, authMethod: 'scram-sha-256', persistent: true, createPostgresUser: false, autoRehydrateSymlinks: true, initdbFlags: ['--locale=C', '--encoding=UTF8'], postgresFlags: ['-h', '127.0.0.1'], onLog: () => {}, onError: () => {} });
    await embedded.initialise(); await embedded.start();
  }
  const stop = async () => {
    if (embedded) await embedded.stop();
    if (child && child.exitCode === null) { await run(pgctl, ['-D', db, '-m', 'fast', '-w', 'stop'], { cwd: root, windowsHide: true }); }
    // Only remove the single directory returned by mkdtemp under the OS temp root.
    const name = relative(resolve(tmpdir()), resolve(root));
    if (!name.startsWith('cashbook-postgres-') || name.includes(sep) || name.includes('..')) throw new Error('Unsafe test cleanup path');
    // Windows may retain a short-lived antivirus/filesystem handle even after
    // pg_ctl has confirmed shutdown. Retry only this already-validated temp root.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };
  try {
    let connected = false;
    for (let i = 0; i < 100; i++) {
      const client = new Client({ host: '127.0.0.1', port, user, password, database: 'postgres', connectionTimeoutMillis: 500 });
      try { await client.connect(); connected = true; } catch {} finally { await client.end().catch(() => {}); }
      if (connected) break; await new Promise(r => setTimeout(r, 50));
    }
    if (!connected) throw new Error('Isolated PostgreSQL did not start');
    return { stop };
  } catch (error) { await stop(); throw error; }
}
