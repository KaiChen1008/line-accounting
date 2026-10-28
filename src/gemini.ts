import type { AiParseResult, Env } from "./types";
import { GEMINI_API_TIMEOUT_MS } from "./constants";
import { fetchWithTimeout, withTimeout } from "./utils";

const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash-lite";

// Gemini must return a predictable structure; application validation still
// treats the model response as untrusted input.
const responseSchema = {
  type: "OBJECT",
  properties: {
    intent: {
      type: "STRING",
      enum: [
        "record",
        "query_expense_range",
        "clarification_response",
        "cancel_pending",
        "unknown",
      ],
    },
    status: {
      type: "STRING",
      enum: ["ready", "needs_clarification", "query", "cancelled", "unknown"],
    },
    entries: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          amount: { type: "NUMBER", nullable: true },
          amount_expression: { type: "STRING", nullable: true },
          item: { type: "STRING" },
          category: { type: "STRING", nullable: true },
          date: { type: "STRING", nullable: true },
        },
        required: ["amount", "amount_expression", "item", "category", "date"],
      },
    },
    start_date: { type: "STRING", nullable: true },
    end_date: { type: "STRING", nullable: true },
    missing_info: { type: "ARRAY", items: { type: "STRING" } },
    question: { type: "STRING", nullable: true },
  },
  required: [
    "intent",
    "status",
    "entries",
    "start_date",
    "end_date",
    "missing_info",
    "question",
  ],
} as Record<string, unknown>;

function systemPrompt(currentDate: string, pendingDraft: unknown): string {
  return `
你是專為台灣使用者打造的記帳資料解析器。支援記帳、查詢、補充、修改、取消草稿等功能。請依照使用者輸入的文字或收據照片，解析出支出品名、金額、分類、日期等資訊，並回傳 JSON。請注意以下規則：
CURRENT_DATE_TAIPEI=${currentDate}
只回傳符合 JSON Schema 的 JSON，不要 Markdown，不要解釋。
所有未指定日期的支出使用 CURRENT_DATE_TAIPEI；昨天、前天依此日期計算，日期輸出 YYYY-MM-DD。年份不明確或日期衝突時，status=needs_clarification。
所有查詢一律使用 intent=query_expense_range；請根據使用者原始訊息與 CURRENT_DATE_TAIPEI，直接計算並回傳 start_date、end_date，格式為 YYYY-MM-DD。相對日期例如今天、昨天、最近 7 天、本月，都要先換算成實際日期；日期不明確時回傳 null 並使用 status=needs_clarification。非查詢意圖的 start_date、end_date 必須回傳 null。
只允許以下分類完整字串：食物 🍽️、飲品 🧃、咖啡 ☕️、交通 🚌、消費 👜、娛樂 🎳、居家 🏡、3C 📱、醫藥 🏥、房租 🏠、其他 🏷️。
咖啡原則上分類為咖啡 ☕️；任何「請 貝 ...」項目一律分類為消費 👜，且保留原始品名；全聯的水+紅茶+牛奶、綠茶+水等飲用組合分類居家 🏡；游泳、教練課分類消費 👜。
品名保留使用者原始輸入，不要改寫。支援多行、多筆支出。amount_expression 只保存使用者明確寫出的算式，例如 306+240、1430/2；後端會計算，無法辨識或不確定的金額必須是 null 並詢問，不能猜。
若目前有待確認草稿，使用者的訊息通常是對該草稿的補充或修改；只修改指定欄位，並回傳套用後的完整 entries。若修改對象或內容不明確，status=needs_clarification 並提出具體 question。若訊息是全新獨立支出，仍回傳 record，但由後端阻擋並請使用者先完成或取消舊草稿。
目前待確認草稿：${JSON.stringify(pendingDraft ?? null)}`;
}

export async function parseWithGemini(
  env: Env,
  input: { text?: string; imageBytes?: ArrayBuffer; imageMimeType?: string },
  currentDate: string,
  pendingDraft?: unknown,
): Promise<AiParseResult> {
  // Text and receipt images share the same prompt and structured output path.
  const parts: Array<Record<string, unknown>> = [
    {
      text: `${systemPrompt(currentDate, pendingDraft)}\n使用者輸入：${input.text || "（收據照片，請辨識）"}`,
    },
  ];
  if (input.imageBytes && input.imageMimeType) {
    let binary = "";
    for (const byte of new Uint8Array(input.imageBytes))
      binary += String.fromCharCode(byte);
    parts.push({
      inlineData: { mimeType: input.imageMimeType, data: btoa(binary) },
    });
  }

  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  return requestGemini(env, model, parts);
}

async function requestGemini(
  env: Env,
  model: string,
  parts: Array<Record<string, unknown>>,
): Promise<AiParseResult> {
  const response = await fetchWithTimeout(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
        },
      }),
    },
    GEMINI_API_TIMEOUT_MS,
    "Gemini API timeout",
  );
  if (!response.ok) throw new Error(`Gemini API error ${response.status}`);
  const payload = await withTimeout(
    response.json() as Promise<{
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    }>,
    GEMINI_API_TIMEOUT_MS,
    "Gemini API response timeout",
  );
  const text =
    payload.candidates?.[0]?.content?.parts
      ?.map((part) => part.text || "")
      .join("") || "";
  const parsed = JSON.parse(text) as AiParseResult;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new Error("Gemini 回傳格式無效");
  }
  return parsed;
}
