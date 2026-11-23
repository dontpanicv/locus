// A durable chat: pi-durable keeps every turn in IndexedDB, Qwen3.5 answers on WebGPU, tools use browser APIs.
// Reload the tab mid-answer and pi picks the run up again from storage.
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness, section } from "@earendil-works/pi-durable";
import { IndexedDbStorage } from "@earendil-works/pi-durable/storage/indexeddb";
import { loadModel, localProvider, MODEL_ID, PROVIDER } from "./local-provider.js";
import { bridgeAvailable, NUDGE, TabTools } from "./bridge-tools.js";
import { onboard, onboarded } from "./onboarding.js";
import { BrowserTools } from "./tools.js";

const DB = "local-agent";
const $ = (id) => document.getElementById(id);
const status = (text) => ($("status").textContent = text);

const Assistant = defineExtension({
	name: "assistant",
	sections: [
		section(
			"preamble",
			() =>
				"You are a helpful assistant running entirely inside the user's web browser. " +
				"Use the tools to answer questions about the user's time, location, device, and storage, " +
				"and to notify or copy text when asked. " +
				"If you have tab and web tools, use them to list, open and read the user's tabs and to search and read the web. " +
				"You use the user's browser yourself: do every step of a task with the tools, and never tell the user to click, open or go somewhere you can reach. " +
				"Working on web pages: you work in one tab at a time, and tab tools use it unless you pass a tabId. " +
				"When the user names a tab or site, such as \"the GitHub one\", call list_tabs and find it by title or URL before asking which one they mean; pass its tabId once and keep working in it. " +
				"To go to a site, use navigate; it opens a tab if you have none. " +
				"Use open_tab only when the user asks for a new tab. Don't close tabs to start over; use go_back or navigate. " +
				"snapshot_tab shows the page's text and the elements you can use, with refs. click, fill and press_key act on one ref and then say what changed, or that nothing changed. " +
				"If nothing changed, try a different element instead of the same one. To read messages, articles or lists, use read_tab. " +
				"If a tool fails twice with the same error, stop and tell the user the error. " +
				"Go to the part of a site that matches the user's words: messages are in Messaging or the inbox, not in Notifications. " +
				"Before you answer, check that it is what the user asked for. Say a task is done only when a tool result shows it, and report only what tool results say. " +
				"Keep answers short and write plain text without markdown.",
			{ tag: false },
		),
	],
});

function el(tag, cls, text) {
	const node = document.createElement(tag);
	if (cls) node.className = cls;
	if (text !== undefined) node.textContent = text;
	return node;
}

const textOf = (content) =>
	typeof content === "string" ? content : content.filter((b) => b.type === "text").map((b) => b.text).join("\n");

/** Assistant text with **bold** shown as bold; the small model writes markdown even when asked not to. */
function richText(cls, text) {
	const node = el("div", cls);
	text.split(/\*\*(.+?)\*\*/g).forEach((part, i) => node.append(i % 2 ? el("strong", "", part) : part));
	return node;
}

const openTools = new Set(); // tool results the user expanded survive re-renders
function toolChip(id, name, args, state, result) {
	const chip = el("details", `tool ${state}`);
	const summary = el("summary");
	summary.append(el("span", "tool-name", name), el("span", "tool-args", JSON.stringify(args ?? {})));
	chip.append(summary);
	if (result !== undefined) chip.append(el("pre", "tool-result", result));
	chip.open = openTools.has(id);
	chip.addEventListener("toggle", () => (chip.open ? openTools.add(id) : openTools.delete(id)));
	return chip;
}

