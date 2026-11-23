// Agent evals: gives the real agent (Qwen on WebGPU, in a throwaway Chrome profile) a task, then checks what it
// did to the fake sites and what it answered. Each scenario starts from a fresh chat with the same three user tabs
// open: the warden repo on GitHub, the LinkedIn feed, and a Shop Journal article.
// Usage: node evals/agent.mjs [name filter...]   e.g. node evals/agent.mjs linkedin
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { handsBack } from "../src/parse.js";
import { reset, start, state } from "./fixtures.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const APP = "http://localhost:8787/";
const SCENARIO_MS = 6 * 60_000;

const any = (text, ...res) => res.some((re) => re.test(text));
const all = (text, ...res) => res.every((re) => re.test(text));
// A check returns true, or a string saying what went wrong: need(cond, why) for one condition, first(...) for several.
const need = (cond, why) => Boolean(cond) || why;
const first = (...outcomes) => outcomes.find((o) => o !== true) ?? true;

const called = (calls, name) => need(calls.some((c) => c.name === name && !c.error), `no successful ${name}`);
const noNewTabs = (newTabs) => need(newTabs === 0, `${newTabs} new tabs`);

/** Each check gets: answer, calls [{name, args, error, result}], tabs (the user's three, as puppeteer pages),
 * pages after the run [{url, isNew}], newTabs, state of the fake sites, and clipboard(). */
