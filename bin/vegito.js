#!/usr/bin/env node
// Launcher: prefer built dist/, fall back to TypeScript source run natively
// (Node >= 22.18 strips types without a build step).
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, '..', 'dist', 'cli.js');
const src = join(here, '..', 'src', 'cli.ts');
const mod = await import(pathToFileURL(existsSync(dist) ? dist : src).href);
process.exitCode = await mod.main(process.argv.slice(2));
