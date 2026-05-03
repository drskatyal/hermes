import type { ActionExecutionResult } from "@hermes/shared/types";

export function formatConfirmation(results: ActionExecutionResult[]): string {
  if (results.length === 0) return "📝 Noted";
  if (results.length === 1) return results[0]!.summary;
  return `Done ${results.length} things:\n` + results.map((r) => `• ${r.summary}`).join("\n");
}
