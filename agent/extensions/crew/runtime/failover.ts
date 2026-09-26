export interface DeadRequestState {
  attempt: number;
  contextPct: number;
  currentModel: string;
  failoverModels: readonly string[];
  usedModels: ReadonlySet<string>;
}

export type DeadRequestRung = { action: "compact" } | { action: "failover"; model: string } | { action: "give_up" };

export function chooseDeadRequestRung(state: DeadRequestState): DeadRequestRung {
  if (state.attempt === 1 && state.contextPct >= 40) return { action: "compact" };
  const model = state.failoverModels.find((m) => m !== state.currentModel && !state.usedModels.has(m));
  return model && state.attempt <= 2 ? { action: "failover", model } : { action: "give_up" };
}
