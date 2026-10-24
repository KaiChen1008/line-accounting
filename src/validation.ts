import { MAX_AMOUNT, MAX_ENTRIES_PER_DRAFT, MAX_ITEM_LENGTH } from "./constants";
import { CATEGORIES, type AiParseResult, type Category, type ExpenseEntry } from "./types";
import { addDays, taipeiDate } from "./utils";

export interface ValidationResult {
  entries: ExpenseEntry[];
  missingInfo: string[];
  question: string | null;
}

class ExpressionParser {
  private index = 0;
  private readonly tokens: string[];

  constructor(expression: string) {
    const tokens: string[] = [];
    let cursor = 0;
    while (cursor < expression.length) {
      const match = expression.slice(cursor).match(/^\s*(\d+(?:\.\d+)?|[()+\-*/])/);
      if (!match) throw new Error("invalid expression");
      tokens.push(match[1]);
      cursor += match[0].length;
    }
    this.tokens = tokens;
  }

  parse(): number {
    const result = this.parseAddSub();
    if (this.index !== this.tokens.length || !Number.isFinite(result)) throw new Error("invalid expression");
    return result;
  }

  // Standard operator precedence: multiplication/division before addition/
  // subtraction, with unary signs and parentheses handled at the bottom.
  private parseAddSub(): number {
    let result = this.parseMulDiv();
    while (this.index < this.tokens.length && ["+", "-"].includes(this.tokens[this.index])) {
      const operator = this.tokens[this.index++];
      const right = this.parseMulDiv();
      result = operator === "+" ? result + right : result - right;
    }
    return result;
  }

  private parseMulDiv(): number {
    let result = this.parseUnary();
    while (this.index < this.tokens.length && ["*", "/"].includes(this.tokens[this.index])) {
      const operator = this.tokens[this.index++];
      const right = this.parseUnary();
      if (operator === "/" && right === 0) throw new Error("division by zero");
      result = operator === "*" ? result * right : result / right;
    }
    return result;
  }

  private parseUnary(): number {
    const token = this.tokens[this.index];
    if (token === "+" || token === "-") {
      this.index += 1;
      const value = this.parseUnary();
      return token === "-" ? -value : value;
    }
    if (token === "(") {
      this.index += 1;
      const value = this.parseAddSub();
      if (this.tokens[this.index++] !== ")") throw new Error("unclosed expression");
      return value;
    }
    if (!token || !/^\d+(?:\.\d+)?$/.test(token)) throw new Error("expected number");
    this.index += 1;
    return Number(token);
  }
}

export function calculateExpression(expression: string): number {
  // Expressions are evaluated locally instead of asking Gemini to calculate
  // them, which makes arithmetic deterministic and bounded.
  const normalized = expression.trim();
  if (!/^[\d\s()+\-*/.]+$/.test(normalized) || normalized.length > 100) throw new Error("算式格式無效");
  const value = new ExpressionParser(normalized).parse();
  if (!Number.isFinite(value) || value <= 0 || value > MAX_AMOUNT) throw new Error("金額超出有效範圍");
  return Math.round(value * 100) / 100;
}

export function isCategory(value: unknown): value is Category {
  return typeof value === "string" && (CATEGORIES as readonly string[]).includes(value);
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeAmount(entry: ExpenseEntry): { amount: number | null; error?: string } {
  if (entry.amount_expression) {
    try {
      return { amount: calculateExpression(entry.amount_expression) };
    } catch (error) {
      return { amount: null, error: error instanceof Error ? error.message : "算式無效" };
    }
  }
  if (entry.amount === null || entry.amount === undefined) return { amount: null };
  if (typeof entry.amount !== "number" || !Number.isFinite(entry.amount) || entry.amount <= 0 || entry.amount > MAX_AMOUNT) {
    return { amount: null, error: "金額必須是有效的正數" };
  }
  return { amount: Math.round(entry.amount * 100) / 100 };
}

export function validateAndNormalizeResult(result: AiParseResult, currentDate = taipeiDate()): ValidationResult {
  // Normalize untrusted model output into the small shape used by drafts and
  // reject missing or invalid fields before anything reaches D1 or Sheets.
  const missingInfo = Array.isArray(result.missing_info) ? result.missing_info.filter((item) => typeof item === "string") : [];
  const entries = Array.isArray(result.entries) ? result.entries.slice(0, MAX_ENTRIES_PER_DRAFT) : [];
  const normalized: ExpenseEntry[] = [];

  if (result.intent === "record" || result.intent === "clarification_response") {
    if (entries.length === 0) missingInfo.push("支出項目");
    for (const entry of entries) {
      const amount = normalizeAmount(entry);
      const item = typeof entry.item === "string" ? entry.item.trim().slice(0, MAX_ITEM_LENGTH) : "";
      const category = isCategory(entry.category) ? entry.category : null;
      const date = entry.date === null || entry.date === undefined ? null : entry.date;
      normalized.push({
        amount: amount.amount,
        amount_expression: typeof entry.amount_expression === "string" ? entry.amount_expression.trim() : null,
        item,
        category,
        date: isIsoDate(date) ? date : null,
      });
      if (!item) missingInfo.push("品名");
      if (amount.error) missingInfo.push(amount.error);
      if (amount.amount === null && !amount.error) missingInfo.push("金額");
      if (!category) missingInfo.push("分類");
      if (date !== null && !isIsoDate(date)) missingInfo.push("日期");
    }
  }

  const uniqueMissing = [...new Set(missingInfo)];
  const complete = normalized.length > 0 && normalized.every((entry) =>
    entry.amount !== null && Boolean(entry.item) && isCategory(entry.category) && (entry.date === null || isIsoDate(entry.date)),
  );
  const finalEntries = normalized.map((entry) => ({ ...entry, date: entry.date ?? currentDate }));
  return {
    entries: finalEntries,
    missingInfo: complete ? [] : uniqueMissing.length > 0 ? uniqueMissing : ["請補充支出金額、品名、分類或日期"],
    question: complete ? null : result.question || `請補充：${uniqueMissing.join("、") || "支出資料"}。`,
  };
}

export function normalizeRelativeDate(value: string, currentDate = taipeiDate()): string | null {
  const normalized = value.replace(/\s/g, "");
  if (normalized === "今天" || normalized === "今日") return currentDate;
  if (normalized === "昨天") return addDays(currentDate, -1);
  if (normalized === "前天") return addDays(currentDate, -2);
  return null;
}
