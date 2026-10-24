import { isIsoDate } from "./validation";

export const MAX_QUERY_DAYS = 31;

export interface ExpenseDateRange {
  startDate: string;
  endDate: string;
  days: number;
}

export interface ParsedExpenseQuery {
  range?: ExpenseDateRange;
  error?: string;
}

// The AI resolves natural-language dates. This function only validates the
// normalized values before they are used in a D1 query.
export function normalizeExpenseDateRange(
  startDate: unknown,
  endDate: unknown,
): ParsedExpenseQuery {
  if (!isIsoDate(startDate) || !isIsoDate(endDate))
    return { error: "AI 回傳的查詢日期格式無效。" };
  if (startDate > endDate) return { error: "開始日期不可晚於結束日期。" };
  const days = dateDistance(startDate, endDate) + 1;
  if (days > MAX_QUERY_DAYS)
    return { error: `查詢期限最多 ${MAX_QUERY_DAYS} 天，請縮短日期範圍。` };
  return { range: { startDate, endDate, days } };
}

function dateDistance(startDate: string, endDate: string): number {
  return Math.round(
    (Date.parse(`${endDate}T00:00:00Z`) -
      Date.parse(`${startDate}T00:00:00Z`)) /
      86_400_000,
  );
}
