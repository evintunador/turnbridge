import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { forwardLocalModel, validateInferenceProvider, reservePaidRequest, type LocalModelConfig } from "./local-model.js";
import type { CliName } from "../types.js";

/** Protocol emitters adapted from cledger f9853f7 (MIT, Evin Tunador).
 * This model substitute only emits bounded read calls and never forwards requests.
 */
export async function startBridgeProvider(cli: CliName, historyMarker: string, local?: LocalModelConfig) {
  if (local) validateInferenceProvider(local);
  const dedicatedKey = process.env.TURNBRIDGE_VERIFY_PROVIDER_API_KEY;
  delete process.env.TURNBRIDGE_VERIFY_PROVIDER_API_KEY;
  const runId = randomUUID();
  let transcriptLine = 1, transcriptLines = 0;
  const state = { requests: 0, reservedUsd: 0, completedSecrets: [] as string[], modelContext: false, contexts: [] as boolean[], bodies: [] as unknown[], errors: [] as string[], secret: "", transcriptPath: "", evidencePath: "evidence.txt" };
  const server = createServer(async (req, res) => {
    try {
      if (req.method === "HEAD" && req.url === "/api/hello") { res.writeHead(200); res.end(); return; }
      if (req.method !== "POST") { res.writeHead(404); res.end(); return; }
      if (++state.requests > (local?.maxRequests ?? (local ? 12 : 24))) throw Error("Verification request budget exceeded");
      let body = "";
      for await (const chunk of req) { body += String(chunk); if (Buffer.byteLength(body) > 4_000_000) throw Error("Scripted request too large"); }
      // External protocols have heterogeneous JSON shapes; keep them opaque in saved evidence.
      const data = JSON.parse(body);
      state.bodies.push(data);
      if (req.url?.startsWith("/v1/messages/count_tokens")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"input_tokens":64}'); return; }
      if (req.url?.includes(":countTokens")) { res.writeHead(200, { "Content-Type": "application/json" }); res.end('{"totalTokens":64}'); return; }
      const google = req.url?.includes("GenerateContent") || req.url?.includes("generateContent");
      if (!google && !/^\/v1\/(messages|responses|chat\/completions)(?:\?.*)?$/.test(req.url ?? "")) throw Error(`Unsupported fixture endpoint ${req.url}`);
      const rows = data.input ?? data.messages ?? data.contents ?? [];
      const context = JSON.stringify(rows);
      const hasHistory = context.includes(historyMarker);
      state.modelContext ||= hasHistory;
      state.contexts.push(hasHistory);
      if (local) {
        state.reservedUsd = reservePaidRequest(local, data, state.reservedUsd);
        const upstream = await forwardLocalModel(local, req.url!, data, dedicatedKey);
        res.writeHead(200, { "Content-Type": upstream.headers.get("content-type") ?? "application/json" });
        let bytes = 0, responseText = "";
        const decoder = new TextDecoder();
        for await (const chunk of upstream.body!) {
          bytes += chunk.byteLength;
          responseText += decoder.decode(chunk, { stream: true });
          if (bytes > 4_000_000) { await upstream.body?.cancel().catch(() => {}); throw Error("Local-model response exceeds artifact bound"); }
          if (!res.destroyed) res.write(chunk);
        }
        responseText += decoder.decode();
        if (responseText.includes("TB_DONE") && responseText.includes(state.secret)) state.completedSecrets.push(state.secret);
        res.end(); return;
      }
      const results = JSON.stringify((rows as any[]).flatMap(row => {
        if (row.role === "tool" || row.type === "function_call_output") return [row];
        return (Array.isArray(row.content) ? row.content : row.parts ?? []).filter((block: any) => block.type === "tool_result" || block.functionResponse);
      }));
      const foundSecret = state.secret && results.includes(state.secret);
      const auxiliary = !data.tools?.length;
      const answer = cli === "aider" && hasHistory && context.includes(state.secret) ? `TB_DONE ${historyMarker} ${state.secret}` : auxiliary ? "Turnbridge test session" : foundSecret && hasHistory ? `TB_DONE ${historyMarker} ${state.secret}` : undefined;
      if (answer?.includes(state.secret) && answer.includes("TB_DONE")) state.completedSecrets.push(state.secret);
      let path = !hasHistory && state.transcriptPath ? state.transcriptPath : state.evidencePath;
      const tools = (data.tools ?? []).flatMap((tool: any) => tool.functionDeclarations ?? tool.tools ?? [tool.function ?? tool]);
      const names = tools.map((tool: any) => tool.name);
      const choices = ["Read", "read", "read_file", "read_files", "view", "file_editor", "exec_command", "shell_command", "shell"];
      const name = choices.find(name => names.includes(name));
      if (!answer && !name) throw Error(`No supported native read tool: ${names.join(",")}`);
      const tool = tools.find((tool: any) => tool.name === name);
      const properties = tool?.input_schema?.properties ?? tool?.parameters?.properties ?? {};
      // Copilot refuses a large whole-file view. Read every range through its
      // real tool, rather than injecting file bytes into the provider request.
      let viewRange: number[] | undefined;
      if (name === "view" && "view_range" in properties && state.transcriptPath) {
        if (!transcriptLines) transcriptLines = (await readFile(state.transcriptPath, "utf8")).split("\n").length;
        if (transcriptLine <= transcriptLines) {
          path = state.transcriptPath; viewRange = [transcriptLine, Math.min(transcriptLine + 79, transcriptLines)]; transcriptLine += 80;
        }
      }
      let input: Record<string, unknown>;
      if (name === "exec_command") input = { cmd: `/bin/cat '${path.replaceAll("'", "'\\''")}'`, login: false };
      else if (name === "shell_command" || name === "shell") input = { command: name === "shell" && cli === "codex" ? ["/bin/cat", path] : `/bin/cat '${path.replaceAll("'", "'\\''")}'` };
      else if (name === "file_editor") input = { command: "view", path, security_risk: "LOW" };
      else if (name === "read_files") input = { paths: [path] };
      else {
        const key = ["file_path", "filePath", "filepath", "path"].find(key => key in properties) ?? (name === "Read" ? "file_path" : "file_path");
        input = { [key]: path, ...(viewRange ? { view_range: viewRange } : {}) };
      }
      const id = `tb_call_${runId}_${state.requests}`, messageId = `tb_msg_${runId}_${state.requests}`;
      if (google) {
        const response = { candidates: [{ index: 0, content: { role: "model", parts: answer ? [{ text: answer }] : [{ functionCall: { name, args: input } }] }, finishReason: "STOP" }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }, modelVersion: "fixture" };
        if (req.url?.includes("streamGenerateContent")) { res.writeHead(200, { "Content-Type": "text/event-stream" }); res.end(`data: ${JSON.stringify(response)}\n\n`); }
        else { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(response)); }
        return;
      }
      if (req.url?.startsWith("/v1/messages")) {
        const block = answer ? { type: "text", text: answer } : { type: "tool_use", id, name, input };
        const message = { id: messageId, type: "message", role: "assistant", model: data.model, content: [block], stop_reason: answer ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
        if (!data.stream) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(message)); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (type: string, fields: unknown) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields as object })}\n\n`);
        send("message_start", { message: { ...message, content: [], stop_reason: null } });
        send("content_block_start", { index: 0, content_block: answer ? { type: "text", text: "" } : { ...block, input: {} } });
        send("content_block_delta", { index: 0, delta: answer ? { type: "text_delta", text: answer } : { type: "input_json_delta", partial_json: JSON.stringify(input) } });
        send("content_block_stop", { index: 0 }); send("message_delta", { delta: { stop_reason: message.stop_reason }, usage: { output_tokens: 1 } }); send("message_stop", {});
      } else if (req.url?.startsWith("/v1/responses")) {
        const item = answer ? { id: messageId, type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: answer, annotations: [] }] }
          : { id, type: "function_call", call_id: id, name, arguments: JSON.stringify(input), status: "completed" };
        const response = { id: `tb_response_${runId}_${state.requests}`, object: "response", created_at: 1, model: data.model, output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const send = (type: string, fields: object) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...fields })}\n\n`);
        send("response.created", { response: { ...response, status: "in_progress", output: [] } });
        send("response.output_item.added", { output_index: 0, item: answer ? { ...item, content: [] } : { ...item, arguments: "" } });
        if (answer) {
          send("response.content_part.added", { item_id: messageId, output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
          send("response.output_text.delta", { item_id: messageId, output_index: 0, content_index: 0, delta: answer });
          send("response.output_text.done", { item_id: messageId, output_index: 0, content_index: 0, text: answer });
        } else {
          send("response.function_call_arguments.delta", { item_id: id, output_index: 0, delta: JSON.stringify(input) });
          send("response.function_call_arguments.done", { item_id: id, output_index: 0, arguments: JSON.stringify(input) });
        }
        send("response.output_item.done", { output_index: 0, item }); send("response.completed", { response: { ...response, status: "completed" } });
      } else {
        const message = answer ? { role: "assistant", content: answer } : { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(input) } }] };
        if (!data.stream) { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify({ id: messageId, object: "chat.completion", created: 1, model: data.model, choices: [{ index: 0, message, finish_reason: answer ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const delta = answer ? { content: answer } : { tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(input) } }] };
        for (const [part, finish] of [[delta, null], [{}, answer ? "stop" : "tool_calls"]]) res.write("data: " + JSON.stringify({ id: messageId, object: "chat.completion.chunk", created: 1, model: data.model, choices: [{ index: 0, delta: part, finish_reason: finish }] }) + "\n\n");
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } catch (error) { state.errors.push(String(error)); if (!res.headersSent) res.writeHead(400); res.end(JSON.stringify({ error: String(error) })); }
  });
  server.requestTimeout = 15_000;
  await new Promise<void>((yes, no) => { server.once("error", no); server.listen(0, "127.0.0.1", yes); });
  const address = server.address(); if (!address || typeof address === "string") throw Error("Fixture unavailable");
  return { state, endpoint: `http://127.0.0.1:${address.port}`, async close() { server.closeAllConnections(); await new Promise<void>(yes => server.close(() => yes())); } };
}
