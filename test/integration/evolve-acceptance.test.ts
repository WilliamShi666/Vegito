// P12 evolution acceptance gate (DESIGN §8, IMPLEMENTATION_PLAN P12). The
// end-to-end proof: forge a pack offline, seed a session with planted friction,
// run `evolve` so a scripted reviewer surfaces an observation, the proposal is
// applied through the SAME permission gate as any write, the pack version is
// bumped with a provenance record — then `evolve revert` restores the pack
// byte-identically. No network, no real TTY: the whole loop runs offline.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { dispatch, type DispatchPorts } from '../../src/ui/cli/dispatch.ts';
import { createStore } from '../../src/sessions/store.ts';
import { scriptedText } from '../../src/providers/wire/scripted.ts';
import type { ScriptedStep } from '../../src/providers/wire/scripted.ts';
import { loadPack } from '../../src/extend/packs.ts';
import { buildSystemTiers } from '../../src/ui/cli/runtime-support.ts';

const APP_VERSION = '0.1.0';

function ports(extra: Partial<DispatchPorts> & { homeDir: string; cwd: string }): DispatchPorts {
  return {
    write: () => {},
    writeErr: () => {},
    signal: new AbortController().signal,
    ...extra,
  };
}

// Snapshot every declared file under the pack root (skip .evolve sidecar).
async function snapshot(root: string, sub = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of (await readdir(join(root, sub))).sort()) {
    if (sub === '' && name === '.evolve') continue;
    const rel = sub === '' ? name : `${sub}/${name}`;
    const st = await stat(join(root, rel));
    if (st.isDirectory()) for (const [k, v] of await snapshot(root, rel)) out.set(k, v);
    else out.set(rel, await readFile(join(root, rel), 'utf8'));
  }
  return out;
}

test('forge → seed session → evolve (gated apply) bumps version with provenance → revert restores byte-identical', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-evolve-'));
  const cwd = home;
  const out = join(home, 'ielts-pack');

  // 1. Forge the exemplar pack offline.
  const forgeCode = await dispatch(
    ['forge', '--offline', '--archetype', 'tutor-team', '--domain', 'IELTS writing', '--out', out],
    ports({ homeDir: home, cwd }),
  );
  assert.equal(forgeCode, 0);
  const before = await snapshot(out);

  // 2. Seed a session in the store with planted friction (the assistant over-apologizes).
  const store = createStore({ root: join(home, '.vegito', 'sessions'), appVersion: APP_VERSION });
  const transcript = await store.create(cwd);
  await transcript.appendMsg({ role: 'user', blocks: [{ kind: 'text', text: 'grade my essay' }] });
  await transcript.appendMsg({
    role: 'assistant',
    blocks: [{ kind: 'text', text: 'Sorry, so sorry — apologies, here is a long rambling response.' }],
  });
  const sid = transcript.sid;

  // 3. A scripted reviewer returns one friction observation as JSON. The whole
  //    review→propose→apply→gate path runs offline through this fixture.
  const review = JSON.stringify([
    { kind: 'friction', summary: 'over-apologized', constraint: 'Lead with the band score, not an apology.' },
  ]);
  const scriptFile = join(home, 'review-script.json');
  const steps: readonly ScriptedStep[] = [{ kind: 'events', events: scriptedText(review) }];
  await writeFile(scriptFile, JSON.stringify(steps), 'utf8');

  // 4. Default evolve is review-only: it reports observations/proposals but
  //    leaves the pack byte-identical until --apply is explicit.
  const reviewOut: string[] = [];
  const reviewCode = await dispatch(
    ['evolve', out, '--session', sid, '--mode', 'acceptEdits', '--script', scriptFile],
    ports({ homeDir: home, cwd, write: (s) => reviewOut.push(s) }),
  );
  assert.equal(reviewCode, 0, 'review-only evolve should exit 0');
  assert.match(reviewOut.join(''), /review-only/i);
  assert.deepEqual(await snapshot(out), before, 'default evolve must not mutate the pack');

  // 5. Explicit --apply performs the gated mutation.
  const evolveCode = await dispatch(
    ['evolve', out, '--session', sid, '--mode', 'acceptEdits', '--script', scriptFile, '--apply'],
    ports({ homeDir: home, cwd }),
  );
  assert.equal(evolveCode, 0, 'evolve should exit 0');

  // 6. The pack version bumped and the constraint landed in the persona.
  const manifest = JSON.parse(await readFile(join(out, 'pack.json'), 'utf8'));
  assert.equal(manifest.version, '1.0.1', 'version should bump 1.0.0 → 1.0.1');
  const persona = await readFile(join(out, 'persona.md'), 'utf8');
  assert.match(persona, /Lead with the band score, not an apology\./);
  const activePack = await loadPack(out);
  const tiers = await buildSystemTiers(cwd, home, [activePack]);
  assert.match(tiers.join('\n'), /Lead with the band score, not an apology\./, 'evolved persona must activate in runtime system prompt');

  // 7. A provenance record was written citing the session + observation.
  const prov = (await readFile(join(out, '.evolve/provenance.jsonl'), 'utf8')).trim().split('\n');
  assert.equal(prov.length, 1);
  const rec = JSON.parse(prov[0]!);
  assert.equal(rec.prevVersion, '1.0.0');
  assert.equal(rec.version, '1.0.1');
  assert.deepEqual(rec.sids, [sid]);
  assert.ok(rec.observations.includes(`${sid}#0`), 'provenance cites the observation id');

  // 8. Revert restores the pack byte-identically.
  const revertCode = await dispatch(['evolve', 'revert', out], ports({ homeDir: home, cwd }));
  assert.equal(revertCode, 0);
  const after = await snapshot(out);
  assert.deepEqual(after, before, 'revert must restore every declared file byte-identically');
});

test('evolve with a session that surfaces nothing leaves the pack unchanged', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-evolve-noop-'));
  const cwd = home;
  const out = join(home, 'pack');
  await dispatch(
    ['forge', '--offline', '--archetype', 'review-team', '--domain', 'API security', '--out', out],
    ports({ homeDir: home, cwd }),
  );
  const before = await snapshot(out);

  const store = createStore({ root: join(home, '.vegito', 'sessions'), appVersion: APP_VERSION });
  const transcript = await store.create(cwd);
  await transcript.appendMsg({ role: 'user', blocks: [{ kind: 'text', text: 'review this' }] });
  const sid = transcript.sid;

  // Reviewer returns an empty array (nothing worth keeping).
  const scriptFile = join(home, 'empty-review.json');
  const emptySteps: readonly ScriptedStep[] = [{ kind: 'events', events: scriptedText('[]') }];
  await writeFile(scriptFile, JSON.stringify(emptySteps), 'utf8');

  const code = await dispatch(
    ['evolve', out, '--session', sid, '--script', scriptFile],
    ports({ homeDir: home, cwd }),
  );
  assert.equal(code, 0);
  assert.deepEqual(await snapshot(out), before, 'a no-op review must not touch the pack');
});

test('evolve revert with nothing to revert is a clean no-op', async () => {
  const home = await mkdtemp(join(tmpdir(), 'vegito-evolve-norev-'));
  const out = join(home, 'pack');
  await dispatch(
    ['forge', '--offline', '--archetype', 'content-studio', '--domain', 'newsletters', '--out', out],
    ports({ homeDir: home, cwd: home }),
  );
  const before = await snapshot(out);
  const code = await dispatch(['evolve', 'revert', out], ports({ homeDir: home, cwd: home }));
  assert.equal(code, 0);
  assert.deepEqual(await snapshot(out), before);
});
