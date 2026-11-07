import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { productionInitialControl } from '../server/provisioning';

const [inputPath, outputPath = '.private/deployment/bootstrap.json'] = process.argv.slice(2);
try {
  if (!inputPath) throw new Error('usage');
  const root = resolve('.private'), output = resolve(outputPath), location = relative(root, output);
  if (!location || location === '..' || location.startsWith(`..${sep}`) || isAbsolute(location)) throw new Error('private-output');
  const initial = productionInitialControl(JSON.parse(await readFile(inputPath, 'utf8')));
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  await writeFile(output, JSON.stringify(initial, null, 2), { flag: 'wx', mode: 0o600, flush: true });
  console.log('PREPARED: private initial administrator JSON. No remote service was changed. Existing output is never overwritten.');
} catch {
  console.error('NOT_PREPARED: provide a private JSON input with actual OIDC subject, loginId, displayName; output must be a new file under .private.');
  process.exitCode = 1;
}
