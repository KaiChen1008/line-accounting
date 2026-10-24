import { describe, expect, it } from "vitest";
import { calculateExpression, validateAndNormalizeResult } from "../src/validation";

describe("safe amount expressions", () => {
  it("calculates supported arithmetic without eval", () => {
    expect(calculateExpression("306+240")).toBe(546);
    expect(calculateExpression("1430/2")).toBe(715);
    expect(calculateExpression("200-75")).toBe(125);
  });

  it("rejects division by zero", () => {
    expect(() => calculateExpression("1/0")).toThrow();
  });
});

describe("AI output validation", () => {
  it("uses the supplied Taiwan date and preserves exact categories", () => {
    const result = validateAndNormalizeResult({
      intent: "record",
      status: "ready",
      entries: [{ amount: 60, amount_expression: null, item: "咖啡", category: "咖啡 ☕", date: null }],
      missing_info: [],
      question: null,
    }, "2026-10-23");
    expect(result.missingInfo).toEqual([]);
    expect(result.entries[0].date).toBe("2026-10-23");
    expect(result.entries[0].category).toBe("咖啡 ☕");
  });

  it("does not treat an unresolved amount as ready", () => {
    const result = validateAndNormalizeResult({
      intent: "record",
      status: "ready",
      entries: [{ amount: null, amount_expression: null, item: "午餐", category: "食物 🍽️", date: "2026-10-23" }],
      missing_info: [],
      question: null,
    }, "2026-10-23");
    expect(result.missingInfo.length).toBeGreaterThan(0);
    expect(result.entries[0].amount).toBeNull();
  });
});
