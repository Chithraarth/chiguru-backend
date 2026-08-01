import { Router } from "express";
import { db } from "../db";
import { conversations, messages, farmProfileTable, cropsTable, expensesTable, spraysTable, harvestsTable, diseaseDiagnosesTable } from "../db";
import { eq, asc, gte } from "drizzle-orm";
import { openai } from "../integrations-openai-ai-server";
import { CROP_DISEASE_KNOWLEDGE } from "../lib/crop-diseases";
import { requireActiveSubscription } from "../middlewares/subscriptionGate";

const router = Router();

// ──────────────────────────────────────────────
// Conversations CRUD
// ──────────────────────────────────────────────
router.get("/openai/conversations", async (_req, res) => {
  const rows = await db.select().from(conversations).orderBy(asc(conversations.createdAt));
  res.json(rows);
});

router.post("/openai/conversations", async (req, res) => {
  const { title } = req.body as { title?: string };
  const [row] = await db.insert(conversations).values({ title: title ?? "New conversation" }).returning();
  res.status(201).json(row);
});

router.get("/openai/conversations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
  res.json({ ...conv, messages: msgs });
});

router.delete("/openai/conversations/:id", async (req, res) => {
  const id = parseInt(req.params.id);
  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }
  await db.delete(conversations).where(eq(conversations.id, id));
  res.status(204).end();
});

router.get("/openai/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  const msgs = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
  res.json(msgs);
});

// ──────────────────────────────────────────────
// Chat with full farm context (SSE streaming)
// ──────────────────────────────────────────────
router.post("/openai/conversations/:id/messages", async (req, res) => {
  const id = parseInt(req.params.id);
  const { content } = req.body as { content: string };

  const [conv] = await db.select().from(conversations).where(eq(conversations.id, id));
  if (!conv) { res.status(404).json({ error: "Not found" }); return; }

  await db.insert(messages).values({ conversationId: id, role: "user", content });

  const [history, profile, crops] = await Promise.all([
    db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt)),
    db.select().from(farmProfileTable).limit(1).then((r) => r[0]),
    db.select().from(cropsTable),
  ]);

  // Last 30 days context
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

  const [recentExpenses, recentSprays, recentHarvests] = await Promise.all([
    db.select().from(expensesTable).where(gte(expensesTable.date, cutoff)),
    db.select().from(spraysTable).where(gte(spraysTable.date, cutoff)),
    db.select().from(harvestsTable).where(gte(harvestsTable.date, cutoff)),
  ]);

  const farmContext = profile
    ? `FARM PROFILE:
Farm: ${profile.farmName} | Location: ${profile.village}, ${profile.district}, ${profile.state}
Total area: ${profile.totalAcres} acres | Annual rainfall: ${profile.avgRainfallMm ?? "unknown"}mm | Climate: ${profile.climateZone ?? "unknown"}
Crops: ${crops.map((c) => `${c.name} (${c.acres} ac)`).join(", ") || "not specified"}

LAST 30 DAYS ACTIVITY:
Expenses (${recentExpenses.length}): ${recentExpenses.slice(0, 5).map((e) => `${e.date} ${e.category} ₹${e.amount}${e.description ? " " + e.description : ""}`).join("; ") || "none"}
Sprays (${recentSprays.length}): ${recentSprays.slice(0, 5).map((s) => `${s.date} ${s.productName} on ${s.areaAcres}ac`).join("; ") || "none"}
Harvests (${recentHarvests.length}): ${recentHarvests.slice(0, 5).map((h) => `${h.date} ${h.weightKg}kg @ ₹${h.pricePerKg}/kg`).join("; ") || "none"}
Today's date: ${new Date().toISOString().slice(0, 10)}`
    : "Farm profile not yet set up.";

  const systemPrompt = `You are an expert agriculture technician and farming advisor specializing in Indian smallholder farming. Help farmers with practical, step-by-step guidance.

${farmContext}

${CROP_DISEASE_KNOWLEDGE}

Guidelines:
- Give clear, actionable, numbered steps when solving problems.
- Use simple language farmers can understand — avoid complex jargon.
- Recommend products commonly available at agri-input dealers in India (DAP, Urea, Chlorpyrifos, Carbendazim, Metalaxyl, Mancozeb, etc.).
- Consider local Indian conditions: monsoon patterns, soil types, government schemes (PM-KISAN, e-NAM, etc.).
- Reference the farmer's recent activity where relevant (e.g., if they sprayed recently, mention that).
- When unsure, recommend consulting the nearest KVK (Krishi Vigyan Kendra) or state agriculture department.
- Keep responses concise and practical.
- ALWAYS give exact dosage when recommending any chemical, pesticide or fertiliser: product (generic + common Indian brand), grams/ml per litre of water AND per acre, water volume, how to apply (foliar spray / soil drench), timing, and how many days before repeating.
- ALWAYS state safety: wear gloves and a mask, do not spray in afternoon heat or strong wind, keep children, animals and food away, and give the pre-harvest interval (days to wait between the last spray and harvest).
- Base advice on well-established, widely-recommended practice (product label rates, KVK/ICAR guidance). Cross-check the common recommendation instead of guessing; if the evidence is weak, say so and advise a small test patch first. Never invent a dose.
- End any answer that recommends a chemical, pesticide or dosage with this exact line on its own: "⚠️ Follow the product label for exact dose and safety. Test on a few plants first. This is general guidance, not a guarantee — for serious cases confirm with your local KVK before spraying."`;

  const chatMessages = [
    { role: "system" as const, content: systemPrompt },
    ...history.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  let fullResponse = "";
  try {
    const stream = await openai.chat.completions.create({
      model: "gpt-5.1",
      max_completion_tokens: 8192,
      messages: chatMessages,
      stream: true,
    });

    for await (const chunk of stream) {
      const text = chunk.choices[0]?.delta?.content;
      if (text) {
        fullResponse += text;
        res.write(`data: ${JSON.stringify({ content: text })}\n\n`);
      }
    }

    await db.insert(messages).values({ conversationId: id, role: "assistant", content: fullResponse });
    res.write(`data: ${JSON.stringify({ done: true })}\n\n`);
  } catch {
    res.write(`data: ${JSON.stringify({ error: "AI service error" })}\n\n`);
  }
  res.end();
});

