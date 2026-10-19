export interface LocalModelConfig {
  endpoint: string;
  model: string;
  protocol: "messages" | "responses" | "chat-completions" | "gemini";
  maxRequests?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  tier?: "local-model" | "usual-provider";
  /** Paid configuration names a dedicated credential; never embeds its value. */
  apiKeyEnv?: "TURNBRIDGE_VERIFY_PROVIDER_API_KEY";
  budgetUsd?: number;
  inputUsdPerMillionTokens?: number;
  outputUsdPerMillionTokens?: number;
}

export function validateLocalModel(config: LocalModelConfig): void {
  if (config.tier && config.tier !== "local-model") throw Error("--local-model cannot enable a paid provider; use explicit --provider-config");
  validateInferenceProvider(config);
}

export function validateInferenceProvider(config: LocalModelConfig): void {
  const url = new URL(config.endpoint);
  const paid = config.tier === "usual-provider";
  if ((!paid && (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) ||
      (paid && url.protocol !== "https:") || url.username || url.password || url.search || url.hash)
    throw Error(paid ? "Paid provider requires an explicit HTTPS endpoint without URL credentials" : "Local-model endpoint must be an explicit HTTP loopback URL");
  if (paid && (config.apiKeyEnv !== "TURNBRIDGE_VERIFY_PROVIDER_API_KEY" || ![config.budgetUsd, config.inputUsdPerMillionTokens, config.outputUsdPerMillionTokens].every(value => typeof value === "number" && Number.isFinite(value) && value > 0)))
    throw Error("Paid verification requires a dedicated API-key environment variable, explicit USD budget and supplied token prices");
  if (!config.model?.trim() || /[\r\n]/.test(config.model)) throw Error("An explicit local model is required");
  if (!["messages", "responses", "chat-completions", "gemini"].includes(config.protocol)) throw Error("Unknown local model protocol");
  for (const [value, maximum] of [[config.maxRequests ?? 12, 24], [config.maxOutputTokens ?? 2048, 4096], [config.timeoutMs ?? 45000, 180000]] as const)
    if (!Number.isInteger(value) || value < 1 || value > maximum) throw Error("Local-model limits exceed the verification budget");
}

/** No protocol translation, remote fallback, inherited keys or redirects. */
export async function forwardLocalModel(config: LocalModelConfig, route: string, data: Record<string, any>, dedicatedKey?: string) {
  validateInferenceProvider(config);
  const compatible = config.protocol === "messages" ? route.startsWith("/v1/messages") : config.protocol === "responses" ? route.startsWith("/v1/responses") :
    config.protocol === "chat-completions" ? route.startsWith("/v1/chat/completions") : route.includes("GenerateContent") || route.includes("generateContent");
  if (!compatible) throw Error("Selected CLI protocol does not match the configured local model");
  const guidance = "Synthetic Turnbridge verification: read the transcript if provided, then read evidence.txt using a file-reading tool. After reading, reply TB_DONE followed by the prior TB_HISTORY_ value and the exact evidence.txt contents. Do not call other tools.";
  const payload = structuredClone(data);
  payload.model = config.model;
  const cap = config.maxOutputTokens ?? 2048;
  if (config.protocol === "messages") { payload.max_tokens = Math.min(payload.max_tokens ?? cap, cap); payload.system = [...(Array.isArray(payload.system) ? payload.system : payload.system ? [{ type: "text", text: payload.system }] : []), { type: "text", text: guidance }]; }
  else if (config.protocol === "responses") { payload.max_output_tokens = cap; payload.instructions = String(payload.instructions ?? "") + "\n" + guidance; }
  else if (config.protocol === "chat-completions") { delete payload.max_completion_tokens; payload.max_tokens = cap; payload.messages = [{ role: "system", content: guidance }, ...payload.messages]; }
  else { payload.generationConfig = { ...payload.generationConfig, maxOutputTokens: cap }; payload.systemInstruction = { parts: [...(payload.systemInstruction?.parts ?? []), { text: guidance }] }; delete payload.model; }
  const endpoint = new URL(config.endpoint);
  const incoming = new URL(route, "http://fixture.invalid");
  const root = endpoint.pathname.replace(/\/$/, "");
  const path = config.protocol === "gemini" ? incoming.pathname.replace(/models\/[^/:]+/, `models/${encodeURIComponent(config.model)}`) : incoming.pathname;
  endpoint.pathname = root + (root.endsWith("/v1") && path.startsWith("/v1/") ? path.slice(3) : path);
  endpoint.search = incoming.search;
  const key = config.tier === "usual-provider" ? dedicatedKey : "TESTONLY-local";
  if (!key) throw Error("Dedicated paid-verification credential is unavailable");
  const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", "x-api-key": key, "x-goog-api-key": key, "Authorization": `Bearer ${key}`, "anthropic-version": "2023-06-01" },
    body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(config.timeoutMs ?? 45000) });
  if (!response.ok) throw Error(`Local-model provider returned ${response.status}`);
  return response;
}

/** Reserve the worst-case text request before inference, including output cap.
 * Prices are explicit contributor inputs; this is an estimated spend guard,
 * not a vendor billing guarantee. Unknown multimodal pricing is rejected.
 */
export function reservePaidRequest(config: LocalModelConfig, data: unknown, reserved: number): number {
  if (config.tier !== "usual-provider") return reserved;
  validateInferenceProvider(config);
  const body = JSON.stringify(data);
  if (/"(?:image_url|input_image|image|input_audio|audio|file_data)"\s*:/.test(body)) throw Error("Paid verification budget only supports text/tool protocols");
  const estimated = ((Buffer.byteLength(body) + 8192) * config.inputUsdPerMillionTokens! + (config.maxOutputTokens ?? 2048) * config.outputUsdPerMillionTokens!) / 1_000_000;
  if (reserved + estimated > config.budgetUsd!) throw Error("Paid verification estimated USD budget exhausted before inference");
  return reserved + estimated;
}
