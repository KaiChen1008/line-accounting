import { describe, expect, it } from "vitest";
import { MAX_QUERY_DAYS, normalizeExpenseDateRange } from "../src/expense-query";

describe("AI expense query ranges", () => {
  it("accepts the normalized range returned by AI", () => {
    expect(normalizeExpenseDateRange("2026-10-18", "2026-10-24")).toEqual({
      range: { startDate: "2026-10-18", endDate: "2026-10-24", days: 7 },
    });
  });

  it("rejects missing or malformed AI dates", () => {
    expect(normalizeExpenseDateRange(null, "2026-10-24")).toEqual({ error: "AI 回傳的查詢日期格式無效。" });
    expect(normalizeExpenseDateRange("2026/10/18", "2026-10-24")).toEqual({ error: "AI 回傳的查詢日期格式無效。" });
  });

  it("rejects ranges longer than one month", () => {
    const result = normalizeExpenseDateRange("2026-09-23", "2026-10-24");
    expect(result.error).toContain(`最多 ${MAX_QUERY_DAYS} 天`);
  });

  it("rejects reversed ranges", () => {
    expect(normalizeExpenseDateRange("2026-10-24", "2026-10-01")).toEqual({
      error: "開始日期不可晚於結束日期。",
    });
  });
});