// ──────────────────────────────────────────────
// Stateless AI Chat (single-shot, full farm context)
// ──────────────────────────────────────────────
router.post("/ai/chat", requireActiveSubscription, async (req, res) => {
  const { message, cropType } = req.body as { message: string; cropType?: string };

  if (!message) { res.status(400).json({ error: "message is required" }); return; }

  const [profile, crops] = await Promise.all([
    db.select().from(farmProfileTable).limit(1).then((r) => r[0]),
    db.select().from(cropsTable),
  ]);

  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
  const cutoff = thirtyDaysAgo.toISOString().slice(0, 10);

  const [recentExpenses, recentSprays, recentHarvests] = await Promise.all([
    db.select().from(expensesTable).where(gte(expensesTable.date, cutoff)),
    db.select().from(spraysTable).where(gte(spraysTable.date, cutoff)),
    db.select().from(harvestsTable).where(gte(harvestsTable.date, cutoff)),
  ]);

  const farmContext = profile
    ? `FARM PROFILE:
Farm: ${profile.farmName} | Location: ${profile.village}, ${profile.district}, ${profile.state}
Total area: ${profile.totalAcres} acres | Annual rainfall: ${profile.avgRainfallMm ?? "unknown"}mm | Climate: ${profile.climateZone ?? "unknown"}
Crops: ${crops.map((c) => `${c.name} (${c.acres} ac)`).join(", ") || "not specified"}
${cropType ? `Crop of concern: ${cropType}` : ""}

LAST 30 DAYS ACTIVITY:
Expenses (${recentExpenses.length}): ${recentExpenses.slice(0, 5).map((e) => `${e.date} ${e.category} ₹${e.amount}${e.description ? " " + e.description : ""}`).join("; ") || "none"}
Sprays (${recentSprays.length}): ${recentSprays.slice(0, 5).map((s) => `${s.date} ${s.productName} on ${s.areaAcres}ac`).join("; ") || "none"}
Harvests (${recentHarvests.length}): ${recentHarvests.slice(0, 5).map((h) => `${h.date} ${h.weightKg}kg @ ₹${h.pricePerKg}/kg`).join("; ") || "none"}
Today's date: ${new Date().toISOString().slice(0, 10)}`
    : "Farm profile not yet set up.";

  const systemPrompt = `You are an expert agriculture technician and farming advisor specializing in Indian smallholder farming. Help farmers with practical, step-by-step guidance.

${farmContext}

${CROP_DISEASE_KNOWLEDGE}

Guidelines:
- Give clear, actionable, numbered steps when solving problems.
- Use simple language farmers can understand — avoid complex jargon.
- Recommend products commonly available at agri-input dealers in India (DAP, Urea, Chlorpyrifos, Carbendazim, Metalaxyl, Mancozeb, etc.).
- Consider local Indian conditions: monsoon patterns, soil types, government schemes (PM-KISAN, e-NAM, etc.).
- Reference the farmer's recent activity where relevant.
- When unsure, recommend consulting the nearest KVK (Krishi Vigyan Kendra).
- Keep responses concise and practical.
- ALWAYS give exact dosage when recommending any chemical, pesticide or fertiliser: product (generic + common Indian brand), grams/ml per litre of water AND per acre, water volume, how to apply (foliar spray / soil drench), timing, and how many days before repeating.
- ALWAYS state safety: wear gloves and a mask, do not spray in afternoon heat or strong wind, keep children, animals and food away, and give the pre-harvest interval (days to wait between the last spray and harvest).
- Base advice on well-established, widely-recommended practice (product label rates, KVK/ICAR guidance). Cross-check the common recommendation instead of guessing; if the evidence is weak, say so and advise a small test patch first. Never invent a dose.
- End any answer that recommends a chemical, pesticide or dosage with this exact line on its own: "⚠️ Follow the product label for exact dose and safety. Test on a few plants first. This is general guidance, not a guarantee — for serious cases confirm with your local KVK before spraying."`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-5.1",
      max_completion_tokens: 2048,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
    });

    const response = completion.choices[0]?.message?.content ?? "I could not process your question. Please try again.";
    res.json({ response, farmContextAvailable: !!profile });
  } catch (err) {
    console.error("AI chat error:", err);
    res.status(500).json({ error: "AI service error. Please try again." });
  }
});

