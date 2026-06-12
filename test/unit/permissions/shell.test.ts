import { test, describe } from 'node:test';
import { strict as assert } from 'node:assert';
import { analyzeShell } from '../../../src/permissions/shell.ts';

function argvs(input: string): string[][] {
  const a = analyzeShell(input);
  assert.ok(a.ok, `expected parseable: ${input}${a.ok ? '' : ` (${a.reason})`}`);
  return a.commands.map((c) => [...c.argv]);
}

function refused(input: string): string {
  const a = analyzeShell(input);
  assert.ok(!a.ok, `expected fail-closed: ${input}`);
  return a.reason;
}

describe('analyzeShell — words and quoting', () => {
  test('splits plain words on whitespace', () => {
    assert.deepEqual(argvs('ls -la /tmp'), [['ls', '-la', '/tmp']]);
  });

  test('collapses runs of spaces and tabs', () => {
    assert.deepEqual(argvs('echo   a\t\tb'), [['echo', 'a', 'b']]);
  });

  test('single quotes group literally — $ and backtick inside are safe', () => {
    assert.deepEqual(argvs("echo 'hello world'"), [['echo', 'hello world']]);
    assert.deepEqual(argvs("echo '$(whoami) `id` $HOME'"), [['echo', '$(whoami) `id` $HOME']]);
  });

  test('double quotes group; \\" and \\\\ escape inside', () => {
    assert.deepEqual(argvs('echo "a b"'), [['echo', 'a b']]);
    assert.deepEqual(argvs('echo "a \\" b"'), [['echo', 'a " b']]);
    assert.deepEqual(argvs('echo "a \\\\ b"'), [['echo', 'a \\ b']]);
  });

  test('unquoted backslash escapes the next character', () => {
    assert.deepEqual(argvs('echo a\\ b'), [['echo', 'a b']]);
    assert.deepEqual(argvs('echo \\$HOME'), [['echo', '$HOME']]);
  });

  test('adjacent quoted/unquoted segments join into one word', () => {
    assert.deepEqual(argvs("echo pre'mid'post"), [['echo', 'premidpost']]);
    assert.deepEqual(argvs('echo "a"\'b\'c'), [['echo', 'abc']]);
  });

  test('empty quoted strings are real (empty) arguments', () => {
    assert.deepEqual(argvs("grep '' file"), [['grep', '', 'file']]);
  });

  test('unquoted # starts a comment; quoted/mid-word # does not', () => {
    assert.deepEqual(argvs('ls # trailing note'), [['ls']]);
    assert.deepEqual(argvs("echo '#x'"), [['echo', '#x']]);
    assert.deepEqual(argvs('echo a#b'), [['echo', 'a#b']]);
  });
});

describe('analyzeShell — command separators', () => {
  test('pipelines split into one command per stage', () => {
    assert.deepEqual(argvs('cat f | grep x | wc -l'), [['cat', 'f'], ['grep', 'x'], ['wc', '-l']]);
  });

  test('&&, ||, ;, & and newline all separate commands', () => {
    assert.deepEqual(argvs('a && b || c; d & e'), [['a'], ['b'], ['c'], ['d'], ['e']]);
    assert.deepEqual(argvs('a\nb'), [['a'], ['b']]);
  });

  test('|& pipes too', () => {
    assert.deepEqual(argvs('make |& tee log.txt'), [['make'], ['tee', 'log.txt']]);
  });

  test('quoted separators are data, not separators', () => {
    assert.deepEqual(argvs("echo 'a && b; c | d'"), [['echo', 'a && b; c | d']]);
  });

  test('empty or whitespace-only input fails closed', () => {
    refused('');
    refused('   ');
  });

  test('leading env assignments are stripped from argv', () => {
    assert.deepEqual(argvs('FOO=bar NODE_ENV=test npm run build'), [['npm', 'run', 'build']]);
  });
});

