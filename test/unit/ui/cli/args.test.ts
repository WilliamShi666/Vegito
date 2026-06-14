// P10 CLI arg parsing (DESIGN §11): a pure argv → ParsedCommand function, kept
// separate from dispatch so every shape is unit-testable. Subcommands:
// repl (default) | run | sessions | packs | forge | evolve | version | help.
// Unknown commands and missing required args resolve to a typed 'error' node,
// never a throw — dispatch turns that into a usage message and exit code 2.

import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';

import { parseArgs } from '../../../../src/ui/cli/args.ts';

describe('parseArgs', () => {
  test('no args defaults to the repl', () => {
    assert.equal(parseArgs([]).cmd, 'repl');
  });

  test('repl carries --model, --mode, --cwd and the offline --script seam', () => {
    const p = parseArgs(['repl', '--model', 'fable', '--mode', 'plan', '--cwd', '/w', '--script', 's.json']);
    assert.equal(p.cmd, 'repl');
    if (p.cmd !== 'repl') return;
    assert.equal(p.model, 'fable');
    assert.equal(p.mode, 'plan');
    assert.equal(p.cwd, '/w');
    assert.equal(p.script, 's.json');
  });

  test('bare flags without a subcommand select the repl', () => {
    const p = parseArgs(['--model', 'deepseek-v4-pro', '--pack', 'packs/ielts']);
    assert.equal(p.cmd, 'repl');
    if (p.cmd !== 'repl') return;
    assert.equal(p.model, 'deepseek-v4-pro');
    assert.deepEqual(p.packs, ['packs/ielts']);
  });

  test('--version / -v / version select the version command', () => {
    for (const a of [['--version'], ['-v'], ['version']]) assert.equal(parseArgs(a).cmd, 'version');
  });

  test('run requires a prompt via -p/--prompt', () => {
    const ok = parseArgs(['run', '-p', 'do it']);
    assert.equal(ok.cmd, 'run');
    assert.equal(ok.cmd === 'run' && ok.prompt, 'do it');
    const bad = parseArgs(['run']);
    assert.equal(bad.cmd, 'error');
  });

  test('run --json sets the json flag; default is false', () => {
    const withJson = parseArgs(['run', '-p', 'x', '--json']);
    assert.equal(withJson.cmd === 'run' && withJson.json, true);
    const plain = parseArgs(['run', '-p', 'x']);
    assert.equal(plain.cmd === 'run' && plain.json, false);
  });

  test('run carries --model, --mode, --cwd and the scripted-wire seam --script', () => {
    const p = parseArgs(['run', '-p', 'x', '--model', 'gpt-x', '--mode', 'plan', '--cwd', '/w', '--script', 'fix.json']);
    assert.equal(p.cmd, 'run');
    if (p.cmd !== 'run') return;
    assert.equal(p.model, 'gpt-x');
    assert.equal(p.mode, 'plan');
    assert.equal(p.cwd, '/w');
    assert.equal(p.script, 'fix.json');
  });

  test('run and repl accept --pack; packs accepts trust; evolve accepts --apply and eval', () => {
    const run = parseArgs(['run', '-p', 'x', '--pack', './packs/ielts']);
    assert.equal(run.cmd, 'run');
    assert.equal(run.cmd === 'run' && run.packs[0], './packs/ielts');

    const repl = parseArgs(['repl', '--pack', 'ielts', '--pack', './local']);
    assert.equal(repl.cmd, 'repl');
    assert.deepEqual(repl.cmd === 'repl' && repl.packs, ['ielts', './local']);

    const trust = parseArgs(['packs', 'trust', 'ielts']);
    assert.equal(trust.cmd === 'packs' && trust.sub, 'trust');
    assert.equal(trust.cmd === 'packs' && trust.path, 'ielts');

    const evolveApply = parseArgs(['evolve', './pack', '--session', 's', '--apply']);
    assert.equal(evolveApply.cmd, 'evolve');
    assert.equal(evolveApply.cmd === 'evolve' && evolveApply.apply, true);

    const evolveEval = parseArgs(['evolve', 'eval', './pack']);
    assert.equal(evolveEval.cmd === 'evolve' && evolveEval.sub, 'eval');
    assert.equal(evolveEval.cmd === 'evolve' && evolveEval.pack, './pack');
  });

  test('evolve eval accepts candidate, eval-cases, and report files', () => {
    const parsed = parseArgs([
      'evolve',
      'eval',
      './pack',
      '--candidate',
      'candidate.json',
      '--eval-cases',
      'cases.json',
      '--report',
      'report.json',
    ]);
    assert.equal(parsed.cmd, 'evolve');
    if (parsed.cmd !== 'evolve') return;
    assert.equal(parsed.sub, 'eval');
    assert.equal(parsed.candidate, 'candidate.json');
    assert.equal(parsed.evalCases, 'cases.json');
    assert.equal(parsed.report, 'report.json');
  });

  test('an invalid --mode is a parse error', () => {
    assert.equal(parseArgs(['run', '-p', 'x', '--mode', 'nonsense']).cmd, 'error');
  });

  test('sessions takes a subcommand: list | resume | fork', () => {
    const list = parseArgs(['sessions', 'list']);
    assert.equal(list.cmd === 'sessions' && list.sub, 'list');
    const resume = parseArgs(['sessions', 'resume', 'sid-1']);
    assert.equal(resume.cmd === 'sessions' && resume.sub, 'resume');
    assert.equal(resume.cmd === 'sessions' && resume.target, 'sid-1');
    const fork = parseArgs(['sessions', 'fork', 'sid-1', 'rec-3']);
    assert.equal(fork.cmd === 'sessions' && fork.at, 'rec-3');
  });

  test('sessions with no subcommand defaults to list', () => {
    const s = parseArgs(['sessions']);
    assert.equal(s.cmd === 'sessions' && s.sub, 'list');
  });

  test('packs takes list | validate <path>', () => {
    const list = parseArgs(['packs', 'list']);
    assert.equal(list.cmd === 'packs' && list.sub, 'list');
    const v = parseArgs(['packs', 'validate', './my-pack']);
    assert.equal(v.cmd === 'packs' && v.sub, 'validate');
    assert.equal(v.cmd === 'packs' && v.path, './my-pack');
    // validate without a path is an error
    assert.equal(parseArgs(['packs', 'validate']).cmd, 'error');
  });

  test('forge and evolve are recognized commands', () => {
    assert.equal(parseArgs(['forge']).cmd, 'forge');
    assert.equal(parseArgs(['evolve']).cmd, 'evolve');
  });

  test('forge accepts --native for model-driven template-isolated generation', () => {
    const parsed = parseArgs(['forge', '--native', '--domain', 'TOEFL speaking', '--script', 'native.json']);
    assert.equal(parsed.cmd, 'forge');
    if (parsed.cmd !== 'forge') return;
    assert.equal(parsed.native, true);
    assert.equal(parsed.domain, 'TOEFL speaking');
    assert.equal(parsed.script, 'native.json');
  });

  test('an unknown command is an error', () => {
    assert.equal(parseArgs(['frobnicate']).cmd, 'error');
  });
});
