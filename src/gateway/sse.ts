import crypto from "node:crypto";

/** Anthropic Messages streaming, synthesized from a complete message object. */
export function anthropicSSE(msg: any): string {
  const out: string[] = [];
  const send = (ev: string, data: unknown) => out.push(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const skeleton = { ...msg, content: [], usage: { input_tokens: msg?.usage?.input_tokens ?? 0, output_tokens: 0 } };
  send("message_start", { type: "message_start", message: skeleton });
  (msg.content ?? []).forEach((block: any, i: number) => {
    if (block.type === "text") {
      send("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      send("content_block_delta", {
        type: "content_block_delta",
        index: i,
        delta: { type: "text_delta", text: block.text },
      });
    } else {
      send("content_block_start", { type: "content_block_start", index: i, content_block: block });
    }
    send("content_block_stop", { type: "content_block_stop", index: i });
  });
  send("message_delta", {
    type: "message_delta",
    delta: { stop_reason: msg.stop_reason ?? "end_turn", stop_sequence: null },
    usage: { output_tokens: msg?.usage?.output_tokens ?? 0 },
  });
  send("message_stop", { type: "message_stop" });
  return out.join("");
}

/** OpenAI chat.completion.chunk streaming, synthesized from a complete completion. */
export function chatSSE(j: any): string {
  const out: string[] = [];
  const id = j.id || `chatcmpl-${crypto.randomBytes(8).toString("hex")}`;
  const model = j.model;
  const msg = j.choices?.[0]?.message ?? { content: "" };
  const chunk = (delta: unknown) =>
    out.push(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    );
  chunk({ role: "assistant" });
  if (msg.content) chunk({ content: msg.content });
  if (msg.annotations) chunk({ annotations: msg.annotations });
  out.push(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", model, choices: [{ index: 0, delta: {}, finish_reason: j.choices?.[0]?.finish_reason ?? "stop" }] })}\n\n`,
  );
  out.push("data: [DONE]\n\n");
  return out.join("");
}

/** OpenAI Responses streaming, synthesized from a complete response object. */
export function responsesSSE(j: any): string {
  const out: string[] = [];
  let seq = 0;
  const emit = (type: string, obj: Record<string, unknown>) =>
    out.push(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...obj })}\n\n`);
  const skeleton = { id: j.id, object: "response", status: "in_progress", model: j.model, output: [] };
  emit("response.created", { response: skeleton });
  emit("response.in_progress", { response: skeleton });
  (j.output ?? []).forEach((item: any, oi: number) => {
    emit("response.output_item.added", { output_index: oi, item: { ...item, status: item.status ?? "in_progress" } });
    if (item.type === "message") {
      (item.content ?? []).forEach((part: any, ci: number) => {
        if (part.type === "output_text") {
          emit("response.content_part.added", {
            item_id: item.id,
            output_index: oi,
            content_index: ci,
            part: { type: "output_text", text: "", annotations: [] },
          });
          emit("response.output_text.delta", {
            item_id: item.id,
            output_index: oi,
            content_index: ci,
            delta: part.text,
          });
          (part.annotations ?? []).forEach((annotation: any, ai: number) => {
            emit("response.output_text.annotation.added", {
              item_id: item.id,
              output_index: oi,
              content_index: ci,
              annotation_index: ai,
              annotation,
            });
          });
          emit("response.output_text.done", { item_id: item.id, output_index: oi, content_index: ci, text: part.text });
          emit("response.content_part.done", { item_id: item.id, output_index: oi, content_index: ci, part });
        }
      });
    }
    emit("response.output_item.done", { output_index: oi, item });
  });
  emit("response.completed", { response: { ...j, status: "completed" } });
  return out.join("");
}
