// P11.5 forge acceptance gate (DESIGN §10, IMPLEMENTATION_PLAN P11). The end-to-end
// proof that the meta-harness closes the loop: `forge --offline` emits a pack, it
// passes validate and loads, it installs into a real ExtensionRegistry, and a real
// runTurn driven by the scripted wire answers a domain query *through the forged
// persona* — asserted by finding the persona text in the request's system tiers.
// No network, no real TTY: the whole meta-harness is exercised offline here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { loadPack } from '../../src/extend/packs.ts';
import { validatePack } from '../../src/extend/pack-validate.ts';
import { createExtensionRegistry } from '../../src/extend/registry.ts';
import { createSystemPrompt } from '../../src/context/prompt.ts';
import { IDENTITY, CONSTITUTION } from '../../src/context/identity.ts';
import { assembleLoopDeps, runTurn } from '../../src/ui/runtime.ts';
import { reduce } from '../../src/kernel/reducer.ts';
import { initialState } from '../../src/kernel/state.ts';
import { CONFIG_DEFAULTS } from '../../src/config/schema.ts';
import { ScriptedWire, scriptedText } from '../../src/providers/wire/scripted.ts';

function ports(extra: Partial<DispatchPorts>): DispatchPorts {
  return {
    write: () => {},
    writeErr: () => {},
    homeDir: extra.homeDir ?? '/nonexistent-home',
    cwd: extra.cwd ?? '/nonexistent-cwd',
    signal: new AbortController().signal,
    ...extra,
  };
}

test('forge --offline → validate → load → install → persona answers a domain query', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-accept-'));
  const out = join(home, 'ielts-pack');

  // 1. Forge offline (deterministic, provider-free).
  const code = await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  assert.equal(code, 0, 'forge should exit 0');

  // 2. The emitted pack validates clean.
  const result = await validatePack(out);
  assert.deepEqual(result.problems, []);
  assert.equal(result.ok, true);

  // 3. It loads, and 4. installs into a real registry without error.
  const pack = await loadPack(out);
  assert.equal(pack.manifest.agents.length, 3);
  const registry = createExtensionRegistry();
  await registry.installPack(pack);

  // 5. Build a session whose system context carries the forged persona, then run
  //    a real turn through the scripted wire and confirm it answers.
  const persona = await readFile(pack.personaPath!, 'utf8');
  const system = createSystemPrompt({
    identity: IDENTITY,
    constitution: CONSTITUTION,
    environment: { cwd: home, platform: 'test', date: '2026-06-12' },
    memoryFiles: [],
    packs: [persona],
  });

  const wire = new ScriptedWire([
    { kind: 'events', events: scriptedText('Your Task 2 essay scores band 6.5: clear position, but develop examples further.') },
  ]);
  const signal = new AbortController().signal;
  const deps = assembleLoopDeps({
    providerName: wire.name,
    callModel: (req, sig) => wire.send(req, sig),
    registry: registry.tools,
    workspace: home,
    mode: 'default',
    systemTiers: system.tiers(),
    config: CONFIG_DEFAULTS,
    signal,
  });

  const start = reduce(initialState({ sid: 'accept-1', model: 'scripted', maxIterations: 8 }), {
    t: 'user_msg',
    blocks: [{ kind: 'text', text: 'Assess my IELTS Task 2 essay.' }],
  });

  const gen = runTurn(start, deps);
  let answer = '';
  let res = await gen.next();
  while (!res.done) {
    const ev = res.value;
    if (ev.t === 'text_delta') answer += ev.text;
    res = await gen.next();
  }
  const turn = res.value;

  assert.equal(turn.reason, 'end_turn');
  assert.match(answer, /band 6\.5/);

  // The forged persona was actually in the request prefix the model saw.
  assert.equal(wire.calls.length, 1);
  const systemText = wire.calls[0]!.system.join('\n');
  assert.match(systemText, /tutoring team for IELTS writing/);
});