// ──────────────────────────────────────────────
// Disease Detection (vision analysis)
// ──────────────────────────────────────────────
router.post("/ai/disease", requireActiveSubscription, async (req, res) => {
  const { imageBase64, cropType } = req.body as { imageBase64: string; cropType?: string };

  if (!imageBase64) { res.status(400).json({ error: "imageBase64 is required" }); return; }

  const [profile, crops] = await Promise.all([
    db.select().from(farmProfileTable).limit(1).then((r) => r[0]),
    db.select().from(cropsTable),
  ]);

  const farmCrops = crops.map((c) => c.name).join(", ") || "unknown";
  const targetCrop = cropType ?? "unknown (please identify from photo)";

  const systemPrompt = `You are an expert plant pathologist and agricultural disease diagnostician specializing in Indian crops. You have deep knowledge of diseases, pests, nutrient deficiencies, and environmental stress for all Indian crops — vegetables, fruits, cereals, pulses, spices, and plantation crops.

The farmer's crop(s): ${farmCrops}.
${cropType ? `The farmer says this is: ${targetCrop}. Use this to sharpen your diagnosis.` : "Identify the crop from the photo."}

Analyze the plant photo carefully and provide a JSON response (no markdown, pure JSON) with exactly these fields:
{
  "diseaseName": "string — disease/pest/deficiency common name in English (with Hindi name in brackets if common, e.g. 'Late Blight (Jhulsa Rog)')",
  "scientificName": "string — scientific name of pathogen or pest, or empty string",
  "affectedCrop": "string — crop name identified",
  "confidence": "high|medium|low",
  "description": "string — 2-3 sentence plain description: what the disease is, what symptoms are visible in THIS photo, how it spreads. Write in simple language a farmer can understand.",
  "visibleSymptoms": "string — describe ONLY the symptoms you can actually see in THIS photo (spots, colour, location on leaf/stem/fruit, pattern). This is the evidence for your diagnosis.",
  "differentials": [{ "name": "string — another realistic possibility", "note": "string — how to tell it apart from the main diagnosis" }] — 0-3 other likely causes. Leave empty ONLY when confidence is high. When confidence is medium or low you MUST list the real alternatives,
  "immediateSteps": ["string", ...] — 2-4 simple, free first actions the farmer should do RIGHT NOW before buying anything: what to inspect (e.g. 'Check nearby plants and the underside of leaves for the same spots'), and safe non-chemical actions (e.g. 'Remove and bury badly affected leaves away from the field', 'Improve drainage / avoid overhead watering'). NO chemicals here.,
  "doNotDo": ["string", ...] — 2-4 clear warnings of what NOT to do, to avoid making it worse or wasting money (e.g. 'Do not spray in the afternoon heat or before rain', 'Do not mix multiple chemicals without advice', 'Do not buy expensive pesticide before confirming the disease').,
  "treatmentSteps": ["string", ...] — 4-6 actionable treatment steps. Each step must include: exact product name (generic + brand if known), dose per litre/acre, timing, and method. Example: 'Spray Metalaxyl 8% + Mancozeb 64% WP (Ridomil Gold) @ 2.5g per litre water on leaves and soil. Repeat after 10 days.',
  "preventionTips": ["string", ...] — 3-4 specific prevention tips relevant to this crop and disease,
  "urgency": "immediate|within-3-days|within-week|monitor",
  "recommendedProduct": "string — the single most important product to buy: generic name + most common Indian brand name + dose. E.g. 'Carbendazim 50% WP (Bavistin) — 1g per litre water'",
  "isDisease": true
}

ACCURACY RULES — trust breaks instantly if you are confidently wrong, so honesty beats a guess:
- Diagnose ONLY from symptoms actually visible in THIS photo. Put that evidence in "visibleSymptoms". Never assume symptoms you cannot see.
- Set "confidence" honestly: "high" ONLY when the visible symptoms are clear and classic for one disease; "medium" when likely but not certain; "low" when ambiguous. Do not default to high.
- Whenever confidence is "medium" or "low", you MUST fill "differentials" with the other realistic causes — do not hide uncertainty behind one answer.
- It is better to say "not sure, take a clearer photo or consult KVK" than to name the wrong disease. Never invent a disease just to look helpful.

If the photo shows a HEALTHY plant: set "isDisease": false, "diseaseName": "Healthy plant — koi bimari nahi (no disease detected)", and describe what healthy signs you see.
If the issue appears to be a NUTRIENT DEFICIENCY (yellowing, purple tint, etc.): still set "isDisease": true and describe the deficiency with fertilizer recommendations.
If the photo is UNCLEAR, blurry, too far, too dark, or NOT a plant: set "confidence": "low", "isDisease": false, "diseaseName": "Unable to identify — please take a clearer, closer photo of the affected part in good light", and do NOT guess a disease.

IMPORTANT for treatment steps:
- Recommend chemicals available at Indian agri-input dealers (DAP, Urea, Carbendazim/Bavistin, Metalaxyl/Ridomil, Mancozeb/Dithane M-45, Chlorpyrifos, Imidacloprid/Confidor, Propiconazole/Tilt, Copper Oxychloride, Bordeaux Mixture, Neem Oil, etc.)
- Every treatment step MUST give the exact dose: grams/ml per litre of water AND per acre, water volume, and how many days before repeating. Never give a vague "spray fungicide" without the dose.
- Use only well-established, widely-recommended label/KVK/ICAR dose rates — do NOT invent or guess a dose. If you are not confident, lower the confidence field and tell the farmer to confirm the dose with their dealer or KVK.
- Include both spray and soil/drench treatments where relevant
- Mention safety precautions in the steps (wear gloves and a mask, don't spray in afternoon heat or wind, keep children/animals/food away, re-entry interval, and the pre-harvest interval — days to wait before harvest)
- Mention if government subsidy or KVK advice is recommended

${CROP_DISEASE_KNOWLEDGE}`;

  try {
    const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 1600,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text: `Please analyze this plant photo. The crop type is: ${targetCrop}. First look closely at the visible symptoms, then diagnose only from what you can actually see. Respond with JSON only.`,
            },
            {
              type: "image_url" as const,
              image_url: { url: dataUrl, detail: "high" as const },
            },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    } catch {
      // Honesty over a guess: if we cannot parse a clean diagnosis, do NOT present
      // a confident-looking result. Ask for a clearer photo / KVK instead.
      parsed = {
        diseaseName: "Unable to identify — please take a clearer, closer photo of the affected part in good light",
        affectedCrop: targetCrop,
        confidence: "low",
        description: "We could not analyse this photo clearly. Please retake a sharp close-up of the affected leaf, stem or fruit in good light, or show it to your nearest KVK.",
        visibleSymptoms: "",
        differentials: [],
        immediateSteps: ["Take a sharp close-up photo of the affected part in good daylight and try again."],
        doNotDo: ["Do not buy or spray any chemical based on an unclear photo."],
        treatmentSteps: [],
        preventionTips: ["Maintain field hygiene and proper spacing."],
        urgency: "monitor",
        recommendedProduct: "",
        isDisease: false,
        scientificName: "",
      };
    }

    // Log the diagnosis (photo + result) so quality can be reviewed and the model
    // improved over time. Very large photos are skipped to avoid DB bloat, but the
    // diagnosis row is still kept. Logging must never break the farmer's result.
    let diagnosisId: number | null = null;
    try {
      const PHOTO_MAX = 3_000_000; // ~3MB of base64; bigger photos store null
      const [row] = await db
        .insert(diseaseDiagnosesTable)
        .values({
          cropType: cropType ?? null,
          photoUrl: dataUrl.length <= PHOTO_MAX ? dataUrl : null,
          diseaseName: String(parsed.diseaseName ?? "Unknown"),
          confidence: String(parsed.confidence ?? "low"),
          isDisease: parsed.isDisease === true,
          urgency: parsed.urgency ? String(parsed.urgency) : null,
          result: parsed,
        })
        .returning({ id: diseaseDiagnosesTable.id });
      diagnosisId = row?.id ?? null;
    } catch (logErr) {
      console.error("Failed to log diagnosis (non-fatal):", logErr);
    }

    res.json({ ...parsed, id: diagnosisId });
  } catch (err) {
    console.error("Disease detection error:", err);
    res.status(500).json({ error: "AI analysis failed. Please try again." });
  }
});

