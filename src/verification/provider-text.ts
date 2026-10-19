import type { LocalModelConfig } from "./local-model.js";

/** Assemble visible assistant output, never tool arguments or hidden reasoning. */
export function providerText(wire: string, protocol: LocalModelConfig["protocol"]): string {
  const records: any[] = [];
  const parse = (value: string) => {
    try { const parsed = JSON.parse(value); records.push(...(Array.isArray(parsed) ? parsed : [parsed])); } catch { /* SSE comments, DONE, or incomplete frames */ }
  };
  if (/^data:/m.test(wire)) for (const frame of wire.split(/\r?\n\r?\n/)) {
    const data = frame.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
    if (data) parse(data);
  }
  else parse(wire);
  const deltas: string[] = [], final: string[] = [];
  const textBlocks = (blocks: any[]): string => (blocks ?? []).filter(block => ["text", "output_text"].includes(block.type) && typeof block.text === "string").map(block => block.text).join("");
  for (const row of records) {
    if (!row || typeof row !== "object") continue;
    if (protocol === "messages") {
      if (row.type === "content_block_delta" && row.delta?.type === "text_delta") deltas.push(row.delta.text ?? "");
      if (row.type === "content_block_start" && row.content_block?.type === "text") deltas.push(row.content_block.text ?? "");
      if (row.type === "message" && row.role === "assistant") final.push(textBlocks(row.content));
    } else if (protocol === "responses") {
      if (row.type === "response.output_text.delta") deltas.push(row.delta ?? "");
      if (row.type === "response.output_text.done") final.push(row.text ?? "");
      const response = row.type === "response.completed" ? row.response : row;
      if (response?.object === "response") final.push((response.output ?? []).filter((item: any) => item.type === "message" && item.role === "assistant").map((item: any) => textBlocks(item.content)).join(""));
    } else if (protocol === "chat-completions") {
      const choice = row.choices?.find((choice: any) => choice.index === 0) ?? row.choices?.[0];
      if (typeof choice?.delta?.content === "string") deltas.push(choice.delta.content);
      if (choice?.message?.role === "assistant") final.push(typeof choice.message.content === "string" ? choice.message.content : textBlocks(choice.message.content));
    } else {
      const candidate = row.candidates?.find((candidate: any) => candidate.index === 0) ?? row.candidates?.[0];
      if (candidate?.content?.role === "model") deltas.push((candidate.content.parts ?? []).filter((part: any) => !part.thought && typeof part.text === "string").map((part: any) => part.text).join(""));
    }
  }
  return deltas.length ? deltas.join("") : final.join("");
}