describe('analyzeShell — redirections', () => {
  test('> and >> record the write target and drop it from argv', () => {
    const a = analyzeShell('echo hi > /tmp/out.txt');
    assert.ok(a.ok);
    assert.deepEqual([...(a.commands[0]?.argv ?? [])], ['echo', 'hi']);
    assert.deepEqual([...(a.commands[0]?.writes ?? [])], ['/tmp/out.txt']);
    const b = analyzeShell('echo hi >> log');
    assert.ok(b.ok);
    assert.deepEqual([...(b.commands[0]?.writes ?? [])], ['log']);
  });

  test('2> and &> record write targets; 2>&1 dups are not paths', () => {
    const a = analyzeShell('cmd 2> err.log');
    assert.ok(a.ok);
    assert.deepEqual([...(a.commands[0]?.writes ?? [])], ['err.log']);
    const b = analyzeShell('cmd &> all.log');
    assert.ok(b.ok);
    assert.deepEqual([...(b.commands[0]?.writes ?? [])], ['all.log']);
    const c = analyzeShell('cmd > out.log 2>&1');
    assert.ok(c.ok);
    assert.deepEqual([...(c.commands[0]?.writes ?? [])], ['out.log']);
    assert.deepEqual([...(c.commands[0]?.argv ?? [])], ['cmd']);
  });

  test('< input redirect is consumed but not a write', () => {
    const a = analyzeShell('sort < data.txt');
    assert.ok(a.ok);
    assert.deepEqual([...(a.commands[0]?.argv ?? [])], ['sort']);
    assert.deepEqual([...(a.commands[0]?.writes ?? [])], []);
  });

  test('redirect with no target fails closed', () => {
    refused('echo hi >');
  });

  test('redirects apply per pipeline stage', () => {
    const a = analyzeShell('a > x | b > y');
    assert.ok(a.ok);
    assert.deepEqual([...(a.commands[0]?.writes ?? [])], ['x']);
    assert.deepEqual([...(a.commands[1]?.writes ?? [])], ['y']);
  });
});

describe('analyzeShell — fail-closed on dynamic constructs', () => {
  test('command substitution $() and backticks', () => {
    refused('echo $(whoami)');
    refused('echo `id`');
    refused('echo "v: $(cat /etc/shadow)"');
  });

  test('variable expansion — bare, braced, and inside double quotes', () => {
    refused('rm -rf $HOME');
    refused('echo ${PATH}');
    refused('echo "$HOME"');
  });

  test('subshells, grouping, and process substitution', () => {
    refused('(cd /tmp && rm -rf x)');
    refused('diff <(sort a) <(sort b)');
  });

  test('heredocs', () => {
    refused('cat <<EOF');
    refused('bash <<-END');
  });

  test('unterminated quotes', () => {
    refused("echo 'oops");
    refused('echo "oops');
  });

  test('herestring is data — parseable', () => {
    const a = analyzeShell('grep x <<< hello');
    assert.ok(a.ok);
    assert.deepEqual([...(a.commands[0]?.argv ?? [])], ['grep', 'x']);
  });

  test('adversarial: IFS games hide behind $ and fail closed', () => {
    refused('rm$IFS-rf$IFS/');
    refused('X=$IFS; echo a${X}b');
  });

  test('adversarial: escaped/quoted $ is literal and safe', () => {
    assert.deepEqual(argvs('echo \\$\\(whoami\\)'), [['echo', '$(whoami)']]);
    refused('echo \\$(whoami)'); // escaped $ but bare parens — still structure, fail closed
  });

  test('adversarial: exotic whitespace stays inside the word (no hidden splits)', () => {
    // U+00A0 is not IFS - bash passes it through as part of one argument
    assert.deepEqual(argvs('rm\u00a0-rf x'), [['rm\u00a0-rf', 'x']]);
  });

  test('adversarial: arithmetic and history-style constructs fail closed', () => {
    refused('echo $((1+1))');
  });
});
