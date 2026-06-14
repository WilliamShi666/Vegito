#!/usr/bin/env node
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = join(repoRoot, 'bin', 'vegito.js');
const installDir = join(homedir(), '.local', 'bin');
const target = join(installDir, 'vegito');

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const script = [
  '#!/usr/bin/env sh',
  `exec node ${shellQuote(launcher)} "$@"`,
  '',
].join('\n');

await mkdir(installDir, { recursive: true });
await writeFile(target, script, 'utf8');
await chmod(target, 0o755);

console.log(`installed ${target}`);
console.log('run `vegito` to start the REPL, or `vegito help` for commands');
