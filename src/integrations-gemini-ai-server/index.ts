import { Type, type Schema } from "@google/genai";
import { gemini, GEMINI_FLASH_MODEL, GEMINI_PRO_MODEL } from "./client";

export { Type, type Schema, GEMINI_FLASH_MODEL, GEMINI_PRO_MODEL };

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  /** Optional data: URL image attached to this turn (e.g. a farmer's photo in a consult). */
  imageDataUrl?: string;
}

function dataUrlToInlineData(dataUrl: string) {
  const match = dataUrl.match(/^data:(.+?);base64,(.+)$/);
  return { mimeType: match?.[1] ?? "image/jpeg", data: match?.[2] ?? dataUrl };
}

function turnToContent(turn: ChatTurn) {
  const parts: Array<{ text?: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: turn.content },
  ];
  if (turn.imageDataUrl) parts.push({ inlineData: dataUrlToInlineData(turn.imageDataUrl) });
  return { role: turn.role === "assistant" ? ("model" as const) : ("user" as const), parts };
}

/**
 * Plain multi-turn text chat (Agri Advisor, Agri Doctor replies, Year Plan).
 * Mirrors the shape chiguru-backend's routes already build from stored
 * conversation history — a system prompt plus a list of prior turns. A turn
 * can optionally carry an attached image (e.g. a farmer's photo in a
 * consult) via imageDataUrl.
 */
export async function geminiChat(opts: {
  systemPrompt: string;
  history: ChatTurn[];
  model?: string;
  maxOutputTokens?: number;
}): Promise<string> {
  const response = await gemini.models.generateContent({
    model: opts.model ?? GEMINI_FLASH_MODEL,
    contents: opts.history.map(turnToContent),
    config: {
      systemInstruction: opts.systemPrompt,
      // This model family spends real output tokens on internal "thinking"
      // before the visible answer (observed 200-300+ tokens even for a
      // one-line question) — a low budget here truncates the answer itself,
      // not just makes it short. 2048 is a floor, not a target length.
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  });
  return response.text?.trim() ?? "";
}

/**
 * Same as geminiChat but yields text chunks as they arrive, for the SSE
 * streaming chat endpoint (the frontend renders the reply as it types).
 */
export async function* geminiChatStream(opts: {
  systemPrompt: string;
  history: ChatTurn[];
  model?: string;
  maxOutputTokens?: number;
}): AsyncGenerator<string> {
  const stream = await gemini.models.generateContentStream({
    model: opts.model ?? GEMINI_FLASH_MODEL,
    contents: opts.history.map(turnToContent),
    config: {
      systemInstruction: opts.systemPrompt,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  });

  for await (const chunk of stream) {
    const text = chunk.text;
    if (text) yield text;
  }
}

/**
 * Text generation grounded in live Google Search results (Mandi crop-price
 * fetching — needs today's real prices, not the model's training data).
 * Gemini doesn't support combining Google Search grounding with structured
 * output (responseSchema) in one request, so — same as the prompt already
 * did against OpenAI's web_search tool — this returns plain text with the
 * JSON array embedded in it; the caller extracts/parses it.
 */
export async function geminiSearch(opts: {
  prompt: string;
  model?: string;
  timeoutMs?: number;
}): Promise<string> {
  const response = await gemini.models.generateContent({
    model: opts.model ?? GEMINI_PRO_MODEL,
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    config: {
      tools: [{ googleSearch: {} }],
      httpOptions: opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined,
    },
  });
  return response.text?.trim() ?? "";
}

/**
 * Text-only prompt with a guaranteed JSON shape (Year Plan generation) — same
 * structured-output mode as geminiAnalyzeImage, just without an image part.
 */
export async function geminiGenerateJson<T>(opts: {
  prompt: string;
  responseSchema: Schema;
  model?: string;
  maxOutputTokens?: number;
}): Promise<T> {
  const response = await gemini.models.generateContent({
    model: opts.model ?? GEMINI_FLASH_MODEL,
    contents: [{ role: "user", parts: [{ text: opts.prompt }] }],
    config: {
      responseMimeType: "application/json",
      responseSchema: opts.responseSchema,
      maxOutputTokens: opts.maxOutputTokens ?? 8192,
    },
  });
  const raw = response.text?.trim() ?? "{}";
  return JSON.parse(raw) as T;
}

/**
 * Image + text analysis with a guaranteed JSON shape (Disease Check, worker
 * headcount, Accounts Scan) — uses Gemini's native structured-output mode
 * (responseSchema) rather than asking the model to format JSON in prose and
 * regex-extracting it, so a malformed response can't slip through.
 */
export async function geminiAnalyzeImage<T>(opts: {
  prompt: string;
  imageBase64: string;
  responseSchema: Schema;
  model?: string;
  maxOutputTokens?: number;
  // Extra labeled images alongside the primary one (e.g. each candidate
  // worker's reference photo, for face-match comparison) — each is
  // introduced by its own text label so the prompt can refer back to it
  // ("photo labeled worker-12") when asking Gemini to pick a match.
  extraImages?: { label: string; imageBase64: string }[];
}): Promise<T> {
  const match = opts.imageBase64.match(/^data:(.+?);base64,(.+)$/);
  const mimeType = match?.[1] ?? "image/jpeg";
  const data = match?.[2] ?? opts.imageBase64;

  const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [
    { text: opts.prompt },
    { inlineData: { mimeType, data } },
  ];
  for (const extra of opts.extraImages ?? []) {
    parts.push({ text: extra.label });
    parts.push({ inlineData: dataUrlToInlineData(extra.imageBase64) });
  }

  const response = await gemini.models.generateContent({
    model: opts.model ?? GEMINI_PRO_MODEL,
    contents: [{ role: "user", parts }],
    config: {
      responseMimeType: "application/json",
      responseSchema: opts.responseSchema,
      // Same thinking-token overhead as geminiChat — a tight budget here
      // truncates the JSON itself, breaking JSON.parse below.
      maxOutputTokens: opts.maxOutputTokens ?? 2048,
    },
  });

  const raw = response.text?.trim() ?? "{}";
  return JSON.parse(raw) as T;
}