const SCENARIOS = [
	// What the user tried.
	{ name: "user: list tabs", prompt: "What tabs do I have open?", check: ({ answer, calls }) =>
		first(called(calls, "list_tabs"), need(all(answer, /warden/i, /linkedin|feed/i, /webgpu|shop journal/i), "answer misses a tab")) },
	// As the user ran it: the second line only makes sense after the first.
	{ name: "user: switch the warden tab to actions", prompts: ["What tabs do I have open?", "on warden one switch to actions"], check: ({ tabs, newTabs }) =>
		first(need(tabs.github.url().endsWith("/getsentry/warden/actions"), `warden tab is at ${tabs.github.url()}`), noNewTabs(newTabs)) },
	{ name: "user: read linkedin messages", prompt: "read last couple of messages I got on linkedin", check: ({ answer, newTabs }) => {
		const found = [/pricing|CFO/i, /proposal|data team/i, /onboarding doc/i, /demo on Thursday|still on for the demo/i].filter((re) => re.test(answer)).length;
		return first(need(found >= 2, `answer has ${found} of the messages`), need(newTabs <= 1, `${newTabs} new tabs`));
	} },
	// As the user ran it, with no LinkedIn tab open; the agent answered with notifications and told the user to click.
	{ name: "user: sum up linkedin messages without a tab", prompt: "Go to my linkedin and sum up last 3 messages I got", without: ["linkedin"], check: ({ answer }) => {
		const found = [/pricing|CFO/i, /proposal|data team/i, /onboarding doc/i, /demo on Thursday|still on for the demo/i].filter((re) => re.test(answer)).length;
		return first(need(found >= 2, `answer has ${found} of the messages`), need(!/viewed your profile|five lessons|invited you/i.test(answer), "answer reports notifications as messages"), need(!handsBack(answer), "answer hands the work back"));
	} },
	{ name: "user: accept linkedin invitations", prompt: "open linkedin and accept all invitations there", check: () =>
		first(
			need(Object.values(state.invitations).every((s) => s === "accepted"), `invitations: ${JSON.stringify(state.invitations)}`),
			need(!state.connected.length, `also sent connection requests to ${state.connected}`),
		) },
	{ name: "user: time and time zone", prompt: "What time is it and what time zone am I in?", check: ({ answer, calls, timeZone }) =>
		first(called(calls, "get_datetime"), need(answer.includes(timeZone) || answer.includes(timeZone.split("/").at(-1).replace("_", " ")), `no ${timeZone} in answer`)) },
	{ name: "user: fill a form", prompt: "Open https://shop.test/form.html, type Ada into the Name field, pick Blue as the color, then click the Press me button.", check: async ({ pages }) => {
		for (const p of pages.filter((p) => p.url.includes("form.html"))) {
			const out = await p.page.$eval("#out", (e) => e.textContent).catch(() => "");
			if (out === "clicked trusted=true name=Ada color=Blue") return true;
		}
		return "no form page shows the click with Ada and Blue";
	} },
	{ name: "user: web search", prompt: "Search the web for WebGPU browser support and summarize the top result.", check: ({ answer, calls }) =>
		first(called(calls, "web_search"), need(answer.length > 60, "answer too short")) },
	{ name: "user: read pages over several turns", prompts: [
		"Open https://shop.test/article/webgpu.html and read it.",
		"Now open https://shop.test/article/lamps.html and read it.",
		"Now open https://shop.test/article/rugs.html and read it.",
		"In one sentence each, what were the three pages about?",
	], check: ({ answer }) => need(all(answer, /webgpu/i, /lamp|light/i, /rug/i), "the summary misses a page") },

	// One per tool.
	{ name: "tool: get_location", prompt: "Where am I right now?", check: ({ answer, calls }) =>
		first(called(calls, "get_location"), need(any(answer, /50\.0[78]/, /14\.4[34]/, /prague/i), "answer has no location")) },
	{ name: "tool: get_device_info", prompt: "Tell me about my device and battery.", check: ({ calls }) => called(calls, "get_device_info") },
	{ name: "tool: get_storage_info", prompt: "How much storage is this app using?", check: ({ answer, calls }) =>
		first(called(calls, "get_storage_info"), need(/[GM]B|gigabyte|megabyte/i.test(answer), "answer has no size")) },
	{ name: "tool: show_notification", prompt: "Send me a notification that says the demo works.", check: ({ calls }) =>
		need(calls.some((c) => c.name === "show_notification" && !c.error && /demo works/i.test(JSON.stringify(c.args))), "no notification saying the demo works") },
	{ name: "tool: copy_to_clipboard", prompt: "Copy a short haiku about browsers to my clipboard.", check: async ({ clipboard }) => {
		const text = await clipboard();
		return need(text.trim().split(/\s+/).length >= 6, `clipboard holds "${text}"`);
	} },
	{ name: "tool: fetch_url", prompt: "Without opening a tab, download https://shop.test/article/rugs.html and tell me how long wool rugs last.", check: ({ answer, calls, newTabs }) =>
		first(called(calls, "fetch_url"), noNewTabs(newTabs), need(/twenty|20/i.test(answer), "wrong answer")) },
	{ name: "tool: read_tab", prompt: "In my Shop Journal tab, which Safari version turned on WebGPU?", check: ({ answer, newTabs }) =>
		first(need(/26/.test(answer), "answer has no 26"), noNewTabs(newTabs)) },
	{ name: "tool: open_tab", prompt: "Open https://shop.test/products.html in a new tab.", check: ({ pages }) =>
		need(pages.some((p) => p.isNew && p.url.includes("shop.test/products.html")), "no new products tab") },
	{ name: "tool: close_tab", prompt: "Close my Shop Journal tab.", check: ({ tabs }) =>
		first(need(tabs.article.isClosed(), "the article tab is still open"), need(!tabs.github.isClosed() && !tabs.linkedin.isClosed(), "closed another tab too")) },
	{ name: "tool: navigate and go_back", prompt: "In my warden tab, open the Issues page and tell me the first issue's title, then go back to the repo page.", check: ({ answer, tabs, newTabs }) =>
		first(need(/time out on large diffs/i.test(answer), "answer misses the first issue"), need(tabs.github.url().endsWith("/getsentry/warden"), `warden tab is at ${tabs.github.url()}`), noNewTabs(newTabs)) },
	{ name: "tool: scroll", prompt: "Open https://shop.test/list.html. It loads more items as you scroll down. How much does Item 45 cost?", check: ({ answer }) => need(/\$?142\b/.test(answer), "answer is not $142") },
	{ name: "tool: fill and press_key", prompt: "On https://shop.test/products.html, search for lamp and tell me which lamp is the cheapest.", check: ({ answer }) =>
		need(/mini desk lamp/i.test(answer) && /24/.test(answer), "answer is not the Mini desk lamp at $24") },

	// Tools together.
	{ name: "combo: reply on linkedin", prompt: "On LinkedIn, reply to Ada Novak with: See you Thursday!", check: () => {
		const last = state.conversations.find((c) => c.id === "c1").messages.at(-1);
		return need(last.from === "You" && /see you thursday/i.test(last.text), `last message in Ada's thread: ${JSON.stringify(last)}`);
	} },
	{ name: "combo: search a shop and copy", prompt: "Find the cheapest lamp on https://shop.test/products.html and copy its name to my clipboard.", check: async ({ clipboard }) => {
		const text = await clipboard();
		return need(/mini desk lamp/i.test(text), `clipboard holds "${text}"`);
	} },
	{ name: "combo: find a tab and read it", prompt: "Which of my open tabs is about WebGPU, and what does it say about the fastest demo?", check: ({ answer }) => need(/30 tokens/i.test(answer), "answer misses 30 tokens per second") },
	{ name: "combo: check a github workflow", prompt: "Did the latest Release workflow of warden pass? Check its Actions page.", check: ({ answer }) => need(/fail/i.test(answer), "answer does not say it failed") },
];

