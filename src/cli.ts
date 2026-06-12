// CLI entry (DESIGN §11): main() is the thinnest possible shell over dispatch.
// It binds the real effects — stdout/stderr, home/cwd, a SIGINT-driven abort
// signal, and line-buffered stdin for the REPL — and hands the rest to the
// pure-ish dispatch router. All routing, parsing, and exit-code logic lives in
// ui/cli/dispatch.ts so it can be tested offline; this file only touches the
// process and the terminal.

import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { dispatch, type DispatchPorts } from './ui/cli/dispatch.ts';

function makeLineReader(): () => Promise<string | null> {
  const rl = createInterface({ input: process.stdin });
  const iter = rl[Symbol.asyncIterator]();
  return async () => {
    const { value, done } = await iter.next();
    return done ? null : (value as string);
  };
}

export async function main(argv: readonly string[]): Promise<number> {
  const controller = new AbortController();
  const onSigint = (): void => controller.abort(new Error('interrupted'));
  process.once('SIGINT', onSigint);

  const wantsRepl = argv[0] === undefined || argv[0] === 'repl';

  const ports: DispatchPorts = {
    write: (s) => process.stdout.write(s),
    writeErr: (s) => process.stderr.write(s),
    homeDir: homedir(),
    cwd: process.cwd(),
    signal: controller.signal,
    ...(wantsRepl ? { nextLine: makeLineReader() } : {}),
  };

  try {
    return await dispatch(argv, ports);
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
