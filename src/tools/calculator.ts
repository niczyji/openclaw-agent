if (call.tool === "calculator") {
  const expr = call.expression;

  // Debug-safe: nur simple Mathezeichen erlauben
  if (!/^[0-9+\-*/().\s]+$/.test(expr)) {
    return {
      ok: false,
      tool: call.tool,
      error: "Bad expression (allowed: digits, + - * / ( ) . whitespace)",
    };
  }

  try {
    const value = Function(`"use strict"; return (${expr});`)();
    return {
      ok: true,
      tool: call.tool,
      result: { expression: expr, value },
    };
  } catch (e: any) {
    return {
      ok: false,
      tool: call.tool,
      error: `Eval failed: ${String(e?.message ?? e)}`,
    };
  }
}
