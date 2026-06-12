import { pathToFileURL } from 'node:url';
import { VERSION } from './version.ts';

// Subcommand surface lands at P10 (DESIGN §11); until then the CLI reports identity.
export async function main(argv: readonly string[]): Promise<number> {
  const cmd = argv[0] ?? 'repl';
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(`vegito ${VERSION}`);
    return 0;
  }
  console.log(`vegito ${VERSION} — scaffold build; subcommands arrive with phase P10`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}
