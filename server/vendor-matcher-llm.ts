/**
 * Claude-backed vendor matcher.
 *
 * When local fuzzy matching can't pin down a single QBO vendor for a parsed
 * vendor name, this asks Claude to pick the best match from the QBO vendor list.
 * Cached in-memory for 24h per raw name to avoid duplicate LLM calls.
 *
 * Cost: ~$0.0001 per call with claude-haiku-4-5.
 */

import { getAllQboVendors } from "./storage";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-haiku-4-5";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

type CacheEntry = {
  result: VendorMatchLLMResult | null;
  expires_at: number;
};

const cache = new Map<string, CacheEntry>();

export type VendorMatchLLMResult = {
  vendor_qbo_id: string | null;
  vendor_qbo_name: string | null;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  alternatives: { vendor_qbo_id: string; vendor_qbo_name: string }[];
};

export function isVendorMatcherLlmEnabled(): boolean {
  return !!process.env.ANTHROPIC_API_KEY;
}

export async function matchVendorWithLlm(
  rawName: string | null | undefined,
): Promise<VendorMatchLLMResult | null> {
  if (!rawName) return null;
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  if (!isVendorMatcherLlmEnabled()) return null;

  // Cache check
  const cacheKey = trimmed.toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires_at > Date.now()) {
    return cached.result;
  }

  const vendors = getAllQboVendors();
  if (vendors.length === 0) return null;

  // Build a compact vendor list (id, name) — DON'T send 1000+ rows of metadata
  const vendorList = vendors
    .filter((v) => v.Active !== false)
    .map((v) => ({ id: v.Id, name: v.DisplayName }));

  const systemPrompt = `You are a vendor-matching assistant for an accounts payable system. You receive a raw vendor name extracted from an invoice (which may contain DBAs, parent/subsidiary references, slashes, abbreviations, or noise) and a list of QuickBooks vendors. Your job is to pick the single best matching vendor by ID.

Rules:
- Consider DBAs (e.g. "B Robinson LLC / Revo" probably means Revo).
- Consider parent/subsidiary (e.g. "N-Brands" might be the parent of "Nikkie").
- Be cautious: only return high confidence if you're very sure.
- Return medium confidence if the match is plausible but ambiguous.
- Return low confidence if no good match exists; in that case set vendor_qbo_id to null but list up to 3 alternatives.

Return ONLY a JSON object with this exact shape:
{
  "vendor_qbo_id": "<id>" | null,
  "vendor_qbo_name": "<name>" | null,
  "confidence": "high" | "medium" | "low",
  "reasoning": "<one short sentence>",
  "alternatives": [{"vendor_qbo_id": "<id>", "vendor_qbo_name": "<name>"}]
}`;

  const userPrompt = `Raw vendor name from invoice: "${trimmed}"

QuickBooks vendor list (id|name):
${vendorList.map((v) => `${v.id}|${v.name}`).join("\n")}

Pick the best match. Return JSON only.`;

  const apiKey = process.env.ANTHROPIC_API_KEY!;
  const model = process.env.LLM_PARSER_MODEL || DEFAULT_MODEL;

  try {
    const response = await fetch(ANTHROPIC_URL, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.warn(`[vendor-llm] Claude HTTP ${response.status}: ${errText.slice(0, 200)}`);
      return null;
    }

    const data: any = await response.json();
    const text = data?.content?.[0]?.text || "";
    // Extract JSON from response (may be wrapped in prose / code fence)
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn(`[vendor-llm] no JSON in response: ${text.slice(0, 200)}`);
      return null;
    }
    const parsed = JSON.parse(jsonMatch[0]);

    // Validate the picked id actually exists in our list
    if (parsed.vendor_qbo_id) {
      const exists = vendors.some((v) => v.Id === parsed.vendor_qbo_id);
      if (!exists) {
        console.warn(`[vendor-llm] hallucinated id ${parsed.vendor_qbo_id} — discarding match`);
        parsed.vendor_qbo_id = null;
        parsed.vendor_qbo_name = null;
        parsed.confidence = "low";
      }
    }

    // Filter alternatives to existing ids only
    if (Array.isArray(parsed.alternatives)) {
      parsed.alternatives = parsed.alternatives.filter((a: any) => vendors.some((v) => v.Id === a.vendor_qbo_id));
    } else {
      parsed.alternatives = [];
    }

    const result: VendorMatchLLMResult = {
      vendor_qbo_id: parsed.vendor_qbo_id || null,
      vendor_qbo_name: parsed.vendor_qbo_name || null,
      confidence: parsed.confidence === "high" || parsed.confidence === "medium" ? parsed.confidence : "low",
      reasoning: String(parsed.reasoning || "").slice(0, 200),
      alternatives: parsed.alternatives.slice(0, 3),
    };

    cache.set(cacheKey, { result, expires_at: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err: any) {
    console.warn(`[vendor-llm] error: ${err.message}`);
    return null;
  }
}

export function clearVendorMatcherCache() {
  cache.clear();
}
