// Model profiles (DESIGN §5.2): the neutral description of a model — which
// wire speaks to it and the budgets the context manager plans around.

export type WireKind = 'anthropic' | 'openai';

export interface ModelProfile {
  readonly id: string;
  readonly wire: WireKind;
  readonly contextWindow: number;
  readonly maxOutput: number;
  readonly reasoning: boolean;
  readonly baseUrl?: string;
  readonly aliases?: readonly string[];
}

export function resolveProfile(
  catalog: readonly ModelProfile[],
  idOrAlias: string,
): ModelProfile | undefined {
  return (
    catalog.find((p) => p.id === idOrAlias) ??
    catalog.find((p) => p.aliases?.includes(idOrAlias) === true)
  );
}