async function appServer() {
	if (await fetch(APP).then((r) => r.ok, () => false)) return undefined; // already running: use it
	const child = spawn("npm", ["start"], { cwd: `${here}..`, stdio: "ignore" });
	for (let i = 0; i < 60 && !(await fetch(APP).then((r) => r.ok, () => false)); i++) await new Promise((r) => setTimeout(r, 500));
	return child;
}

const filters = process.argv.slice(2).map((f) => f.toLowerCase());
const chosen = SCENARIOS.filter((s) => !filters.length || filters.some((f) => s.name.toLowerCase().includes(f)));
execFileSync("npm", ["run", "build", "--silent"], { cwd: `${here}..`, stdio: "ignore" }); // the server serves the bundle as built
const child = await appServer();
const server = await start();
const browser = await launch();
await browser.defaultBrowserContext().overridePermissions(new URL(APP).origin, ["geolocation", "notifications", "clipboard-read", "clipboard-sanitized-write"]);
const app = await browser.newPage();
await app.setGeolocation({ latitude: 50.0755, longitude: 14.4378 });
await app.evaluateOnNewDocument(() => localStorage.setItem("onboarded", "1")); // straight to the chat; models/ is served locally
for (const p of await browser.pages()) if (p !== app) await p.close();

async function freshChat(first) {
	if (first) await app.goto(APP);
	else await Promise.all([app.waitForNavigation(), app.click("#clear")]);
	await app.waitForFunction(() => /^Ready|Error|WebGPU is not/.test(document.querySelector("#status").textContent), { timeout: 300_000 });
	const status = await app.$eval("#status", (e) => e.textContent);
	if (!/^Ready.*tab and web tools on/.test(status)) throw new Error(`App not ready: ${status}`);
}

/** What the run did, from the conversation pi keeps. */
const transcript = () => app.evaluate(async () => {
	const w = await agent.root.watch(agent.ctx);
	const text = (c) => (typeof c === "string" ? c : c.filter((b) => b.type === "text").map((b) => b.text).join("\n"));
	const results = new Map(w.value.entries.filter((e) => e.kind === "pi.tool-result").map((e) => [e.model[0].toolCallId, e.model[0]]));
	const calls = [];
	let answer = "";
	const nudges = w.value.entries.filter((e) => e.kind === "pi.user" && text(e.model[0].content).startsWith("Do the remaining steps yourself")).length;
	const errors = [];
	for (const e of w.value.entries.filter((e) => e.kind === "pi.assistant")) {
		const m = e.model[0];
		if (m.stopReason === "error") errors.push(m.errorMessage);
		answer = text(m.content) || answer;
		for (const c of m.content.filter((b) => b.type === "toolCall")) {
			const r = results.get(c.id);
			calls.push({ name: c.name, args: c.arguments, error: r?.isError ? text(r.content).slice(0, 600) : undefined, result: r && !r.isError ? text(r.content).slice(0, 1500) : undefined });
		}
	}
	const failure = w.value.docs["pi.live"]?.runFailure;
	return { answer, calls, errors, nudges, failure: failure && `${failure.reason ?? failure.kind ?? ""} ${failure.detail ?? ""}`.trim(), prompt: w.value.entries.at(-1)?.model?.[0]?.usage?.input };
});

