import { describe, expect, it } from "vitest";
import { parseSheetExpenseRow } from "../src/google-sheets";
import { lastThreeDaysFlex, todayFlex } from "../src/line";
import { parseSyncDays, sheetSourceKey } from "../src/sheet-sync";

const dates = new Set(["2026-10-22", "2026-10-23", "2026-10-24"]);

describe("Google Sheet expense sync parsing", () => {
  it("parses a valid row in the three-day range", () => {
    expect(parseSheetExpenseRow(82, ["2026-10-24", "NT$ 105", "午餐", "食物 🍽️"], dates)).toEqual({
      kind: "valid",
      row: { rowNumber: 82, date: "2026-10-24", amount: 105, item: "午餐", category: "食物 🍽️" },
    });
  });

  it("ignores valid rows outside the requested date range", () => {
    expect(parseSheetExpenseRow(81, ["2026-10-21", "100", "早餐", "食物 🍽️"], dates)).toEqual({ kind: "outside_range" });
  });

  it("reports malformed rows instead of importing them", () => {
    expect(parseSheetExpenseRow(83, ["2026-10-24", "100", "早餐", "未知分類"], dates)).toEqual({
      kind: "invalid",
      reason: "分類不在支援清單：未知分類",
    });
  });

  it("builds a Flex chart for the three daily totals", () => {
    const message = lastThreeDaysFlex([
      { date: "2026-10-22", total: 100, count: 1 },
      { date: "2026-10-23", total: 0, count: 0 },
      { date: "2026-10-24", total: 250, count: 2 },
    ]) as { type: string; altText?: string; contents?: { body?: { contents?: unknown[] } } };
    expect(message.type).toBe("flex");
    expect(message.altText).toContain("NT$ 350");
    expect(message.contents?.body?.contents?.length).toBeGreaterThan(0);
  });

  it("builds a Flex card for today's total", () => {
    const message = todayFlex({ date: "2026-10-24", total: 105, count: 1 }) as { type: string; altText?: string; contents?: { body?: { contents?: unknown[] } } };
    expect(message.type).toBe("flex");
    expect(message.altText).toContain("NT$ 105");
    expect(message.contents?.body?.contents?.length).toBeGreaterThan(0);
  });

  it("uses a stable sheet row source key for idempotent sync", () => {
    expect(sheetSourceKey(12345, 82)).toBe("sheet:12345:82");
    expect(sheetSourceKey(12345, 82)).toBe(sheetSourceKey(12345, 82));
  });

  it("accepts natural sync requests for five days", () => {
    expect(parseSyncDays("同步最近五天")).toBe(5);
    expect(parseSyncDays("同步最近五天的資料到 D1 裡面，以寫入的不要寫兩次")).toBe(5);
    expect(parseSyncDays("同步最近三天的開銷")).toBe(3);
    expect(parseSyncDays("最近五天花多少")).toBeNull();
  });
});
