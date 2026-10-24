import { describe, expect, it } from "vitest";
import { MAX_QUERY_DAYS, parseExpenseQuery } from "../src/expense-query";

const today = "2026-10-24";

describe("custom expense query ranges", () => {
  it("keeps today queries compatible", () => {
    expect(parseExpenseQuery("今天花多少", today)).toEqual({
      range: { startDate: today, endDate: today, days: 1 },
    });
  });

  it("parses relative day counts", () => {
    expect(parseExpenseQuery("最近 7 天每天花多少", today)).toEqual({
      range: { startDate: "2026-10-18", endDate: today, days: 7 },
    });
    expect(parseExpenseQuery("最近一個月開銷", today)).toEqual({
      range: { startDate: "2026-09-25", endDate: today, days: 30 },
    });
  });

  it("parses explicit dates with an inferred current year", () => {
    expect(parseExpenseQuery("查詢 10/01 到 10/24 的開銷", today)).toEqual({
      range: { startDate: "2026-10-01", endDate: today, days: 24 },
    });
  });

  it("rejects ranges longer than one month", () => {
    const result = parseExpenseQuery("查詢最近 32 天的開銷", today);
    expect(result?.error).toContain(`最多 ${MAX_QUERY_DAYS} 天`);
  });

  it("rejects reversed explicit ranges", () => {
    expect(parseExpenseQuery("查詢 10/24 到 10/01 的開銷", today)).toEqual({
      error: "開始日期不可晚於結束日期。",
    });
  });

  it("does not steal an expense message that merely contains 支出", () => {
    expect(parseExpenseQuery("午餐支出 340", today)).toBeNull();
  });
});
