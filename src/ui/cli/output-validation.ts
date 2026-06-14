import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { validatePack } from '../../extend/pack-validate.ts';
import { loadPack } from '../../extend/packs.ts';
import { expandPath } from './runtime-support.ts';

export interface OutputValidationPorts {
  readonly write: (s: string) => void;
  readonly writeErr: (s: string) => void;
  readonly homeDir: string;
}

export async function validatePackOutput(
  packSpec: string,
  candidateSpec: string,
  cwd: string,
  ports: OutputValidationPorts,
): Promise<number> {
  const packPath = expandPath(packSpec, cwd, ports.homeDir);
  const candidatePath = expandPath(candidateSpec, cwd, ports.homeDir);
  const packValidation = await validatePack(packPath);
  if (!packValidation.ok) {
    ports.writeErr(`invalid pack — ${packValidation.problems.length} problem(s):\n`);
    for (const p of packValidation.problems) ports.writeErr(`  - ${p}\n`);
    return 1;
  }

  let candidate: string;
  try {
    candidate = await readFile(candidatePath, 'utf8');
  } catch (err) {
    ports.writeErr(`cannot read candidate output ${candidateSpec}: ${err instanceof Error ? err.message : String(err)}\n`);
    return 2;
  }

  const pack = await loadPack(packPath);
  if (pack.manifest.rubrics.length === 0) {
    ports.writeErr(`pack "${pack.manifest.name}" has no rubric validators\n`);
    return 1;
  }

  for (const rubric of pack.manifest.rubrics) {
    const validator = join(pack.root, rubric.validator.replace(/^\.\//, '').split('/').join(sep));
    const result = await runValidatorProcess(validator, candidate);
    if (!result.ok) {
      ports.writeErr(`validator failed: ${rubric.name}${result.stderr.trim() === '' ? '' : ` — ${result.stderr.trim()}`}\n`);
      return 1;
    }
  }

  ports.write(`output valid for pack "${pack.manifest.name}" (${pack.manifest.rubrics.length} validator(s) passed)\n`);
  return 0;
}

function runValidatorProcess(file: string, candidate: string): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [file], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('close', (code) => resolve({ ok: code === 0, stderr }));
    child.on('error', (err) => resolve({ ok: false, stderr: err.message }));
    child.stdin.end(candidate);
  });
}