const results = [];
const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
mkdirSync(`${here}results`, { recursive: true });
let firstScenario = true;
for (const scenario of chosen) {
	try {
		results.push(await runScenario(scenario));
	} catch (error) {
		// A stuck page shouldn't end the whole run: record it and start the next scenario from a fresh page.
		console.log(`FAIL ${scenario.name}\n     the eval itself failed: ${error.message.split("\n")[0]}`);
		results.push({ name: scenario.name, pass: false, why: `eval error: ${error.message.split("\n")[0]}` });
		firstScenario = true;
	}
	writeFileSync(`${here}results/agent-${stamp}.json`, JSON.stringify(results, null, 1));
}

async function runScenario(scenario) {
	const started = Date.now();
	reset();
	for (const p of await browser.pages()) if (p !== app) await p.close();
	const tabs = {};
	for (const [key, url] of [["github", "https://github.com/getsentry/warden"], ["linkedin", "https://www.linkedin.com/feed/"], ["article", "https://shop.test/article/webgpu.html"]]) {
		if (scenario.without?.includes(key)) continue;
		tabs[key] = await browser.newPage();
		await tabs[key].goto(url);
	}
	await app.bringToFront();
	await freshChat(firstScenario);
	firstScenario = false;
	const before = new Set(await browser.pages());
	let timedOut = false;
	const deadline = Date.now() + SCENARIO_MS;
	for (const prompt of scenario.prompts ?? [scenario.prompt]) {
		await app.bringToFront();
		await app.type("#input", prompt);
		await app.click("#send");
		await app.waitForFunction(() => document.querySelector("#log").getAttribute("aria-busy") === "true", { timeout: 30_000, polling: 100 }).catch(() => {});
		const left = deadline - Date.now();
		const done = await app.waitForFunction(() => document.querySelector("#log").getAttribute("aria-busy") === "false", { timeout: Math.max(left, 1000), polling: 250 }).then(() => true, () => false);
		if (process.env.VERBOSE) console.log(`     prompt done in ${Math.round((Date.now() - started) / 1000)} s: ${prompt}`);
		if (!done) {
			timedOut = true;
			break;
		}
	}
	const run = await transcript();
	const pages = await Promise.all((await browser.pages()).filter((p) => p !== app).map(async (p) => ({ page: p, url: p.url(), isNew: !before.has(p) })));
	const timeZone = await app.evaluate(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
	const clipboard = () => app.bringToFront().then(() => app.evaluate(() => navigator.clipboard.readText())).catch((e) => `(could not read: ${e.message})`);
	let outcome;
	try {
		outcome = timedOut ? "timed out" : await scenario.check({ ...run, tabs, pages, newTabs: pages.filter((p) => p.isNew).length, timeZone, clipboard });
	} catch (error) {
		outcome = `check threw: ${error.message}`;
	}
	const result = {
		name: scenario.name,
		pass: outcome === true,
		why: outcome === true ? "" : String(outcome),
		seconds: Math.round((Date.now() - started) / 1000),
		toolCalls: run.calls.length,
		failedCalls: run.calls.filter((c) => c.error).length,
		newTabs: pages.filter((p) => p.isNew).length,
		lastPromptTokens: run.prompt,
		nudges: run.nudges, // answers that told the user to click, so the agent was asked to go on
		handsBack: handsBack(run.answer), // the final answer still does
		calls: run.calls,
		answer: run.answer,
		errors: run.errors,
		failure: run.failure,
	};
	console.log(`${result.pass ? "PASS" : "FAIL"} ${scenario.name} (${result.seconds} s, ${result.toolCalls} calls, ${result.failedCalls} failed, ${result.newTabs} new tabs${result.nudges ? `, ${result.nudges} nudged` : ""}${result.handsBack ? ", hands back" : ""})${result.pass ? "" : `\n     ${result.why}`}`);
	console.log(`     calls: ${run.calls.map((c) => `${c.name}${c.error ? "✗" : ""}`).join(" ")}`);
	console.log(`     answer: ${run.answer.replace(/\s+/g, " ").slice(0, 240)}`);
	if (run.failure) console.log(`     run ended: ${run.failure}`);
	return result;
}

await browser.close();
await server.close();
child?.kill();
const passed = results.filter((r) => r.pass).length;
console.log(`\nagent: ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
