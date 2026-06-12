// P8 skills: SKILL.md discovery + frontmatter + progressive disclosure.
// A skill is a directory holding a SKILL.md whose frontmatter declares name +
// description; the body (and any referenced paths) is the Tier-2 payload the
// model pulls on demand. We also read .claude/skills for drop-in compat.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { discoverSkills, parseSkillFrontmatter } from '../../../src/extend/skills.ts';

async function tmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'vg-skills-'));
}

async function writeSkill(root: string, name: string, front: string, body: string): Promise<void> {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), `---\n${front}\n---\n${body}`, 'utf8');
}

test('parseSkillFrontmatter reads name and description', () => {
  const { meta, body } = parseSkillFrontmatter(
    '---\nname: writing-band\ndescription: Score IELTS writing\n---\nThe full rubric here.',
  );
  assert.equal(meta.name, 'writing-band');
  assert.equal(meta.description, 'Score IELTS writing');
  assert.equal(body, 'The full rubric here.');
});

test('parseSkillFrontmatter rejects missing frontmatter', () => {
  assert.throws(() => parseSkillFrontmatter('no front here'), /frontmatter/);
});

test('parseSkillFrontmatter rejects missing name', () => {
  assert.throws(() => parseSkillFrontmatter('---\ndescription: x\n---\nbody'), /name/);
});

test('discoverSkills lists skills from a directory, sorted by name', async () => {
  const root = await tmp();
  try {
    await writeSkill(root, 'zebra', 'name: zebra\ndescription: Z skill', 'zbody');
    await writeSkill(root, 'alpha', 'name: alpha\ndescription: A skill', 'abody');
    const src = discoverSkills([root]);
    const metas = src.list();
    assert.deepEqual(
      metas.map((m) => m.name),
      ['alpha', 'zebra'],
    );
    assert.equal(metas[0]?.description, 'A skill');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverSkills load() returns the body for a known skill', async () => {
  const root = await tmp();
  try {
    await writeSkill(root, 'brainstorm', 'name: brainstorm\ndescription: ideas', 'BODY-TEXT');
    const src = discoverSkills([root]);
    assert.equal(await src.load('brainstorm'), 'BODY-TEXT');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverSkills load() returns undefined for an unknown skill', async () => {
  const root = await tmp();
  try {
    const src = discoverSkills([root]);
    assert.equal(await src.load('nope'), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverSkills: earlier roots win on name collision (project over home)', async () => {
  const proj = await tmp();
  const home = await tmp();
  try {
    await writeSkill(proj, 'review', 'name: review\ndescription: project review', 'PROJECT');
    await writeSkill(home, 'review', 'name: review\ndescription: home review', 'HOME');
    const src = discoverSkills([proj, home]);
    assert.equal(src.list().length, 1);
    assert.equal(await src.load('review'), 'PROJECT');
  } finally {
    await rm(proj, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test('discoverSkills skips a directory with no SKILL.md and a malformed one', async () => {
  const root = await tmp();
  try {
    await mkdir(join(root, 'empty'), { recursive: true });
    await writeSkill(root, 'broken', 'description: no name', 'body'); // no name -> dropped
    await writeSkill(root, 'good', 'name: good\ndescription: ok', 'g');
    const src = discoverSkills([root]);
    assert.deepEqual(
      src.list().map((m) => m.name),
      ['good'],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('discoverSkills tolerates a missing root directory', () => {
  const src = discoverSkills([join(tmpdir(), 'vg-does-not-exist-xyz')]);
  assert.deepEqual(src.list(), []);
});
