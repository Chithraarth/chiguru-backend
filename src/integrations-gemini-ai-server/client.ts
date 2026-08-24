import { GoogleGenAI } from "@google/genai";

if (!process.env.AI_INTEGRATIONS_GEMINI_API_KEY) {
  throw new Error(
    "AI_INTEGRATIONS_GEMINI_API_KEY must be set. Did you forget to provision the Gemini AI integration?",
  );
}

export const gemini = new GoogleGenAI({
  apiKey: process.env.AI_INTEGRATIONS_GEMINI_API_KEY,
});

// "gemini-2.5-flash"/"gemini-2.5-pro" (what these were originally pinned to)
// returned 404 "no longer available to new users" for this account — the
// "-latest" aliases track whatever model Google currently recommends, so
// this doesn't go stale the same way again. Verified against the real API
// (including responseSchema and googleSearch grounding) before relying on
// them here.

// Text-only chat/reasoning features (Agri Advisor, Year Plan, Agri Doctor
// replies) — fast and cheap, no vision needed.
export const GEMINI_FLASH_MODEL = "gemini-flash-latest";

// Vision/structured-extraction features (Disease Check, Accounts Scan) and
// Google Search grounding (Mandi prices) where accuracy matters more than
// latency.
export const GEMINI_PRO_MODEL = "gemini-pro-latest";
