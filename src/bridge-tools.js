// Tools that go through the Locus Bridge extension (../extension): tabs and web pages.
// The extension only runs commands; parsing and trimming for the model happen here in the page.
import { defineExtension, defineTool, GenerationTask, hook } from "@earendil-works/pi-durable";
import { handsBack } from "./parse.js";
import { changes, clickableIds, refId, snapshotLines } from "./snapshot.js";

// Fixed by the "key" in extension/manifest.json, so it is the same on every machine.
export const EXTENSION_ID = "pfalegngbacegjcckgmgfiffjkndhdbo";
// shortcut: a fixed cut keeps a page within a small model's context; summarize in chunks if answers miss content.
const MAX_CHARS = 6000;

function call(command, args) {
	return new Promise((resolve, reject) => {
		if (!globalThis.chrome?.runtime?.sendMessage) return reject(new Error("The Locus Bridge extension is not installed"));
		chrome.runtime.sendMessage(EXTENSION_ID, { command, args }, (reply) => {
			if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
			// An older extension doesn't know newer commands; say what fixes it so the model stops retrying.
			if (/^Unknown command/.test(reply?.error)) return reject(new Error("The Locus Bridge extension is out of date and can't do this. Tell the user to press reload on it at chrome://extensions, and don't call this tool again until then."));
			if (/No tab with (given )?id/i.test(reply?.error)) return reject(new Error(`Tab ${args?.tabId} is closed or does not exist; call list_tabs to see the open tabs.`));
			if (reply?.error) return reject(new Error(reply.error));
			resolve(reply?.result);
		});
	});
}

/** True when the extension answers within a second. */
export const bridgeAvailable = () =>
	Promise.race([call("ping").then(() => true, () => false), new Promise((r) => setTimeout(() => r(false), 1000))]);

