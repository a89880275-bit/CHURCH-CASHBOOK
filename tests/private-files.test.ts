import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'vite';
import config from '../vite.config';

describe('Vite development file privacy', () => {
  it('blocks private JSON and server source through regular, raw and /@fs URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'accounting-vite-'));
    await mkdir(join(root, '.private')); await mkdir(join(root, 'server'));
    await writeFile(join(root, '.private', 'probe.json'), '{"marker":"PRIVATE_FILE_PROBE"}');
    await writeFile(join(root, 'server', 'probe.ts'), 'export const marker="SERVER_FILE_PROBE";');
    const server = await createServer({ configFile: false, root, logLevel: 'silent', server: { host: '127.0.0.1', port: 0, fs: config.server!.fs } });
    try {
      await server.listen();
      const address = server.httpServer!.address(); if (!address || typeof address === 'string') throw new Error('Missing test server address');
      const origin = `http://127.0.0.1:${address.port}`;
      for (const path of ['/.private/probe.json', '/.private/probe.json?raw', '/.private/probe.json?import', '/server/probe.ts', '/@fs/' + join(root, '.private', 'probe.json').replaceAll('\\', '/')]) {
        const response = await fetch(origin + path);
        expect(response.status, path).toBe(403);
        expect(await response.text()).not.toContain('PRIVATE_FILE_PROBE');
      }
    } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
  }, 20000);
});
