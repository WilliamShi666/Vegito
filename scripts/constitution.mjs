#!/usr/bin/env node
// Constitution linter — mechanically enforces SYNTHESIS.md §4 (A1, A3, A5, A6) and D1.
// Exit 0 = clean, exit 1 = violations listed on stderr.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const violations = [];

function walk(dir, exts) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p, exts));
    else if (exts.some((e) => name.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p) => relative(ROOT, p);

// A1 — no runtime dependencies, ever.
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
if (pkg.dependencies && Object.keys(pkg.dependencies).length > 0) {
  violations.push(`D1: package.json "dependencies" must be empty, found: ${Object.keys(pkg.dependencies).join(', ')}`);
}

const srcFiles = walk(join(ROOT, 'src'), ['.ts']);
const testFiles = walk(join(ROOT, 'test'), ['.ts']);

// A1 — file size cap: 800 lines hard, warn at 400.
for (const f of srcFiles) {
  const lines = readFileSync(f, 'utf8').split('\n').length;
  if (lines > 800) violations.push(`A1: ${rel(f)} has ${lines} lines (cap 800)`);
}

// D1 — zero-dep at the import level: src and test may import only node:* or relative paths.
const IMPORT_RE = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
for (const f of [...srcFiles, ...testFiles]) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (spec.startsWith('.') || spec.startsWith('node:')) continue;
    violations.push(`D1: ${rel(f)} imports bare specifier "${spec}" (only node:* and relative allowed)`);
  }
}

// A5 — process.env confined to config loader and credential source.
const ENV_ALLOWED = [/^src\/config\//, /^src\/providers\/credentials\.ts$/];
for (const f of srcFiles) {
  if (ENV_ALLOWED.some((re) => re.test(rel(f)))) continue;
  const text = readFileSync(f, 'utf8');
  if (/process\.env/.test(text)) {
    violations.push(`A5: ${rel(f)} reads process.env (allowed only in src/config/ and src/providers/credentials.ts)`);
  }
}

// A4/A3 — banned ecosystems anywhere in source.
const BANNED = ['react', 'ink', 'growthbook'];
for (const f of [...srcFiles, ...testFiles]) {
  const text = readFileSync(f, 'utf8');
  for (const m of text.matchAll(IMPORT_RE)) {
    const spec = m[1].toLowerCase();
    if (BANNED.some((b) => spec === b || spec.startsWith(b + '/'))) {
      violations.push(`A3/A4: ${rel(f)} imports banned package "${m[1]}"`);
    }
  }
}

// A6 — secret pattern scan across repository text, including root docs and
// ignored local text files. Skip dependency/build/VCS directories, but do not
// assume secrets only appear under src/test/catalog.
const SECRET_PATTERNS = [
  [/sk-ant-[a-zA-Z0-9-]{8,}/, 'anthropic api key'],
  [/sk-proj-[a-zA-Z0-9_-]{8,}/, 'openai project key'],
  [/\bsk-[a-zA-Z0-9][a-zA-Z0-9_-]{15,}\b/, 'generic api key'],
  [/AKIA[0-9A-Z]{16}/, 'aws access key id'],
  [/ghp_[a-zA-Z0-9]{20,}/, 'github pat'],
  [/xox[baprs]-[a-zA-Z0-9-]{10,}/, 'slack token'],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, 'private key block'],
];
for (const f of walk(ROOT, ['.ts', '.js', '.mjs', '.json', '.md', '.sh', '.txt', '.env', '.yml', '.yaml'])) {
  const text = readFileSync(f, 'utf8');
  for (const [re, label] of SECRET_PATTERNS) {
    if (re.test(text)) {
      violations.push(`A6: ${rel(f)} matches secret pattern (${label})`);
      break;
    }
  }
}

if (violations.length > 0) {
  console.error(`constitution: ${violations.length} violation(s)\n`);
  for (const v of violations) console.error(`  ✗ ${v}`);
  process.exit(1);
}
console.log(`constitution: clean (${srcFiles.length} src files, ${testFiles.length} test files)`);
