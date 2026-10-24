import { describe, expect, it } from "vitest";
import { todayFlex } from "../src/line";

describe("LINE expense messages", () => {
  it("builds a Flex card for today's total", () => {
    const message = todayFlex({
      date: "2026-10-24",
      total: 105,
      count: 1,
    }) as {
      type: string;
      altText?: string;
      contents?: { body?: { contents?: unknown[] } };
    };
    expect(message.type).toBe("flex");
    expect(message.altText).toContain("NT$ 105");
    expect(message.contents?.body?.contents?.length).toBeGreaterThan(0);
  });
});
