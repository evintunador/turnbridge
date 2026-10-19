import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { validateLocalModel, validateInferenceProvider, reservePaidRequest, forwardLocalModel, type LocalModelConfig } from "../verification/local-model.js";

test("local canaries require explicit loopback model/protocol and bounded budgets", () => {
  const config: LocalModelConfig = { endpoint: "http://127.0.0.1:1234", model: "contributor-model", protocol: "responses" };
  validateLocalModel(config);
  for (const endpoint of ["https://example.com", "http://user:secret@localhost:1234", "http://127.0.0.1:1234?secret=1"])
    assert.throws(() => validateLocalModel({ ...config, endpoint }), /loopback/);
  assert.throws(() => validateLocalModel({ ...config, maxRequests: 25 }), /budget/);
  assert.throws(() => validateLocalModel({ ...config, model: "" }), /model/);
});

test("paid canaries require explicit credentials, pricing and estimated spend reservation", () => {
  const config: LocalModelConfig = { tier: "usual-provider", endpoint: "https://provider.example.invalid", model: "explicit-model", protocol: "responses",
    apiKeyEnv: "TURNBRIDGE_VERIFY_PROVIDER_API_KEY", budgetUsd: 0.1, inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2, maxOutputTokens: 128 };
  validateInferenceProvider(config);
  assert.throws(() => validateLocalModel(config), /cannot enable a paid provider/);
  const { budgetUsd, ...withoutBudget } = config;
  assert.throws(() => validateInferenceProvider(withoutBudget), /explicit USD budget/);
  assert.throws(() => validateInferenceProvider({ ...config, endpoint: "http://provider.example.invalid" }), /HTTPS/);
  const reserved = reservePaidRequest(config, { input: "synthetic text" }, 0);
  assert(reserved > 0 && reserved < config.budgetUsd!);
  assert.throws(() => reservePaidRequest(config, {}, 0.1), /budget exhausted before inference/);
  assert.throws(() => reservePaidRequest(config, { input_image: "opaque" }, 0), /only supports text/);
});

test("local forwarding caps output, changes model and rejects protocol mismatch or redirects", async () => {
  let observed: any, observedRoute = "";
  const server = createServer(async (req, res) => {
    let body = ""; for await (const part of req) body += part;
    observed = JSON.parse(body);
    observedRoute = req.url ?? "";
    if (req.url?.startsWith("/redirect")) { res.writeHead(302, { location: "https://example.com" }); res.end(); }
    else { res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}'); }
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const config: LocalModelConfig = { endpoint: `http://127.0.0.1:${port}`, model: "local-choice", protocol: "responses", maxOutputTokens: 128 };
  try {
    const response = await forwardLocalModel(config, "/v1/responses", { model: "original", input: [], max_output_tokens: 10000 });
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(observed.model, "local-choice"); assert.equal(observed.max_output_tokens, 128);
    await (await forwardLocalModel({ ...config, endpoint: config.endpoint + "/v1" }, "/v1/responses?beta=true", { input: [] })).json();
    assert.equal(observedRoute, "/v1/responses?beta=true");
    assert(!observed.instructions.includes("TB_HISTORY_test"));
    await assert.rejects(forwardLocalModel(config, "/v1/messages", {}), /protocol/);
    await assert.rejects(forwardLocalModel({ ...config, endpoint: config.endpoint + "/redirect" }, "/v1/responses", {}));
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});
