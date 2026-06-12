// Shell command analysis (DESIGN §7.2): a conservative bash tokenizer for the
// permission gate. It understands the static fragment of shell — words,
// quotes, separators, redirections — and FAILS CLOSED on anything dynamic
// ($expansion, substitution, subshells, heredocs): those return { ok: false }
// and the gate escalates to ask. The tokenizer never guesses; a wrong "ok"
// here would let `rm$IFS-rf` impersonate a harmless word.

export interface ShellCommand {
  /** Words of one pipeline stage, env-assignment prefix stripped. */
  readonly argv: readonly string[];
  /** File paths this stage writes via redirection (>, >>, 2>, &>). */
  readonly writes: readonly string[];
}

export type ShellAnalysis =
  | { readonly ok: true; readonly commands: readonly ShellCommand[] }
  | { readonly ok: false; readonly reason: string };

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const DIGITS = /^\d+$/;

export function analyzeShell(input: string): ShellAnalysis {
  const commands: ShellCommand[] = [];
  let argv: string[] = [];
  let writes: string[] = [];
  let word = '';
  let started = false; // distinguishes '' (real empty arg) from no word
  let quoted = false; // any part of the current word was quoted
  let pending: 'write' | 'consume' | undefined; // redirect awaiting its target
  let failure: string | undefined;
  let i = 0;
  const n = input.length;

  // Finish the current word: route it to a pending redirect or to argv.
  const endWord = (): void => {
    if (!started) return;
    if (pending === undefined) argv.push(word);
    else {
      if (pending === 'write') writes.push(word);
      pending = undefined;
    }
    word = '';
    started = false;
    quoted = false;
  };

  // Finish the current command (separator or EOF). Empty commands between
  // separators are dropped; a dangling redirect is an error.
  const endCommand = (): boolean => {
    endWord();
    if (pending !== undefined) {
      failure = 'redirect missing target';
      return false;
    }
    let cmd: readonly string[] = argv;
    while (cmd.length > 0 && ENV_ASSIGN.test(cmd[0] ?? '')) cmd = cmd.slice(1);
    if (cmd.length > 0 || writes.length > 0) commands.push({ argv: cmd, writes });
    argv = [];
    writes = [];
    return true;
  };

  while (i < n) {
    const c = input[i] ?? '';

    if (c === "'") {
      const close = input.indexOf("'", i + 1);
      if (close === -1) return { ok: false, reason: 'unterminated single quote' };
      word += input.slice(i + 1, close);
      started = true;
      quoted = true;
      i = close + 1;
      continue;
    }

    if (c === '"') {
      started = true;
      quoted = true;
      i++;
      let closed = false;
      while (i < n) {
        const d = input[i] ?? '';
        if (d === '"') {
          closed = true;
          i++;
          break;
        }
        if (d === '\\') {
          const e = input[i + 1] ?? '';
          if (e === '"' || e === '\\') {
            word += e;
            i += 2;
            continue;
          }
          word += d; // bash keeps the backslash before non-special chars
          i++;
          continue;
        }
        if (d === '$') return { ok: false, reason: 'expansion ($) inside double quotes' };
        if (d === '`') return { ok: false, reason: 'command substitution (`) inside double quotes' };
        word += d;
        i++;
      }
      if (!closed) return { ok: false, reason: 'unterminated double quote' };
      continue;
    }

    if (c === '\\') {
      const e = input[i + 1];
      if (e === undefined) return { ok: false, reason: 'trailing backslash' };
      if (e === '\n') {
        i += 2; // line continuation
        continue;
      }
      word += e;
      started = true;
      i += 2;
      continue;
    }

    if (c === '$') return { ok: false, reason: 'expansion or substitution ($)' };
    if (c === '`') return { ok: false, reason: 'command substitution (backtick)' };
    if (c === '(' || c === ')') return { ok: false, reason: 'subshell or grouping ( )' };

    if (c === ' ' || c === '\t' || c === '\r') {
      endWord();
      i++;
      continue;
    }

    if (c === '\n' || c === ';') {
      if (!endCommand()) return { ok: false, reason: failure ?? 'parse error' };
      i++;
      continue;
    }

    if (c === '#' && !started) {
      const nl = input.indexOf('\n', i);
      i = nl === -1 ? n : nl; // leave the newline to terminate the command
      continue;
    }

    if (c === '|') {
      // | pipes, |& pipes stderr too, || sequences — all split commands
      if (!endCommand()) return { ok: false, reason: failure ?? 'parse error' };
      i += input[i + 1] === '|' || input[i + 1] === '&' ? 2 : 1;
      continue;
    }

    if (c === '&') {
      if (input[i + 1] === '>') {
        // &> / &>> redirect both streams to a file
        endWord();
        if (pending !== undefined) return { ok: false, reason: 'redirect missing target' };
        pending = 'write';
        i += input[i + 2] === '>' ? 3 : 2;
        continue;
      }
      // && and & both end the command
      if (!endCommand()) return { ok: false, reason: failure ?? 'parse error' };
      i += input[i + 1] === '&' ? 2 : 1;
      continue;
    }

    if (c === '>' || c === '<') {
      // an adjacent all-digit unquoted word is the fd prefix (2>), not an arg
      if (started && !quoted && DIGITS.test(word)) {
        word = '';
        started = false;
      } else {
        endWord();
      }
      if (pending !== undefined) return { ok: false, reason: 'redirect missing target' };

      if (c === '<') {
        if (input.startsWith('<<<', i)) {
          pending = 'consume'; // herestring: the next word is data
          i += 3;
          continue;
        }
        if (input.startsWith('<<', i)) return { ok: false, reason: 'heredoc (<<)' };
        if (input[i + 1] === '&') {
          // <&N dup / <&- close: no path involved
          let j = i + 2;
          while (j < n && DIGITS.test(input[j] ?? '')) j++;
          if (j === i + 2 && input[j] === '-') j++;
          if (j === i + 2) return { ok: false, reason: 'redirect missing target' };
          i = j;
          continue;
        }
        pending = 'consume'; // < input redirect: consumed, not a write
        i++;
        continue;
      }

      if (input[i + 1] === '>' || input[i + 1] === '|') {
        pending = 'write'; // >> append, >| clobber
        i += 2;
        continue;
      }
      if (input[i + 1] === '&') {
        let j = i + 2;
        while (j < n && DIGITS.test(input[j] ?? '')) j++;
        const atBoundary = j >= n || /[\s;|&<>]/.test(input[j] ?? '');
        if (j > i + 2 && atBoundary) {
          i = j; // >&N dup (e.g. 2>&1): no path
          continue;
        }
        if (input[i + 2] === '-') {
          i += 3; // >&- close
          continue;
        }
        pending = 'write'; // >&file legacy both-redirect
        i += 2;
        continue;
      }
      pending = 'write'; // plain >
      i++;
      continue;
    }

    word += c;
    started = true;
    i++;
  }

  if (!endCommand()) return { ok: false, reason: failure ?? 'parse error' };
  if (commands.length === 0) return { ok: false, reason: 'empty command' };
  return { ok: true, commands };
}
