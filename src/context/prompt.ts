// Three-tier system prompt (DESIGN §6). The system array fed to the wire is
// an ordered list of tiers whose stable prefix must stay byte-identical across
// every turn of a session (D4 cache discipline). We freeze the bytes at
// construction: tiers() returns the same frozen strings forever, so the wire
// can place cache_control at the tier tail and never miss.
//
//   T1 — identity + constitution. Static per version; the cache anchor.
//   T2 — environment + packs + memory snapshot. Frozen at session start;
//        mid-session changes belong in T3 or the next session, never here.
//
// T3 (dynamic tail) is rare and lives in the message stream as fragments
// (see fragments.ts), not in the system array — so it cannot perturb the
// cached prefix.

export interface PromptEnvironment {
  readonly cwd: string;
  readonly platform: string;
  readonly date: string;
}

export interface MemoryFile {
  readonly path: string;
  readonly content: string;
}

export interface PromptParts {
  readonly identity: string;
  readonly constitution: readonly string[];
  readonly environment: PromptEnvironment;
  readonly memoryFiles: readonly MemoryFile[];
  readonly packs: readonly string[];
}

export interface SystemPrompt {
  /** The frozen, byte-stable system tiers. Identical across all turns. */
  tiers(): readonly string[];
}

function renderT1(parts: PromptParts): string {
  const lines = [parts.identity];
  if (parts.constitution.length > 0) {
    lines.push('', '## Operating principles', ...parts.constitution.map((c) => `- ${c}`));
  }
  return lines.join('\n');
}

function renderT2(parts: PromptParts): string {
  const { environment, packs, memoryFiles } = parts;
  const lines = [
    '## Environment',
    `- cwd: ${environment.cwd}`,
    `- platform: ${environment.platform}`,
    `- date: ${environment.date}`,
  ];
  if (packs.length > 0) {
    lines.push('', '## Active packs', ...packs.map((p) => `- ${p}`));
  }
  for (const file of memoryFiles) {
    lines.push('', `## Memory: ${file.path}`, file.content);
  }
  return lines.join('\n');
}

export function createSystemPrompt(parts: PromptParts): SystemPrompt {
  // Render once, at construction, capturing a deep copy by value. Later
  // mutation of the caller's objects cannot reach the frozen strings.
  const frozen = Object.freeze([renderT1(parts), renderT2(parts)] as const);
  return {
    tiers(): readonly string[] {
      return frozen;
    },
  };
}
