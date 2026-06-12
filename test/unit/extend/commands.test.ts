// P8 commands: slash commands are prompt-template files; skills are also
// commands. discoverCommands scans roots for *.md command files; render()
// substitutes $ARGUMENTS (whole arg string) and $1..$9 (positional). The
// skills bridge exposes every discovered skill as an invocable command whose
// body is the skill's Tier-2 payload.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverCommands, parseCommand, mergeCommandSources, skillsAsCommands } from '../../../src/extend/commands.ts';
import { discoverSkills } from '../../../src/extend/skills.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-cmds-'));
}

test('parseCommand reads frontmatter name/description and keeps the template body', () => {
  const cmd = parseCommand('review', '---\ndescription: Review code\n---\nReview this: $ARGUMENTS');
  assert.equal(cmd.name, 'review');
  assert.equal(cmd.description, 'Review code');
  assert.equal(cmd.template, 'Review this: $ARGUMENTS');
});

test('parseCommand tolerates a bare body with no frontmatter', () => {
  const cmd = parseCommand('hi', 'just say hi');
  assert.equal(cmd.name, 'hi');
  assert.equal(cmd.template, 'just say hi');
  assert.equal(cmd.description, '');
});

test('render substitutes $ARGUMENTS with the full argument string', async () => {
  const root = await tmp();
  try {
    await writeFile(join(root, 'echo.md'), '---\ndescription: e\n---\nYou said: $ARGUMENTS', 'utf8');
    const src = discoverCommands([root]);
    assert.equal(src.render('echo', 'hello world'), 'You said: hello world');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('render substitutes positional $1 $2 and leaves the rest', async () => {
  const root = await tmp();
  try {
    await writeFile(join(root, 'pair.md'), 'first=$1 second=$2', 'utf8');
    const src = discoverCommands([root]);
    assert.equal(src.render('pair', 'a b c'), 'first=a second=b');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverCommands lists commands sorted by name; render unknown returns undefined', async () => {
  const root = await tmp();
  try {
    await writeFile(join(root, 'zed.md'), 'z', 'utf8');
    await writeFile(join(root, 'apex.md'), 'a', 'utf8');
    const src = discoverCommands([root]);
    assert.deepEqual(
      src.list().map((c) => c.name),
      ['apex', 'zed'],
    );
    assert.equal(src.render('nope', ''), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverCommands: earlier roots win on name collision', async () => {
  const a = await tmp();
  const b = await tmp();
  try {
    await writeFile(join(a, 'x.md'), 'A-VERSION', 'utf8');
    await writeFile(join(b, 'x.md'), 'B-VERSION', 'utf8');
    const src = discoverCommands([a, b]);
    assert.equal(src.render('x', ''), 'A-VERSION');
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test('skillsAsCommands turns each skill into a command rendering its body', async () => {
  const root = await tmp();
  try {
    const dir = join(root, 'plan');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'SKILL.md'), '---\nname: plan\ndescription: planning\n---\nPLAN BODY', 'utf8');
    const skills = discoverSkills([root]);
    const cmds = await skillsAsCommands(skills);
    assert.deepEqual(
      cmds.list().map((c) => c.name),
      ['plan'],
    );
    assert.equal(cmds.render('plan', 'ignored args'), 'PLAN BODY');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('mergeCommandSources: first source wins on name collision, union otherwise', async () => {
  const a = await tmp();
  const b = await tmp();
  try {
    await writeFile(join(a, 'shared.md'), 'FROM-A', 'utf8');
    await writeFile(join(a, 'onlyA.md'), 'A', 'utf8');
    await writeFile(join(b, 'shared.md'), 'FROM-B', 'utf8');
    await writeFile(join(b, 'onlyB.md'), 'B', 'utf8');
    const merged = mergeCommandSources([discoverCommands([a]), discoverCommands([b])]);
    assert.deepEqual(
      merged.list().map((c) => c.name),
      ['onlyA', 'onlyB', 'shared'],
    );
    assert.equal(merged.render('shared', ''), 'FROM-A');
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});