function render(view) {
	const log = $("log");
	log.replaceChildren();
	const results = new Map();
	for (const e of view.entries) {
		if (e.kind === "pi.tool-result") results.set(e.model[0].toolCallId, e.model[0]);
	}
	for (const e of view.entries) {
		const m = e.model?.[0];
		if (e.kind === "pi.user" && textOf(m.content) === NUDGE) log.append(el("div", "msg note", "The agent told you to do a step itself, so it was asked to do it on its own."));
		else if (e.kind === "pi.user") log.append(el("div", "msg user", textOf(m.content)));
		if (e.kind === "pi.assistant") {
			const t = textOf(m.content);
			if (t) log.append(richText("msg assistant", t));
			if (m.stopReason === "error" || m.stopReason === "aborted") log.append(el("div", "msg error", m.errorMessage ?? m.stopReason));
			for (const call of m.content.filter((b) => b.type === "toolCall")) {
				const result = results.get(call.id);
				const state = result ? (result.isError ? "failed" : "done") : "running";
				log.append(toolChip(call.id, call.name, call.arguments, state, result && textOf(result.content)));
			}
		}
	}
	const live = view.docs["pi.live"] ?? {};
	for (const t of live.tools ?? []) {
		if (t.status !== "done") log.append(toolChip(t.callId ?? t.name, t.name, undefined, "running"));
	}
	const partial = live.generation?.message;
	if (live.run && !partial && !(live.tools ?? []).some((t) => t.status !== "done")) log.append(el("div", "msg assistant thinking", "…"));
	if (partial) log.append(richText("msg assistant", textOf(partial.content) || "…"));
	if (live.runFailure) log.append(el("div", "msg error", `Run ended: ${live.runFailure.reason ?? live.runFailure.kind ?? ""} ${live.runFailure.detail ?? ""}`));
	log.setAttribute("aria-busy", String(Boolean(live.run))); // screen readers wait for the finished answer
	$("hero").hidden = log.childElementCount > 0;
	$("send").disabled = false;
	$("scroller").scrollTop = $("scroller").scrollHeight;
}

async function main() {
	if (sessionStorage.getItem("reset")) {
		sessionStorage.removeItem("reset");
		await IndexedDbStorage.delete(DB);
	}
	if (!onboarded()) {
		status("Setting up");
		await onboard(); // ends with the model loaded
	} else if (!navigator.gpu) return status("WebGPU is not available in this browser.");

	const loaded = new Map(); // bytes per file; the weights come in several files, so a percentage would jump back
	await loadModel((p) => {
		if (p.status === "progress") loaded.set(p.file, p.loaded);
		if (p.status === "progress") status(`Loading model… ${Math.round([...loaded.values()].reduce((a, b) => a + b, 0) / 1e6)} MB`);
		if (p.status === "ready") status("Compiling model on the GPU…");
	});
	const models = createModels();
	models.setProvider(localProvider);
	const registry = createRegistry();
	registry.install(Assistant);
	registry.install(BrowserTools);
	const bridge = await bridgeAvailable(); // tab and web tools only when the extension is installed
	if (bridge) registry.install(TabTools);

	// One owner per database: a second tab waits here instead of corrupting the session.
	await navigator.locks.request(DB, { ifAvailable: true }, async (lock) => {
		if (!lock) return status("This chat is open in another tab.");
		const storage = await IndexedDbStorage.open(DB);
		// pi's defaults (16K kept free, 20K kept verbatim) are for big models; this window is 32K tokens.
		const settings = { compaction: { reserveTokens: 4000, keepRecentTokens: 8000, backgroundTokens: 0 } };
		const harness = await Harness.open(storage, { models, registry, settings }, ctx);
		// maxTurns ends a run that keeps calling tools, such as a model stuck repeating one click.
		const root = await harness.root(ctx, { agent: { model: { provider: PROVIDER, modelId: MODEL_ID }, maxTurns: 30 } });
		harness.resume(); // continues a run that a reload or crash interrupted
		const send = (content) => root.submit({ type: "input", content }, ctx); // queued behind a running answer

		globalThis.agent = { harness, root, ctx }; // for poking around in DevTools

		const watch = await root.watch(ctx);
		render(watch.value);
		watch.start(async (call) => {
			if (call.kind !== "value") return;
			try {
				render(call.value);
			} catch (error) {
				console.error("render failed", error); // a throwing listener would end pi's watch
			}
		});
		watch.closed.then((end) => end.kind !== "stopped" && status(`Chat view stopped: ${end.kind} ${end.error?.message ?? ""}`));

		$("form").addEventListener("submit", async (event) => {
			event.preventDefault();
			const content = $("input").value.trim();
			if (!content) return;
			$("input").value = "";
			try {
				await send(content);
			} catch (error) {
				console.error(error);
				status(`Could not send: ${error.message}`);
			}
		});
		$("clear").addEventListener("click", () => {
			sessionStorage.setItem("reset", "1");
			location.reload();
		});
		for (const b of document.querySelectorAll("[data-prompt]")) {
			b.addEventListener("click", () => {
				$("input").value = b.dataset.prompt;
				$("form").requestSubmit();
			});
		}
		status(`Ready · ${MODEL_ID.split("/")[1]} on WebGPU · history in IndexedDB · ${bridge ? "tab and web tools on" : "tab and web tools off"}`);
		await new Promise(() => {}); // hold the lock for the page's lifetime
	});
}

main().catch((error) => {
	console.error(error);
	status(`Error: ${error.message}`);
});
