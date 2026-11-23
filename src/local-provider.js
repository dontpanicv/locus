// pi-ai provider that runs Qwen3.5-4B in this tab with transformers.js on WebGPU.
// The model comes from Hugging Face at a fixed revision and the ONNX Runtime wasm from jsDelivr; the browser keeps
// both in Cache Storage after the first download.
import { AutoTokenizer, env, InterruptableStoppingCriteria, ones, Qwen3_5ForCausalLM, Tensor, TextStreamer } from "@huggingface/transformers";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { getSystemMessageText, renderSystemMessageUpdate } from "@earendil-works/pi-ai/utils/text";
import { parseToolCalls, visibleText } from "./parse.js";

// On localhost, files under models/ (served by server.mjs, so evals don't download them) are tried first; a 404 falls back.
env.allowLocalModels = ["localhost", "127.0.0.1"].includes(location.hostname);
env.localModelPath = "models/";

export const PROVIDER = "local";
export const MODEL_ID = "onnx-community/Qwen3.5-4B-ONNX-OPT";
const REVISION = "bb072268d0912bdc5cf4f41c8c6f53a03fd68624"; // pinned so a change upstream can't change what users run
const API = "transformers-js";

const MODEL = {
	id: MODEL_ID,
	name: "Qwen3.5 4B (WebGPU, q4f16)",
	api: API,
	provider: PROVIDER,
	baseUrl: location.origin,
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	// The model takes 262K and 60K ran fine here, but every step reprocesses the whole prompt at about 500 tokens/s
	// (15K: 20 s, 30K: 55 s, 60K: 159 s). 32K keeps a step under a minute; pi compacts the chat before that.
	contextWindow: 32_768,
	maxTokens: 1024,
};

// Qwen3.5 thinks before answering by default. Off keeps each tool step fast; on scores higher on hard tasks.
const THINKING = false;
// Qwen's recommended sampling for each mode. Greedy decoding makes it repeat itself, such as clicking the same
// element until the run is stopped.
const SAMPLING = THINKING ? { temperature: 1.0, top_p: 0.95, top_k: 20 } : { temperature: 0.7, top_p: 0.8, top_k: 20 };
// The prompt is fed in chunks: ONNX Runtime's WebGPU attention overflows a 32-bit count of 16 heads × new tokens ×
// all tokens, which one pass over the whole prompt hits at about 11,585 tokens. 512 keeps that bound past 262K.
const CHUNK = 512;

let loaded;
/** Load the tokenizer and the text-only model (no vision encoder) once; `onProgress` gets transformers.js progress events. */
export function loadModel(onProgress) {
	loaded ??= Promise.all([
		AutoTokenizer.from_pretrained(MODEL_ID, { revision: REVISION, progress_callback: onProgress }),
		Qwen3_5ForCausalLM.from_pretrained(MODEL_ID, { revision: REVISION, dtype: "q4f16", device: "webgpu", progress_callback: onProgress }),
	]).then(([tokenizer, model]) => {
		// transformers.js 4.3.2 bug: with a cache it sets pixel_values to null, and forward treats any pixel_values as
		// an image whenever more than one token comes in, which is every chunk after the first. Drop the null.
		const prepare = model.prepare_inputs_for_generation.bind(model);
		model.prepare_inputs_for_generation = (...args) => {
			const inputs = prepare(...args);
			if (inputs.pixel_values === null) delete inputs.pixel_values;
			return inputs;
		};
		return { tokenizer, model };
	});
	loaded.catch(() => (loaded = undefined)); // a failed download can be tried again
	return loaded;
}

const firstTokens = (ids, n) => new Tensor("int64", BigInt64Array.from(ids.slice(0, n), BigInt), [1, n]);

/**
 * Run all but the last chunk of the prompt through the model and return the cache they leave.
 * Each call gives generate the prompt up to a chunk's end with the cache so far; it only runs the tokens past the cache.
 */
async function prefill(model, ids, signal) {
	let cache;
	try {
		for (let end = CHUNK; end < ids.length; end += CHUNK) {
			if (signal?.aborted) throw new Error("Request was aborted");
			const out = await model.generate({
				input_ids: firstTokens(ids, end),
				attention_mask: ones([1, end]),
				past_key_values: cache,
				max_new_tokens: 1, // the one sampled token is never fed back, so the cache holds exactly `end` tokens
				return_dict_in_generate: true,
			});
			cache = out.past_key_values; // updated in place after the first chunk
		}
		return cache;
	} catch (error) {
		await cache?.dispose(); // GPU memory, freed only by hand
		throw error;
	}
}

// One generation at a time: the GPU and the KV cache belong to one request.
let queue = Promise.resolve();
const serialized = (job) => (queue = queue.then(job, job));

const text = (content) =>
	typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

// Tool results before the latest few go into the prompt shortened: old page snapshots are stale anyway, and every
// token is processed again on every step (10K tokens take about 10 s).
const FULL_RESULTS = 2;
const OLD_RESULT_CHARS = 300;
export function shortenOld(content, isLatest) {
	if (isLatest || content.length <= OLD_RESULT_CHARS) return content;
	return `${content.slice(0, OLD_RESULT_CHARS)}… [older result shortened; call the tool again if you need it]`;
}

