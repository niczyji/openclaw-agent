// core/budget.ts
import type { Usage } from "./types.js";

/**
 * Budget ist die *einzige* Source of Truth für Limits.
 * Toolloop fragt nur: "darf ich noch?" und "bitte buchen".
 */

export type ToolKind = "read" | "write" | "other";

export type BudgetLimits = Readonly<{
  /** Max LLM calls (= steps) in one run */
  maxSteps: number;

  /** Max tool calls (approved + executed) in one run */
  maxToolCalls: number;

  /** Optional: cap total tokens consumed (input+output) across the run */
  maxTotalTokens?: number;

  /** Optional: cap total output tokens across the run (sum of outputs) */
  maxTotalOutputTokens?: number;

  /** Optional: cap total input tokens across the run (sum of inputs) */
  maxTotalInputTokens?: number;

  /** Optional: cap reads/writes (if you classify tools) */
  maxReads?: number;
  maxWrites?: number;
}>;

export type BudgetState = Readonly<{
  limits: BudgetLimits;

  stepsUsed: number;
  toolCallsUsed: number;

  readsUsed: number;
  writesUsed: number;

  totalTokensUsed: number;
  totalInputTokensUsed: number;
  totalOutputTokensUsed: number;
}>;

export function createBudget(limits: BudgetLimits): BudgetState {
  return {
    limits: normalizeLimits(limits),
    stepsUsed: 0,
    toolCallsUsed: 0,
    readsUsed: 0,
    writesUsed: 0,
    totalTokensUsed: 0,
    totalInputTokensUsed: 0,
    totalOutputTokensUsed: 0,
  };
}

function normalizeLimits(l: BudgetLimits): BudgetLimits {
  return {
    maxSteps: Math.max(1, Math.trunc(l.maxSteps)),
    maxToolCalls: Math.max(0, Math.trunc(l.maxToolCalls)),
    maxTotalTokens:
      l.maxTotalTokens !== undefined
        ? Math.max(0, Math.trunc(l.maxTotalTokens))
        : undefined,
    maxTotalOutputTokens:
      l.maxTotalOutputTokens !== undefined
        ? Math.max(0, Math.trunc(l.maxTotalOutputTokens))
        : undefined,
    maxTotalInputTokens:
      l.maxTotalInputTokens !== undefined
        ? Math.max(0, Math.trunc(l.maxTotalInputTokens))
        : undefined,
    maxReads:
      l.maxReads !== undefined
        ? Math.max(0, Math.trunc(l.maxReads))
        : undefined,
    maxWrites:
      l.maxWrites !== undefined
        ? Math.max(0, Math.trunc(l.maxWrites))
        : undefined,
  };
}

export function stepsLeft(b: BudgetState): number {
  return b.limits.maxSteps - b.stepsUsed;
}
export function toolCallsLeft(b: BudgetState): number {
  return b.limits.maxToolCalls - b.toolCallsUsed;
}
export function readsLeft(b: BudgetState): number | undefined {
  return b.limits.maxReads === undefined
    ? undefined
    : b.limits.maxReads - b.readsUsed;
}
export function writesLeft(b: BudgetState): number | undefined {
  return b.limits.maxWrites === undefined
    ? undefined
    : b.limits.maxWrites - b.writesUsed;
}

export function canCallModel(b: BudgetState): boolean {
  if (stepsLeft(b) <= 0) return false;
  if (
    b.limits.maxTotalTokens !== undefined &&
    b.totalTokensUsed >= b.limits.maxTotalTokens
  )
    return false;
  if (
    b.limits.maxTotalInputTokens !== undefined &&
    b.totalInputTokensUsed >= b.limits.maxTotalInputTokens
  )
    return false;
  if (
    b.limits.maxTotalOutputTokens !== undefined &&
    b.totalOutputTokensUsed >= b.limits.maxTotalOutputTokens
  )
    return false;
  return true;
}

export function canCallTool(b: BudgetState, kind: ToolKind): boolean {
  if (toolCallsLeft(b) <= 0) return false;

  if (
    kind === "read" &&
    b.limits.maxReads !== undefined &&
    b.readsUsed >= b.limits.maxReads
  )
    return false;
  if (
    kind === "write" &&
    b.limits.maxWrites !== undefined &&
    b.writesUsed >= b.limits.maxWrites
  )
    return false;

  return true;
}

/**
 * Reserve one model call (step). Throws if not allowed.
 */
export function bookModelCall(b: BudgetState): BudgetState {
  if (!canCallModel(b)) {
    throw new Error("Budget exhausted: model call not allowed");
  }
  return { ...b, stepsUsed: b.stepsUsed + 1 };
}

/**
 * Apply usage from a completed model call.
 */
export function bookUsage(b: BudgetState, usage: Usage): BudgetState {
  const inTok = Math.max(0, Math.trunc(usage.inputTokens));
  const outTok = Math.max(0, Math.trunc(usage.outputTokens));
  const total = Math.max(0, Math.trunc(usage.totalTokens));

  const next: BudgetState = {
    ...b,
    totalTokensUsed: b.totalTokensUsed + total,
    totalInputTokensUsed: b.totalInputTokensUsed + inTok,
    totalOutputTokensUsed: b.totalOutputTokensUsed + outTok,
  };

  // Hard post-check: if provider reports usage that pushes over caps, we still allow the call
  // (it already happened), but we block subsequent calls.
  return next;
}

/**
 * Reserve one tool call. Throws if not allowed.
 */
export function bookToolCall(b: BudgetState, kind: ToolKind): BudgetState {
  if (!canCallTool(b, kind)) {
    throw new Error(`Budget exhausted: tool call not allowed (kind=${kind})`);
  }

  return {
    ...b,
    toolCallsUsed: b.toolCallsUsed + 1,
    readsUsed: kind === "read" ? b.readsUsed + 1 : b.readsUsed,
    writesUsed: kind === "write" ? b.writesUsed + 1 : b.writesUsed,
  };
}
