import { addDays } from "./utils";

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

const QUERY_REQUEST_WORDS = /(查詢|查一下|統計|花多少|花了多少|總額|每天|每日|想知道|看一下)/;
const EXPENSE_WORDS = /(開銷|支出|消費|花費)/;
const PERIOD_WORDS = /(今天|今日|昨天|前天|最近|近|過去|本月|這個月|這月|一個月|\d+\s*(?:天|日)|\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日?)/;
const DATE_TOKEN = "(?:\\d{4}[-/]\\d{1,2}[-/]\\d{1,2}|\\d{1,2}[/-]\\d{1,2}|\\d{1,2}月\\d{1,2}日?)";
const DATE_RANGE_PATTERN = new RegExp(`(${DATE_TOKEN})\\s*(?:到|至|～|~|—|-)\\s*(${DATE_TOKEN})`);

const CHINESE_NUMBERS: Record<string, number> = {
  零: 0,
  一: 1,
  二: 2,
  兩: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  週: 7,
  周: 7,
};

export function parseExpenseQuery(input: string, currentDate: string): ParsedExpenseQuery | null {
  // Parse the most specific forms first: explicit ranges, month queries,
  // relative day counts, and finally single dates.
  if (!QUERY_REQUEST_WORDS.test(input) && !(EXPENSE_WORDS.test(input) && PERIOD_WORDS.test(input))) return null;

  const explicitRange = input.match(DATE_RANGE_PATTERN);
  if (explicitRange) {
    const start = parseDateToken(explicitRange[1], currentDate);
    const end = parseDateToken(explicitRange[2], currentDate, start?.slice(0, 4));
    if (!start || !end) return { error: "日期格式無法辨識，請使用 YYYY-MM-DD 到 YYYY-MM-DD。" };
    return makeRange(start, end);
  }

  if (/(本月|這個月|這月)/.test(input)) {
    const monthStart = `${currentDate.slice(0, 7)}-01`;
    return makeRange(monthStart, currentDate);
  }

  const relativeDays = input.match(/(?:最近|近|過去|這|本)?\s*(\d+|[一二兩三四五六七八九十]+)\s*(?:天|日)/);
  if (relativeDays) {
    const days = parseChineseNumber(relativeDays[1]);
    if (!days) return { error: "查詢天數無法辨識，請提供 1 到 31 天。" };
    return makeRelativeRange(currentDate, days);
  }

  if (/(最近|近|過去|這|本)\s*(?:一個月|1個月|一月|1月)/.test(input)) return makeRelativeRange(currentDate, 30);
  if (/(最近|近|過去|這|本)\s*(一週|1週|一周|1周)/.test(input)) return makeRelativeRange(currentDate, 7);
  if (/前天/.test(input)) return makeRelativeRange(currentDate, 1, -2);
  if (/昨天/.test(input)) return makeRelativeRange(currentDate, 1, -1);
  if (/(今天|今日)/.test(input)) return makeRange(currentDate, currentDate);

  const singleDate = input.match(new RegExp(`(${DATE_TOKEN})`));
  if (singleDate) {
    const date = parseDateToken(singleDate[1], currentDate);
    return date ? makeRange(date, date) : { error: "日期格式無法辨識。" };
  }

  return { error: "請指定查詢期限，例如「今天」、「最近 7 天」或「10/01 到 10/24」。" };
}

function makeRelativeRange(endDate: string, days: number, offset = 0): ParsedExpenseQuery {
  // A relative range is inclusive of its end date. For example, seven days
  // ending today starts six days before today.
  if (!Number.isInteger(days) || days < 1 || days > MAX_QUERY_DAYS) return { error: `查詢期限最多 ${MAX_QUERY_DAYS} 天，請縮短日期範圍。` };
  const adjustedEnd = addDays(endDate, offset);
  return makeRange(addDays(adjustedEnd, -(days - 1)), adjustedEnd);
}

function makeRange(startDate: string, endDate: string): ParsedExpenseQuery {
  if (startDate > endDate) return { error: "開始日期不可晚於結束日期。" };
  const days = dateDistance(startDate, endDate) + 1;
  if (days > MAX_QUERY_DAYS) return { error: `查詢期限最多 ${MAX_QUERY_DAYS} 天，請縮短日期範圍。` };
  return { range: { startDate, endDate, days } };
}

function parseChineseNumber(value: string): number | null {
  // Support the common Chinese forms used in chat, such as 三天 and 十四天.
  if (/^\d+$/.test(value)) return Number(value);
  if (value === "十") return 10;
  if (value.length === 2 && value[0] === "十") return 10 + (CHINESE_NUMBERS[value[1]] || 0);
  if (value.length === 2 && value[1] === "十") return (CHINESE_NUMBERS[value[0]] || 0) * 10;
  if (value.length === 3 && value[1] === "十") return (CHINESE_NUMBERS[value[0]] || 0) * 10 + (CHINESE_NUMBERS[value[2]] || 0);
  return value.length === 1 ? CHINESE_NUMBERS[value] || null : null;
}

function parseDateToken(value: string, currentDate: string, yearHint?: string): string | null {
  const normalized = value.replace(/年|月/g, "-").replace(/日/g, "").replace(/\//g, "-").replace(/--/g, "-");
  const parts = normalized.split("-").filter(Boolean).map(Number);
  let year: number;
  let month: number;
  let day: number;
  if (parts.length === 3) [year, month, day] = parts;
  else if (parts.length === 2) {
    year = Number(yearHint || currentDate.slice(0, 4));
    [month, day] = parts;
  } else return null;

  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function dateDistance(startDate: string, endDate: string): number {
  return Math.round((Date.parse(`${endDate}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
}