// ──────────────────────────────────────────────
// Diagnosis outcome feedback (improves the model over time)
// ──────────────────────────────────────────────
router.patch("/ai/disease/:id/outcome", async (req, res) => {
  const id = parseInt(req.params.id);
  if (Number.isNaN(id)) { res.status(400).json({ error: "Invalid id" }); return; }
  const { outcome, outcomeNote } = req.body as { outcome?: string; outcomeNote?: string };
  const allowed = ["helpful", "not-helpful", "agronomist-confirmed"];
  if (!outcome || !allowed.includes(outcome)) {
    res.status(400).json({ error: `outcome must be one of ${allowed.join(", ")}` });
    return;
  }
  const [row] = await db
    .update(diseaseDiagnosesTable)
    .set({ outcome, outcomeNote: outcomeNote ?? null })
    .where(eq(diseaseDiagnosesTable.id, id))
    .returning({ id: diseaseDiagnosesTable.id });
  if (!row) { res.status(404).json({ error: "Diagnosis not found" }); return; }
  res.json({ ok: true });
});

// ──────────────────────────────────────────────
// Worker Headcount (vision — crowd counting)
// ──────────────────────────────────────────────
router.post("/ai/count-workers", async (req, res) => {
  const { imageBase64 } = req.body as { imageBase64: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 is required" }); return; }

  const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 256,
      messages: [
        {
          role: "system",
          content: `You are an AI assistant that counts the number of people (farm workers) visible in a photo.
Count every person whose head or body is clearly visible — include people in the background if you can see them.
Respond with pure JSON only (no markdown), with exactly these fields:
{
  "count": <integer — total number of people you can see>,
  "confidence": "high" | "medium" | "low",
  "notes": "<one short sentence describing what you see, e.g. '8 workers standing in a row in a field'>"
}
If no people are visible, return count: 0.
If the image is too blurry or unclear, return count: 0 and confidence: "low".`,
        },
        {
          role: "user",
          content: [
            { type: "text" as const, text: "Count all the farm workers visible in this photo. Return JSON only." },
            { type: "image_url" as const, image_url: { url: dataUrl, detail: "auto" as const } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: { count: number; confidence: string; notes: string };
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    } catch {
      parsed = { count: 0, confidence: "low", notes: "Could not parse AI response. Please try again." };
    }

    res.json({ count: Math.max(0, Math.round(Number(parsed.count) || 0)), confidence: parsed.confidence ?? "low", notes: parsed.notes ?? "" });
  } catch (err) {
    console.error("Worker count error:", err);
    res.status(500).json({ error: "AI headcount failed. Please try again." });
  }
});

// ──────────────────────────────────────────────
// Old Account Book Scan (vision — reads handwritten/printed farm ledgers)
// ──────────────────────────────────────────────
router.post("/ai/accounts-scan", requireActiveSubscription, async (req, res) => {
  const { imageBase64 } = req.body as { imageBase64: string };
  if (!imageBase64) { res.status(400).json({ error: "imageBase64 is required" }); return; }

  const dataUrl = imageBase64.startsWith("data:") ? imageBase64 : `data:image/jpeg;base64,${imageBase64}`;

  const systemPrompt = `You are an expert agricultural accounts reader for Indian smallholder farmers. You read handwritten and printed Indian farm account books (khata/kata/ledger) and extract all financial entries.

The accounts may be written in Hindi, Kannada, Marathi, Telugu, Tamil, English, or a mix of languages and scripts. Common Indian farm account entries include:
- Labour costs: weed cutting (ghas katai), harvesting (katai), coffee plucking, paddy cutting, coffee pruning, tree trimming, loading, spraying labour
- Fertilizer costs: DAP, Urea, Potash, MOP, SSP, organic manure (khad), NPK
- Pesticide/spray costs: fungicides, insecticides, herbicides (e.g. Bavistin, Ridomil, Confidor)
- Seed and planting material costs
- Harvest income: coffee, paddy, sugarcane, coconut, areca, weight and price per kg
- Equipment rental: tractor, pump, sprayer
- Miscellaneous: electricity, transport, repairs

Read ALL visible entries from the account book page carefully. Look for amounts written as numbers, ₹ symbol, Rs., or written in local language. Dates may be in DD/MM/YYYY or other formats.

Respond with pure JSON only (no markdown, no explanation outside the JSON):
{
  "year": "string — the year or season if visible (e.g. '2023-24', '2022')",
  "pageDescription": "string — brief description of what this page contains in one sentence",
  "entries": [
    {
      "type": "expense" | "income",
      "category": "Labour" | "Fertilizer" | "Pesticide" | "Seed" | "Harvest" | "Equipment" | "Other",
      "description": "string — clear English description of what this entry is (translate from Hindi/Kannada if needed)",
      "originalText": "string — the original text as written in the book (copy exactly as visible)",
      "amount": number — amount in rupees as a number (best estimate if partially unclear),
      "date": "string — date in YYYY-MM-DD format if visible, otherwise omit",
      "unit": "string — unit or quantity if mentioned (e.g. '5 workers × 2 days', '2 bags 50kg', 'per day ₹300')",
      "confidence": "high" | "medium" | "low",
      "question": "string — ONLY when you have a doubt about this entry: one short, simple question for the farmer so they can correct it (e.g. 'Is this amount ₹500 or ₹5000?', 'Is this word ghas katai (weed cutting)?'). Omit this field when you are confident."
    }
  ],
  "totalExpense": number — sum of all expense entry amounts,
  "totalIncome": number — sum of all income entry amounts,
  "notes": "string — any other relevant information visible on the page (names, farm details, etc.)"
}

If the image is not an account book or is too unclear to read at all, return:
{ "error": "Cannot read this image clearly. Please take a closer photo in good daylight with the book lying flat." }

Be thorough — read every line. NEVER silently guess when something is unclear. If an amount, word, or date is hard to read: still include the entry with your best estimate, mark confidence "low", and add a "question" asking the farmer to confirm (they wrote the book — they can rectify it). Only skip an entry if it is completely invisible.`;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-5.4",
      max_completion_tokens: 2500,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text" as const, text: "Please read all entries from this farm account book page and return the structured JSON only." },
            { type: "image_url" as const, image_url: { url: dataUrl, detail: "high" as const } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: Record<string, unknown>;
    try {
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch?.[0] ?? raw);
    } catch {
      parsed = { error: "Could not read entries. Please take a clearer photo in good light and try again." };
    }

    res.json(parsed);
  } catch (err) {
    console.error("Accounts scan error:", err);
    res.status(500).json({ error: "AI analysis failed. Please try again." });
  }
});

export default router;
