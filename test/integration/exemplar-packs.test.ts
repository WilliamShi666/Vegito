// P13 exemplar-packs gate (IMPLEMENTATION_PLAN P13). The two shipped packs under
// packs/ are not hand-written — they are the Forge's own output, and this test
// holds them to that contract. For each pack it proves four things, all offline:
//   1. Reproducible — re-forging the same archetype+params yields byte-identical
//      files to what is committed (so the packs can never silently drift from the
//      generator that is supposed to produce them).
//   2. Valid — the committed pack passes `validatePack` with zero problems.
//   3. Runs — a real runTurn through the scripted wire answers a domain query with
//      the forged persona actually present in the system prefix the model saw.
//   4. Gated — the pack's hard validator accepts a good candidate (exit 0) and
//      rejects a bad one (non-zero), proving the small-harness lesson is enforced.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { planFromFlags, planToSpec } from '../../src/forge/interview.ts';
import { generatePack } from '../../src/forge/generate.ts';
import { validatePack } from '../../src/extend/pack-validate.ts';
import { loadPack } from '../../src/extend/packs.ts';
import { createExtensionRegistry } from '../../src/extend/registry.ts';
import { createSystemPrompt } from '../../src/context/prompt.ts';
import { IDENTITY, CONSTITUTION } from '../../src/context/identity.ts';
import { assembleLoopDeps, runTurn } from '../../src/ui/runtime.ts';
import { reduce } from '../../src/kernel/reducer.ts';
import { initialState } from '../../src/kernel/state.ts';
import { CONFIG_DEFAULTS } from '../../src/config/schema.ts';
import { ScriptedWire, scriptedText } from '../../src/providers/wire/scripted.ts';

const REPO = fileURLToPath(new URL('../..', import.meta.url));

// Each exemplar pairs a committed directory with the exact forge invocation that
// produced it and the offline assertions that prove it works end to end.
interface Exemplar {
  readonly dir: string;
  readonly archetype: string;
  readonly domain: string;
  readonly name: string;
  /** A user query the pack should answer, and a regex the scripted answer matches. */
  readonly query: string;
  readonly scriptedAnswer: string;
  readonly answerRe: RegExp;
  /** A snippet of the persona that must reach the model's system prefix. */
  readonly personaRe: RegExp;
  /** Validator inputs: one that should pass (exit 0), one that should fail. */
  readonly goodCandidate: string;
  readonly badCandidate: string;
}

const EXEMPLARS: readonly Exemplar[] = [
  {
    dir: join(REPO, 'packs', 'ielts'),
    archetype: 'tutor-team',
    domain: 'IELTS writing and speaking',
    name: 'ielts',
    query: 'Assess my IELTS Task 2 essay.',
    scriptedAnswer: 'Task Response: band 6.5 — clear position, develop examples further.',
    answerRe: /band 6\.5/,
    personaRe: /tutoring team for IELTS writing and speaking/,
    goodCandidate: 'Task Response: band 7. Coherence: band 6.5. Lexical resource: band 6.',
    badCandidate: 'This essay is good overall but needs more examples.',
  },
  {
    dir: join(REPO, 'packs', 'code-review'),
    archetype: 'review-team',
    domain: 'code review for TypeScript services',
    name: 'code-review',
    query: 'Review this request handler for problems.',
    scriptedAnswer: 'Finding: missing input validation on req.body — severity major. Fix: parse with a schema.',
    answerRe: /severity major/,
    personaRe: /review team for code review for TypeScript services/,
    goodCandidate: 'Finding: unbounded loop — blocker. Finding: unclear name — minor.',
    badCandidate: 'Finding: something looks off here but I am not sure what.',
  },
];

/** Recursively list a directory as a sorted map of "./"-relative path → bytes. */
async function readTree(root: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else out.set(`./${relative(root, abs).split(sep).join('/')}`, await readFile(abs, 'utf8'));
    }
  }
  await walk(root);
  return out;
}

/** Run a rubric validator the way the harness does: `node <validator> "<candidate>"`. */
function runValidator(validatorPath: string, candidate: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [validatorPath, candidate], { stdio: 'ignore' });
    child.on('close', (code) => resolve(code ?? 1));
    child.on('error', () => resolve(1));
  });
}

for (const ex of EXEMPLARS) {
  test(`exemplar pack "${ex.name}" — reproducible, valid, runs, and gates`, async () => {
    // 1. Reproducible: re-forge the same archetype+params and diff byte-for-byte.
    const plan = planFromFlags({ archetype: ex.archetype, domain: ex.domain, name: ex.name });
    assert.ok(!('error' in plan), `plan should resolve: ${JSON.stringify(plan)}`);
    const spec = planToSpec(plan);

    const fresh = await mkdtemp(join(tmpdir(), `vegito-${ex.name}-`));
    await generatePack(fresh, spec);

    const committed = await readTree(ex.dir);
    const reforged = await readTree(fresh);
    assert.deepEqual(
      [...reforged.keys()].sort(),
      [...committed.keys()].sort(),
      'committed and re-forged file sets must match',
    );
    for (const [rel, bytes] of committed) {
      assert.equal(reforged.get(rel), bytes, `byte drift in ${rel} — re-run forge to regenerate ${ex.name}`);
    }

    // 2. Valid: the committed pack passes validation cleanly.
    const result = await validatePack(ex.dir);
    assert.deepEqual(result.problems, [], `${ex.name} should validate clean`);
    assert.equal(result.ok, true);

    // 3. Runs: load → install → a real turn through the scripted wire answers,
    //    with the forged persona present in the system prefix the model saw.
    const pack = await loadPack(ex.dir);
    assert.equal(pack.manifest.agents.length, 3);
    const registry = createExtensionRegistry();
    await registry.installPack(pack);

    const persona = await readFile(pack.personaPath!, 'utf8');
    const system = createSystemPrompt({
      identity: IDENTITY,
      constitution: CONSTITUTION,
      environment: { cwd: fresh, platform: 'test', date: '2026-06-12' },
      memoryFiles: [],
      packs: [persona],
    });

    const wire = new ScriptedWire([{ kind: 'events', events: scriptedText(ex.scriptedAnswer) }]);
    const signal = new AbortController().signal;
    const deps = assembleLoopDeps({
      providerName: wire.name,
      callModel: (req, sig) => wire.send(req, sig),
      registry: registry.tools,
      workspace: fresh,
      mode: 'default',
      systemTiers: system.tiers(),
      config: CONFIG_DEFAULTS,
      signal,
    });

    const start = reduce(initialState({ sid: `exemplar-${ex.name}`, model: 'scripted', maxIterations: 8 }), {
      t: 'user_msg',
      blocks: [{ kind: 'text', text: ex.query }],
    });

    const gen = runTurn(start, deps);
    let answer = '';
    let res = await gen.next();
    while (!res.done) {
      if (res.value.t === 'text_delta') answer += res.value.text;
      res = await gen.next();
    }
    const turn = res.value;

    assert.equal(turn.reason, 'end_turn');
    assert.match(answer, ex.answerRe);
    assert.equal(wire.calls.length, 1);
    assert.match(wire.calls[0]!.system.join('\n'), ex.personaRe);

    // 4. Gated: the hard validator accepts the good candidate and rejects the bad.
    const validatorRel = pack.manifest.rubrics[0]!.validator;
    const validatorPath = join(ex.dir, validatorRel.replace(/^\.\//, ''));
    assert.equal(await runValidator(validatorPath, ex.goodCandidate), 0, 'good candidate should pass');
    assert.notEqual(await runValidator(validatorPath, ex.badCandidate), 0, 'bad candidate should fail');
  });
}
