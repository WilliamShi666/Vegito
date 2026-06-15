export const SELF_MAP_LINES: readonly string[] = Object.freeze([
  'Vegito self-map: meta-harness for forging, running, evaluating, and manually evolving domain harness packs.',
  'Core subsystems: context prompt tiers, CLI/REPL, permissions, tools, packs, forge, sessions, and evolve.',
  'Prompt policy: keep stable T1 short; put workspace facts, packs, memory, permissions, and generated harness lists in bounded dynamic context.',
  'Tool policy: answer from loaded context first; use targeted tools only when current state or verification is needed.',
  'Evolution status: observe/propose/apply/revert and candidate eval paths exist, but harness evolution is manual-triggered by default.',
]);

export function renderSelfMap(): string {
  return ['Vegito self-map', ...SELF_MAP_LINES.map((line) => `- ${line}`)].join('\n');
}

export function renderArchitectureMap(): string {
  return [
    'Vegito architecture',
    '- System prompt: T1 identity/constitution; T2 environment, active packs, memory, generated packs, and self-map.',
    '- Runtime loop: provider events feed the kernel, executor, permission engine, renderer, and session transcript.',
    '- CLI surfaces: run, repl, sessions, packs, forge, and evolve are deterministic dispatch paths.',
    '- Packs: generated harnesses expose persona, onboarding, agents, rubrics, commands, hooks, and memory policy.',
    '- Evolve: review-only by default; apply requires explicit request plus gates, validation, provenance, and revert support.',
  ].join('\n');
}

export function renderEvolutionStatus(): string {
  return [
    'Evolution status',
    '- Default: manual-triggered review/diagnostic flow.',
    '- Implemented path: observe transcripts, propose bounded changes, apply through permission gates, validate, record provenance, and revert.',
    '- Advanced path: candidate/GEPA-style evaluation can score bundles, but does not run automatically.',
    '- Not enabled by default: background harness updates, automatic apply, or costly eval sweeps.',
  ].join('\n');
}