const ok = (value) => ({ output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const trim = (text) => {
	const clean = text.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
	return clean.length > MAX_CHARS ? `${clean.slice(0, MAX_CHARS)}\n[cut at ${MAX_CHARS} characters]` : clean;
};

/** HTML → readable text, parsed here because the extension's service worker has no DOMParser. */
export function htmlToText(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	for (const n of doc.querySelectorAll("script, style, noscript, svg, template, iframe, nav, header, footer, aside, form")) n.remove();
	for (const n of doc.querySelectorAll("br, p, div, li, h1, h2, h3, h4, h5, h6, tr, section, article")) n.append("\n");
	const main = doc.querySelector("main, article, [role=main]") ?? doc.body; // skip site menus when the page marks its content
	return { title: doc.title.trim(), text: main?.textContent ?? "" };
}

/** Bing results page → [{title, url, snippet}]. */
export function parseSearchResults(html) {
	const doc = new DOMParser().parseFromString(html, "text/html");
	return [...doc.querySelectorAll("li.b_algo")]
		.map((r) => {
			const a = r.querySelector("h2 a");
			if (!a) return undefined;
			const href = new URL(a.getAttribute("href"), "https://www.bing.com");
			// Result links go through bing.com/ck/a with the target as "a1" + base64url in the u parameter.
			const u = href.searchParams.get("u");
			const bytes = u?.startsWith("a1") && Uint8Array.from(atob(u.slice(2).replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
			const url = bytes ? new TextDecoder().decode(bytes) : href.href;
			return { title: a.textContent.trim(), url, snippet: r.querySelector(".b_caption p")?.textContent.trim() ?? "" };
		})
		.filter(Boolean);
}

const fetchUrl = defineTool({
	name: "fetch_url",
	description: "Download a web page in the background, without opening a tab, and return its text.",
	parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	replay: "safe",
	execute: async ({ url }) => {
		const res = await call("fetch", { url });
		if (res.status >= 400) throw new Error(`HTTP ${res.status} for ${res.url}`);
		const isHtml = /html/.test(res.contentType ?? "");
		const page = isHtml ? htmlToText(res.body) : { title: "", text: res.body };
		return ok(`${page.title}\n${res.url}\n\n${trim(page.text)}`);
	},
});

const webSearch = defineTool({
	name: "web_search",
	description: "Search the web with Bing and return the top results with title, URL and snippet. Use fetch_url to read one.",
	parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
	replay: "safe",
	execute: async ({ query }) => {
		const res = await call("fetch", { url: `https://www.bing.com/search?q=${encodeURIComponent(String(query))}` });
		const results = parseSearchResults(res.body).slice(0, 5);
		if (!results.length) throw new Error(`No results (HTTP ${res.status}); the search page may have blocked the request`);
		return ok(results.map((r, i) => `${i + 1}. ${r.title}\n${r.url}\n${r.snippet}`).join("\n\n"));
	},
});

// Browser use in the style of Vercel's agent-browser: snapshot the page with refs, act on a ref, see what changed.
// Everything goes through the DevTools protocol, so clicks and keys are real input events, not script calls.
// The harness, not the model, keeps track of state: which tab it is working in and which refs it was shown.
const cdp = (tabId, method, params) => call("cdp", { tabId, method, params });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// shortcut: kept in memory, so a reload mid-run forgets the working tab and the shown refs; the model then
// passes a tab id or takes a new snapshot. Persist in sessionStorage if reloads mid-task become common.
let current; // the tab the agent works in: the last one it opened or used
const latest = new Map(); // tabId → the last snapshot the model was shown: { title, url, lines }

/** The chat's own tab, which the tools must never drive: navigating it would end the agent mid-run. */
const isChat = (tab) => tab.url?.startsWith(`${location.origin}/`);

/** The tab a call is about: the one it names, or the working tab. Naming a tab makes it the working tab. */
async function tabOf(args) {
	const id = args?.tabId ?? current;
	if (id === undefined || id === null || id === "") throw new Error("No tab to work in yet. Use navigate with a URL to open one, or list_tabs to pick one of the user's tabs.");
	const tab = (await call("list_tabs")).find((t) => t.tabId === Number(id));
	if (!tab) throw new Error(`Tab ${id} is closed or does not exist; call list_tabs to see the open tabs.`);
	if (isChat(tab)) throw new Error(`Tab ${id} is this chat, which you can't use. Use navigate with a URL to open a tab, or pick another tab from list_tabs.`);
	current = Number(id);
	return current;
}

// In the page: counts DOM changes and finished requests, so settle can tell when a single-page app is done drawing.
const ACTIVITY = `(() => {
	if (window.__agentChanges === undefined) {
		window.__agentChanges = 0;
		new MutationObserver(() => window.__agentChanges++).observe(document, { subtree: true, childList: true, characterData: true });
	}
	return [document.readyState, window.__agentChanges + performance.getEntriesByType("resource").length];
})()`;

/**
 * Waits until the page has loaded and stopped changing for 750 ms (8 s at most): "load" fires before most apps
 * have fetched their data and drawn it. Polled from here because timers in a background tab are throttled.
 */
async function settle(tabId) {
	await sleep(300);
	let last;
	let quiet = 0;
	for (let waited = 0; waited < 8000 && quiet < 3; waited += 250) {
		const value = (await cdp(tabId, "Runtime.evaluate", { expression: ACTIVITY, returnByValue: true }).catch(() => null))?.result?.value;
		const count = value?.[0] === "complete" ? value[1] : NaN; // NaN never matches, so a loading page is never quiet
		quiet = count === last ? quiet + 1 : 0;
		last = count;
		await sleep(250);
	}
}

/** Takes a snapshot and remembers it as what the model has seen of this tab. */
async function look(tabId) {
	const [{ nodes }, dom, page] = await Promise.all([
		cdp(tabId, "Accessibility.getFullAXTree", {}),
		cdp(tabId, "DOMSnapshot.captureSnapshot", { computedStyles: ["cursor"] }).catch(() => null),
		cdp(tabId, "Runtime.evaluate", { expression: "[document.title, location.href]", returnByValue: true }),
	]);
	const [title, url] = page.result.value;
	const lines = snapshotLines(nodes, { clickable: dom ? clickableIds(dom) : undefined });
	const seen = { title, url, lines };
	const before = latest.get(tabId);
	latest.set(tabId, seen);
	return { seen, before, full: `Tab ${tabId}: ${title}\n${url}\n\n${lines.join("\n")}` };
}

/**
 * A ref ("e123") or an element's name from the latest snapshot of the tab → its backend node id, and how the
 * snapshot shows it. Names are there because a small model miscopies numbers from the line next to the one it means.
 */
function target(tabId, ref) {
	const lines = (latest.get(tabId)?.lines ?? []).filter((l) => /\[ref=e\d+\]/.test(l));
	let line;
	if (/^@?e\d+$/.test(String(ref).trim())) {
		line = lines.find((l) => l.includes(`[ref=e${refId(ref)}]`));
		if (!line) throw new Error(`${ref} is not in the latest snapshot of tab ${tabId}. Refs only work in the tab and snapshot they came from; call snapshot_tab and use a ref from it.`);
	} else {
		const want = String(ref).trim().replace(/^"|"$/g, "").toLowerCase();
		const name = (l) => /"([^"]*)"/.exec(l)?.[1].toLowerCase() ?? "";
		const exact = lines.filter((l) => name(l) === want);
		const matches = exact.length ? exact : lines.filter((l) => want && name(l).includes(want));
		if (!matches.length) throw new Error(`Nothing named "${ref}" in the latest snapshot of tab ${tabId}; call snapshot_tab and use a ref from it.`);
		if (matches.length > 1) throw new Error(`"${ref}" matches ${matches.length} elements; use the ref of the one you mean:\n${matches.slice(0, 8).join("\n")}`);
		line = matches[0];
	}
	const id = Number(/\[ref=e(\d+)\]/.exec(line)[1]);
	return { id, label: `${line.slice(2).replace(/ \[ref=e\d+\]/, "")} (e${id})` };
}

/** Runs `fn` in the page with the element as `this`; fn must be self-contained, it is sent as source. */
async function onElement(tabId, { id, label }, fn, args = []) {
	const resolved = await cdp(tabId, "DOM.resolveNode", { backendNodeId: id }).catch(() => null);
	if (!resolved) throw new Error(`${label} is not on the page any more; call snapshot_tab for the current refs`);
	const { result, exceptionDetails } = await cdp(tabId, "Runtime.callFunctionOn", {
		objectId: resolved.object.objectId,
		functionDeclaration: fn.toString(),
		arguments: args.map((value) => ({ value })),
		returnByValue: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
	if (result.value?.error) throw new Error(`Can't use ${label}: ${result.value.error}`);
	return result.value;
}

// In the page: scroll the element into view and return its centre, or why a click there would miss it.
function aim() {
	// A native dropdown opens outside the page, where snapshots and clicks can't reach it.
	if (this instanceof HTMLSelectElement) return { error: `it is a dropdown; use fill with one of its options: ${[...this.options].map((o) => o.text.trim()).join(", ")}` };
	this.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
	const r = this.getBoundingClientRect();
	if (!r.width || !r.height) return { error: "it takes up no space on the page (hidden or collapsed); open the menu or section it is in first" };
	const x = r.x + r.width / 2;
	const y = r.y + r.height / 2;
	const root = this.getRootNode().elementFromPoint ? this.getRootNode() : document;
	const hit = root.elementFromPoint(x, y);
	// A styled checkbox or radio is often drawn by its label on top of it; clicking the label is how people use it.
	const label = hit?.closest?.("label");
	const ownLabel = label && (label.control === this || [...(this.labels ?? [])].includes(label));
	if (hit && hit !== this && !this.contains(hit) && !hit.contains(this) && !ownLabel) {
		return { error: `another element is on top of it, <${hit.tagName.toLowerCase()}> "${(hit.innerText ?? "").trim().slice(0, 60)}", and would get the click; if that is a dialog or banner, close it first` };
	}
	return { x, y };
}

// In the page: pick an option of a <select>, or focus and select the text of a field so typing replaces it.
function prepareFill(text) {
	this.scrollIntoView({ block: "center", behavior: "instant" });
	if (this instanceof HTMLSelectElement) {
		const options = [...this.options];
		const o = options.find((o) => o.value === text || o.text.trim().toLowerCase() === text.trim().toLowerCase());
		if (!o) return { error: `no option "${text}"; the options are ${options.map((o) => o.text.trim()).join(", ")}` };
		this.value = o.value;
		this.dispatchEvent(new Event("input", { bubbles: true }));
		this.dispatchEvent(new Event("change", { bubbles: true }));
		return { picked: true };
	}
	this.focus();
	if (typeof this.select === "function") this.select();
	else getSelection().selectAllChildren(this);
	return { picked: false };
}

const KEYS = { Enter: [13, "\r"], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], Home: [36], End: [35], PageUp: [33], PageDown: [34], Space: [32, " "] };
async function press(tabId, name) {
	const key = Object.keys(KEYS).find((k) => [k.toLowerCase(), k.replace("Arrow", "").toLowerCase()].includes(String(name).toLowerCase())) ?? String(name);
	const [code, text] = KEYS[key] ?? (key.length === 1 ? [key.toUpperCase().charCodeAt(0), key] : []);
	if (code === undefined) throw new Error(`Unknown key "${name}"; use a single character or one of ${Object.keys(KEYS).join(", ")}`);
	const event = { key: key === "Space" ? " " : key, code: key.length > 1 ? key : undefined, windowsVirtualKeyCode: code };
	await cdp(tabId, "Input.dispatchKeyEvent", { ...event, type: text ? "keyDown" : "rawKeyDown", text });
	await cdp(tabId, "Input.dispatchKeyEvent", { ...event, type: "keyUp" });
}

/** Do an action, let the page react, and say what changed: a new page comes back whole, the same page as a diff. */
async function act(tabId, done, action) {
	await action();
	await settle(tabId);
	const { seen, before, full } = await look(tabId);
	const diff = changes(before, seen);
	return ok(diff ? `${done} ${diff}\nTab ${tabId}: ${seen.title}` : `${done} Now on:\n${full}`);
}

const tabId = { type: "integer", description: "Tab id from list_tabs; leave out to use the tab you are working in" };
const ref = { type: "string", description: "The element's ref from the latest snapshot of the tab, like e123, or its name as the snapshot shows it" };

const listTabs = defineTool({
	name: "list_tabs",
	description: "List the tabs open in the user's browser, with tab id, title and URL. The tab you are working in is marked current; the one marked thisChat is this chat, which you can't use.",
	parameters: { type: "object", properties: {} },
	replay: "safe",
	execute: async () =>
		ok((await call("list_tabs")).map((t) => ({ tabId: t.tabId, title: t.title, url: t.url, ...(isChat(t) ? { thisChat: true } : t.tabId === current && { current: true }) }))),
});

const openTab = defineTool({
	name: "open_tab",
	description: "Open a URL in an extra new tab and work in it. To go somewhere in the tab you are working in, use navigate instead.",
	parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
	execute: async ({ url }) => {
		// Always behind the chat: switching tabs would take the user away from it, and the clipboard needs it in front.
		const tab = await call("open_tab", { url });
		current = tab.tabId;
		// Pages Chrome won't let extensions debug, such as the Web Store, just come without a snapshot.
		const page = await settle(tab.tabId).then(() => look(tab.tabId)).then((p) => p.full, () => `Tab ${tab.tabId}: ${tab.title}\n${tab.url}`);
		return ok(`Opened a new tab. ${page}`);
	},
});

const closeTab = defineTool({
	name: "close_tab",
	description: "Close a browser tab.",
	parameters: { type: "object", properties: { tabId }, required: ["tabId"] },
	execute: async (args) => {
		const id = Number(args.tabId); // not tabOf: closing a tab shouldn't make it the working tab
		await call("close_tab", { tabId: id });
		latest.delete(id);
		if (current !== id) return ok(`Closed tab ${id}.`);
		current = undefined;
		return ok(`Closed tab ${id}. There is no working tab now; use navigate or list_tabs.`);
	},
});

const readTab = defineTool({
	name: "read_tab",
	description: "Read all of the visible text of a tab, such as messages or an article. Leave out tabId for the tab you are working in.",
	parameters: { type: "object", properties: { tabId } },
	replay: "safe",
	execute: async (args) => {
		const id = await tabOf(args);
		const page = await call("read_tab", { tabId: id });
		return ok(`Tab ${id}: ${page.title}\n${page.url}\n\n${trim(page.text)}`);
	},
});

const snapshotTab = defineTool({
	name: "snapshot_tab",
	description: "Show a tab's text, headings and the elements you can use, each with a ref for click and fill. Leave out tabId for the tab you are working in.",
	parameters: { type: "object", properties: { tabId } },
	replay: "safe",
	execute: async (args) => ok((await look(await tabOf(args))).full),
});

const click = defineTool({
	name: "click",
	description: "Click an element by its ref, then say what changed. To choose an option of a dropdown (combobox), use fill with the option's text instead.",
	parameters: { type: "object", properties: { ref, tabId }, required: ["ref"] },
	execute: async (args) => {
		const id = await tabOf(args);
		const el = target(id, args.ref);
		return act(id, `Clicked ${el.label}.`, async () => {
			const { x, y } = await onElement(id, el, aim);
			// No "mouseMoved" first: in a background tab it waits about 5 s for a frame that never comes.
			for (const type of ["mousePressed", "mouseReleased"]) await cdp(id, "Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
		});
	},
});

const fill = defineTool({
	name: "fill",
	description: "Replace the text of a field, or pick an option of a dropdown, by its ref. Use press_key Enter to submit.",
	parameters: { type: "object", properties: { ref, text: { type: "string" }, tabId }, required: ["ref", "text"] },
	execute: async (args) => {
		const id = await tabOf(args);
		const text = String(args.text);
		const el = target(id, args.ref);
		return act(id, `Filled ${el.label}.`, async () => {
			const { picked } = await onElement(id, el, prepareFill, [text]);
			if (picked) return;
			if (text) await cdp(id, "Input.insertText", { text });
			else await press(id, "Backspace");
		});
	},
});

const pressKey = defineTool({
	name: "press_key",
	description: "Press a key on whatever has focus: Enter, Tab, Escape, Backspace, an arrow key, or one character.",
	parameters: { type: "object", properties: { key: { type: "string" }, tabId }, required: ["key"] },
	execute: async (args) => {
		const id = await tabOf(args);
		return act(id, `Pressed ${args.key}.`, () => press(id, args.key));
	},
});

const scroll = defineTool({
	name: "scroll",
	description: "Scroll down or up by most of a screen, for pages that load more as you scroll.",
	parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down"] }, tabId } },
	execute: async (args) => {
		const id = await tabOf(args);
		const up = args.direction === "up";
		// shortcut: scrolls the window by script, since a wheel event hangs in a background tab; inner scroll boxes
		// don't move. A background tab draws no frames, so it never sends "scroll" itself; pages that load more on
		// "scroll" get one, but ones that watch with IntersectionObserver only load more in the visible tab.
		const by = `${up ? -0.8 : 0.8} * innerHeight`;
		return act(id, `Scrolled ${up ? "up" : "down"}.`, () =>
			cdp(id, "Runtime.evaluate", { expression: `scrollBy({ top: ${by}, behavior: "instant" }); dispatchEvent(new Event("scroll"))` }),
		);
	},
});

const navigate = defineTool({
	name: "navigate",
	description: "Go to a URL in the tab you are working in, or in the tab you name. With no working tab, it uses a tab already on that site, or opens a new one.",
	parameters: { type: "object", properties: { url: { type: "string" }, tabId }, required: ["url"] },
	execute: async (args) => {
		const url = String(args.url);
		if (args.tabId === undefined && current === undefined) {
			// No working tab yet: a tab already on that site is the one the user means ("go to actions on warden").
			const host = URL.canParse(url) && new URL(url).host;
			const same = (await call("list_tabs")).find((t) => !isChat(t) && URL.canParse(t.url) && new URL(t.url).host === host);
			if (same) current = same.tabId;
			else {
				const tab = await call("open_tab", { url });
				current = tab.tabId;
				await settle(current);
				return ok(`Opened a new tab. ${(await look(current)).full}`);
			}
		}
		const id = await tabOf(args);
		return act(id, `Went to ${url}.`, async () => {
			const { errorText } = await cdp(id, "Page.navigate", { url });
			if (errorText) throw new Error(`Could not open ${url}: ${errorText}`);
		});
	},
});

const goBack = defineTool({
	name: "go_back",
	description: "Go back to the previous page, like the browser's back button.",
	parameters: { type: "object", properties: { tabId } },
	execute: async (args) => {
		const id = await tabOf(args);
		return act(id, "Went back.", () => cdp(id, "Runtime.evaluate", { expression: "history.back()" }));
	},
});

/**
 * What each call came out as during this request, by tool and arguments. A small model repeats calls that failed,
 * changed nothing, or led to the same dead end, sometimes with other calls in between (a 404, back, the 404 again).
 * For actions, the page they acted on is part of the call.
 * The second time a call comes out the same, its result says so; once it has come out the same twice (three times for
 * reads), the call is refused.
 * The instructions alone don't stop it. Cleared when the agent answers.
 */
const history = new Map(); // call → outcomes so far
const REPEAT = "\nYou made this exact call before and it came out the same. Don't repeat it: try something different, or tell the user what is not working.";
const sameness = (text) => text.replace(/\[ref=e\d+\]/g, "").replace(/^Tab \d+/gm, "Tab"); // refs renumber on reload
/** The page the model last saw in a tab, as a short fingerprint. */
function pageState(tabId) {
	const seen = latest.get(Number(tabId));
	if (!seen) return "";
	let hash = 0;
	for (const ch of `${seen.url}\n${seen.lines.join("\n")}`) hash = (Math.imul(hash, 31) + ch.charCodeAt(0)) | 0;
	return hash.toString(36);
}
// The same tool many times in a row with different arguments, such as search after search, is a loop too.
let streak = { tool: "", count: 0 };
const STREAK = 4;
function guarded(tool) {
	return {
		...tool,
		execute: async (args, ...rest) => {
			const tab = args?.tabId ?? current;
			// An action is "the same call" only on the same page: once the page changed (a dialog closed), it is a new try.
			const page = tool.replay === "safe" ? "" : pageState(tab);
			const key = `${tool.name} ${JSON.stringify({ ...args, tabId: tab })} ${page}`;
			const past = history.get(key) ?? [];
			// Reading again can find something new after the page changed, so reads get one more try than actions.
			const limit = tool.replay === "safe" ? 3 : 2;
			if (past.some((o) => past.filter((p) => p === o).length >= limit)) {
				throw new Error(`Refused: you made this exact ${tool.name} call ${past.length} times and it kept coming out the same. Do something else, or tell the user what is not working.`);
			}
			streak = streak.tool === tool.name ? { tool: tool.name, count: streak.count + 1 } : { tool: tool.name, count: 1 };
			const loop = streak.count >= STREAK && tool.name !== "click" // clicking through a list is normal
				? `\nThis is ${tool.name} ${streak.count} times in a row. If it isn't getting you closer, take another way, such as a tab the user has open, or tell the user what you found so far.`
				: "";
			const record = (now) => history.set(key, [...past, now]);
			try {
				const result = await tool.execute(args, ...rest);
				const block = result.output[0];
				const now = sameness(block.text);
				// Looking again (list_tabs, read_tab, snapshot_tab) is fine once; acting again is flagged at once.
				if (past.includes(now) && tool.replay !== "safe") block.text += REPEAT;
				else block.text += loop;
				record(now);
				return result;
			} catch (error) {
				const now = `error: ${sameness(error.message)}`;
				error.message += past.includes(now) ? REPEAT : loop;
				record(now);
				throw error;
			}
		},
	};
}

/** Sent for the user when an answer hands the work back ("please click on ..."); the chat shows it as a note. */
export const NUDGE =
	"Do the remaining steps yourself with your tools instead of asking me to. Ask me only for what only I can do, such as signing in or approving a send. If the task is already done, just give the answer.";

/** Continues a run whose answer tells the user to click or open something, once per request. */
async function onYield(answer, api, context) {
	history.clear(); // the next request starts with a clean slate
	streak = { tool: "", count: 0 };
	const text = answer.content.filter((b) => b.type === "text").map((b) => b.text).join("\n");
	if (!handsBack(text)) return undefined;
	const { items } = await api.entries({}, 50, undefined, context); // newest first
	const request = items.find((e) => e.kind === "pi.user");
	if (request?.model?.[0]?.content === NUDGE) return undefined; // already nudged; let it answer
	return { continue: NUDGE };
}

export const TabTools = defineExtension({
	name: "tab-tools",
	tools: [listTabs, openTab, closeTab, readTab, fetchUrl, webSearch, snapshotTab, click, fill, pressKey, scroll, navigate, goBack].map(guarded),
	hooks: [hook(GenerationTask, { onYield })],
});