/** pi transcript → chat-template messages + the tools that are currently offered. */
function toChat(messages) {
	const chat = [];
	let results = messages.filter((m) => m.role === "toolResult").length;
	const tools = new Map();
	let first = true;
	for (const m of messages) {
		if (m.role === "system") {
			for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
			for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
			const content = first ? getSystemMessageText(m) : renderSystemMessageUpdate(m);
			if (content) chat.push({ role: "system", content });
			first = false;
		} else if (m.role === "user") {
			chat.push({ role: "user", content: text(m.content) });
		} else if (m.role === "assistant") {
			const calls = m.content.filter((b) => b.type === "toolCall");
			chat.push({
				role: "assistant",
				content: text(m.content),
				...(calls.length && {
					tool_calls: calls.map((c) => ({ type: "function", id: c.id, function: { name: c.name, arguments: c.arguments } })),
				}),
			});
		} else if (m.role === "toolResult") {
			const latest = results-- <= FULL_RESULTS;
			chat.push({ role: "tool", tool_call_id: m.toolCallId, content: (m.isError ? "Error: " : "") + shortenOld(text(m.content), latest) });
		}
	}
	const schemas = [...tools.values()].map((t) => ({
		type: "function",
		function: { name: t.name, description: t.description, parameters: t.parameters },
	}));
	return { chat, tools: schemas };
}

function stream(model, context, options) {
	const out = createAssistantMessageEventStream();
	const message = {
		role: "assistant",
		content: [],
		api: API,
		provider: PROVIDER,
		model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "pending",
		timestamp: Date.now(),
	};
	const fail = (reason, error) => {
		const failed = { ...message, stopReason: reason, errorMessage: error?.message ?? String(error) };
		out.push({ type: "error", reason, error: failed });
		out.end(failed);
	};

	serialized(async () => {
		try {
			const { tokenizer, model } = await loadModel();
			const { chat, tools } = toChat(context.messages);
			const prompt = tokenizer.apply_chat_template(chat, {
				tools: tools.length ? tools : undefined,
				enable_thinking: THINKING,
				add_generation_prompt: true,
				tokenize: false,
			});
			const ids = tokenizer.encode(prompt, { add_special_tokens: false });
			message.usage.input = ids.length;
			// Worded so pi-ai reads it as a context overflow: pi then compacts the conversation and tries again.
			if (message.usage.input > MODEL.contextWindow) {
				return fail("error", new Error(`Prompt is too long: ${message.usage.input} tokens, over the ${MODEL.contextWindow} this model can take on WebGPU`));
			}

			const stopper = new InterruptableStoppingCriteria();
			const onAbort = () => stopper.interrupt();
			if (options?.signal?.aborted) return fail("aborted", new Error("Request was aborted"));
			options?.signal?.addEventListener("abort", onAbort, { once: true });

			out.push({ type: "start", partial: message });
			// With thinking on, the prompt ends in an open "<think>", so the reply starts inside it.
			let raw = THINKING ? "<think>" : "";
			let shown = "";
			const textBlock = { type: "text", text: "" };
			const streamer = new TextStreamer(tokenizer, {
				skip_prompt: true,
				skip_special_tokens: true,
				callback_function: (chunk) => {
					raw += chunk;
					const visible = visibleText(raw);
					if (visible === shown) return;
					if (!shown) {
						message.content.push(textBlock);
						out.push({ type: "text_start", contentIndex: 0, partial: message });
					}
					// A late "</think>" removes text already shown; an empty delta makes pi diff the partial instead.
					const delta = visible.startsWith(shown) ? visible.slice(shown.length) : "";
					shown = visible;
					textBlock.text = shown;
					out.push({ type: "text_delta", contentIndex: 0, delta, partial: message });
				},
			});

			const cache = await prefill(model, ids, options?.signal).catch((error) => {
				if (options?.signal?.aborted) return null;
				throw error;
			});
			if (cache === null) return fail("aborted", new Error("Request was aborted"));
			const result = await model.generate({
				input_ids: firstTokens(ids, ids.length),
				attention_mask: ones([1, ids.length]),
				past_key_values: cache,
				max_new_tokens: options?.maxTokens ?? MODEL.maxTokens,
				do_sample: true,
				...SAMPLING,
				repetition_penalty: 1.05,
				streamer,
				stopping_criteria: [stopper],
				return_dict_in_generate: true, // hands the cache back so it can be freed here
			});
			await result.past_key_values.dispose();
			options?.signal?.removeEventListener("abort", onAbort);
			if (options?.signal?.aborted) return fail("aborted", new Error("Request was aborted"));

			const finalText = visibleText(raw).trim();
			if (shown) {
				textBlock.text = finalText;
				out.push({ type: "text_end", contentIndex: 0, content: finalText, partial: message });
			}
			const calls = parseToolCalls(raw);
			for (const call of calls) {
				const block = { type: "toolCall", id: `call_${crypto.randomUUID()}`, name: call.name, arguments: call.arguments };
				const index = message.content.push(block) - 1;
				out.push({ type: "toolcall_start", contentIndex: index, partial: message });
				out.push({ type: "toolcall_delta", contentIndex: index, delta: JSON.stringify(call.arguments), partial: message });
				out.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: message });
			}
			message.usage.output = tokenizer.encode(raw).length;
			message.usage.totalTokens = message.usage.input + message.usage.output;
			message.stopReason = calls.length ? "toolUse" : "stop";
			out.push({ type: "done", reason: message.stopReason, message });
			out.end(message);
		} catch (error) {
			console.error(error);
			fail("error", error);
		}
	});
	return out;
}

export const localProvider = createProvider({
	id: PROVIDER,
	name: "Local (this browser)",
	auth: { apiKey: { name: "None", resolve: async () => ({ auth: {} }) } },
	models: [MODEL],
	api: { stream, streamSimple: stream },
});
