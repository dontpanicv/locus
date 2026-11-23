// First visit: check the browser, explain and install the extension, then download the model with its license shown.
// After that the page opens straight to the chat and the model loads from the browser's cache.
import { bridgeAvailable } from "./bridge-tools.js";
import { loadModel } from "./local-provider.js";

const KEY = "onboarded"; // localStorage; set once the model has loaded in this browser
const MODEL_BYTES = 2_820_846_165; // the files this revision loads, for a progress bar that doesn't jump as files start
const $ = (id) => document.getElementById(id);

export function onboarded() {
	try {
		return localStorage.getItem(KEY) === "1";
	} catch {
		return false; // storage blocked: show the onboarding, which still works
	}
}

function show(step) {
	for (const s of document.querySelectorAll("[data-step]")) s.hidden = s.dataset.step !== step;
	document.querySelector(`[data-step="${step}"] h2`).focus();
}

const gb = (bytes) => (bytes / 1e9).toFixed(1);

/** Lines for the requirements list; `ok` false on any line blocks the start. */
async function requirements() {
	const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
	const { quota = 0, usage = 0 } = (await navigator.storage?.estimate?.().catch(() => undefined)) ?? {};
	const free = quota - usage;
	return [
		!adapter
			? { ok: false, text: "WebGPU is not available. Use a recent Chrome or Edge on a computer with a graphics card." }
			: !adapter.features.has("shader-f16")
				? { ok: false, text: "Your graphics card doesn't support 16-bit floats in WebGPU (shader-f16), which this model needs." }
				: { ok: true, text: "WebGPU with 16-bit floats is available." },
		free && free < MODEL_BYTES * 1.2
			? { ok: true, warn: true, text: `Only ${gb(free)} GB of storage is free for this site; the model needs about ${gb(MODEL_BYTES)} GB.` }
			: { ok: true, text: `Storage: about ${gb(MODEL_BYTES)} GB for the model, kept in this browser.` },
	];
}

/** Runs the onboarding and resolves once the model is loaded. */
export function onboard() {
	document.body.classList.add("onboarding");
	return new Promise((resolve) => {
		// Step 1: what this is, and whether this browser can run it.
		show("welcome");
		requirements().then((lines) => {
			$("requirements").replaceChildren(
				...lines.map((l) => {
					const li = document.createElement("li");
					li.className = l.ok ? (l.warn ? "warn" : "ok") : "bad";
					li.textContent = l.text;
					return li;
				}),
			);
			$("start").disabled = !lines.every((l) => l.ok);
		});

		// Step 2: the extension. Polls until it answers, so the step updates as soon as it's loaded.
		let polling;
		$("start").addEventListener("click", () => {
			show("extension");
			const check = async () => {
				const on = await bridgeAvailable();
				$("bridge-state").textContent = on ? "Extension connected." : "Waiting for the extension…";
				$("bridge-state").classList.toggle("ok", on);
				$("to-model").textContent = on ? "Continue" : "Continue without it";
				if (!on) polling = setTimeout(check, 1500);
			};
			check();
		});
		$("copy-url").addEventListener("click", async () => {
			await navigator.clipboard.writeText("chrome://extensions").catch(() => {});
			$("copy-url").textContent = "Copied";
		});

		// Step 3: the model.
		$("to-model").addEventListener("click", () => {
			clearTimeout(polling);
			show("model");
		});
		$("download").addEventListener("click", async () => {
			$("download").disabled = true;
			$("download-error").textContent = "";
			$("progress").hidden = false;
			navigator.storage.persist?.(); // ask the browser not to evict the model when space runs low
			const files = new Map(); // file → [loaded, total]; the weights come in several files
			try {
				await loadModel((p) => {
					if (p.status !== "progress") return;
					files.set(p.file, [p.loaded, p.total]);
					let loaded = 0;
					let total = 0;
					for (const [l, t] of files.values()) (loaded += l), (total += t);
					const all = Math.max(total, MODEL_BYTES);
					$("progress").value = loaded / all;
					$("progress-text").textContent = loaded >= all ? "Preparing the model on your graphics card…" : `${gb(loaded)} GB of ${gb(all)} GB`;
				});
			} catch (error) {
				console.error(error);
				$("download-error").textContent = `The download failed: ${error.message}. Try again; files that finished are kept.`;
				$("download").disabled = false;
				return;
			}
			try {
				localStorage.setItem(KEY, "1");
			} catch {} // without storage the onboarding shows again next time, and the model comes from the cache
			document.body.classList.remove("onboarding");
			resolve();
		});
	});
}
