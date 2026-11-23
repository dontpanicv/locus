// Tool evals: calls every tool directly, without the model, against the fake sites and the real extension.
// Usage: node evals/tools.mjs   (prints one line per check and exits non-zero if any fails)
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { launch } from "./browser.mjs";
import { HTTP_PORT, reset, start, state } from "./fixtures.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
mkdirSync(`${here}.build`, { recursive: true });
execFileSync(`${here}../node_modules/.bin/esbuild`, [`${here}harness-entry.js`, "--bundle", "--format=esm", `--outfile=${here}.build/harness.js`, "--log-level=warning"]);
writeFileSync(`${here}.build/harness.html`, `<!doctype html><title>Tool harness</title><script type="module" src="/harness.js"></script>`);
const server = await start({ "/harness.html": `${here}.build/harness.html`, "/harness.js": `${here}.build/harness.js` });
const browser = await launch();
const origin = `http://127.0.0.1:${HTTP_PORT}`;
await browser.defaultBrowserContext().overridePermissions(origin, ["geolocation", "notifications", "clipboard-read", "clipboard-sanitized-write"]);
const harness = await browser.newPage();
await harness.setGeolocation({ latitude: 50.0755, longitude: 14.4378 });
await harness.goto(`${origin}/harness.html`);
await harness.waitForFunction(() => globalThis.run);

const results = [];
const run = async (name, args) => {
	const t = Date.now();
	const r = await harness.evaluate((n, a) => globalThis.run(n, a), name, args);
	r.ms = Date.now() - t;
	if (process.env.VERBOSE) console.log(`--- ${name} ${JSON.stringify(args ?? {})} (${r.ms} ms)\n${r.error ? `ERROR ${r.error}` : r.text}`);
	return r;
};
/** One named check: `fn` returns true, or a string saying what was wrong. */
async function check(name, fn) {
	let outcome;
	try {
		outcome = await fn();
	} catch (error) {
		outcome = error.message;
	}
	const pass = outcome === true;
	results.push({ name, pass, detail: pass ? "" : String(outcome).slice(0, 400) });
	console.log(`${pass ? "PASS" : "FAIL"} ${name}${pass ? "" : `\n     ${String(outcome).slice(0, 400).replace(/\n/g, "\n     ")}`}`);
}
const has = (r, re) => (r.text && re.test(r.text)) || `expected ${re} in: ${r.error ? `ERROR ${r.error}` : r.text}`;
const fails = (r, re) => (r.error && re.test(r.error)) || `expected an error matching ${re}, got: ${r.error ?? r.text}`;
const ref = (text, re) => re.exec(text ?? "")?.[1] ?? (() => { throw new Error(`no ref for ${re} in:\n${text}`); })();
const tabCount = async () => (await browser.pages()).length;

reset();
const userTab = await browser.newPage();
await userTab.goto("https://github.com/getsentry/warden");
await harness.bringToFront();

await check("list_tabs lists the user's tabs", async () => has(await run("list_tabs"), /getsentry\/warden/));
await check("the chat's own tab is marked and can't be driven", async () => {
	const tabs = JSON.parse((await run("list_tabs")).text);
	const chat = tabs.find((t) => t.thisChat);
	if (!chat) return "no tab is marked thisChat";
	return fails(await run("navigate", { tabId: chat.tabId, url: "https://shop.test/form.html" }), /is this chat, which you can't use/);
});
await check("a page tool with no working tab says how to get one", async () => fails(await run("snapshot_tab"), /No tab to work in yet/));

// LinkedIn messaging, where the agent got lost: content drawn after load, clickable rows, label-drawn checkboxes.
let snap;
await check("navigate with no working tab opens one and waits for the app to draw", async () => {
	const before = await tabCount();
	snap = await run("navigate", { url: "https://www.linkedin.com/messaging/" });
	if ((await tabCount()) !== before + 1) return "expected one new tab";
	return has(snap, /^Opened a new tab\. Tab \d+/) === true && has(snap, /pricing questions from our CFO/);
});
await check("the snapshot shows message text and clickable rows, not menu text", async () => {
	snap = await run("snapshot_tab");
	if (/text "Home"/.test(snap.text)) return "navigation text leaked into the snapshot";
	return has(snap, /text "Great, I will bring the pricing questions from our CFO\."/) === true && has(snap, /clickable "Tomas Berg Tomas: Thanks for the intro[^"]*" \[ref=e\d+\]/);
});
await check("a checkbox drawn by its own label can be clicked", async () => {
	const r = await run("click", { ref: ref(snap.text, /checkbox "Select conversation with Tomas Berg" \[ref=(e\d+)\]/) });
	if (r.error) return r.error;
	return state.selected.includes("c2") || `not selected: ${r.text}`;
});
await check("opening a menu reports the new items as a change on the same page", async () =>
	has(await run("click", { ref: ref(snap.text, /button "Open the options list in your conversation with Lena Fischer" \[ref=(e\d+)\]/) }), /Same page;[\s\S]*new: menuitem "Star"/));
await check("a name that matches several elements lists them instead of guessing", async () =>
	fails(await run("click", { ref: "Open the options list" }), /matches 3 elements; use the ref of the one you mean/));
await check("clicking a clickable row opens the conversation", async () =>
	has(await run("click", { ref: ref(snap.text, /clickable "Tomas Berg[^\n]*\[ref=(e\d+)\]/) }), /Now on:[\s\S]*thread\/c2[\s\S]*proposal this morning/));
await check("go_back returns to the previous conversation", async () => has(await run("go_back"), /thread\/c1[\s\S]*pricing questions/));
await check("read_tab reads the working tab", async () => has(await run("read_tab"), /Thursday at 10/));
await check("fill types into a rich text box, and Enter sends the message", async () => {
	await run("snapshot_tab");
	await run("fill", { ref: "Write a message", text: "Eval reply" });
	const r = await run("press_key", { key: "Enter" });
	return state.conversations[0].messages.at(-1).text === "Eval reply" || `not sent: ${r.error ?? r.text}`;
});

let github;
await check("open_tab opens a new tab, makes it the working tab and returns its snapshot", async () => {
	github = await run("open_tab", { url: "https://github.com/getsentry/warden" });
	return has(github, /^Opened a new tab\. Tab \d+[\s\S]*link "Actions" \[ref=e\d+\]/);
});
await check("a ref from another tab is refused", async () => fails(await run("click", { ref: ref(snap.text, /clickable "Ada Novak[^\n]*\[ref=(e\d+)\]/) }), /not in the latest snapshot of tab/));
await check("a made-up ref is refused", async () => fails(await run("click", { ref: "e999999" }), /not in the latest snapshot/));
await check("navigate reuses the working tab", async () => {
	const before = await tabCount();
	const r = await run("navigate", { url: "https://github.com/getsentry/warden/actions" });
	if ((await tabCount()) !== before) return "a tab was opened or closed";
	return has(r, /Went to[\s\S]*All workflows/);
});

// The shop: forms, keys, dropdowns, overlays, clicks that do nothing, and infinite scroll.
let form;
await check("fill and press_key search on a page that answers late", async () => {
	const page = await run("navigate", { url: "https://shop.test/products.html" });
	await run("fill", { ref: ref(page.text, /searchbox "Search products" \[ref=(e\d+)\]/), text: "lamp" });
	return has(await run("press_key", { key: "Enter" }), /Mini desk lamp — \$24/);
});
await check("fill types into a field and picks a dropdown option", async () => {
	form = await run("navigate", { url: "https://shop.test/form.html" });
	const name = await run("fill", { ref: ref(form.text, /textbox "Name"[^\n]*\[ref=(e\d+)\]/), text: "Ada" });
	if (!/new: textbox "Name" value="Ada"/.test(name.text)) return `name: ${name.text ?? name.error}`;
	const color = await run("fill", { ref: ref(form.text, /combobox "Color"[^\n]*\[ref=(e\d+)\]/), text: "blue" });
	return has(color, /value="Blue"/);
});
await check("clicking a native dropdown says to use fill and lists its options", async () =>
	fails(await run("click", { ref: ref(form.text, /combobox "Color"[^\n]*\[ref=(e\d+)\]/) }), /use fill with one of its options: Red, Blue/));
await check("click is a trusted click", async () =>
	has(await run("click", { ref: ref(form.text, /button "Press me" \[ref=(e\d+)\]/) }), /clicked trusted=true name=Ada color=Blue/));
await check("click takes an element's name and says what it clicked", async () =>
	has(await run("click", { ref: "Press me" }), /^Clicked button "Press me" \(e\d+\)\./));
await check("press_key Enter submits a form", async () => {
	await run("fill", { ref: ref(form.text, /textbox "Query"[^\n]*\[ref=(e\d+)\]/), text: "hello" });
	return has(await run("press_key", { key: "enter" }), /submitted hello Ada Blue/);
});
await check("a covered element names what is on top of it", async () =>
	fails(await run("click", { ref: ref(form.text, /button "Covered" \[ref=(e\d+)\]/) }), /another element is on top of it, <div> "overlay"/));
await check("an element far down the page is scrolled to and clicked", async () =>
	has(await run("click", { ref: ref(form.text, /button "Far away" \[ref=(e\d+)\]/) }), /far clicked/));
const nothing = ref(form.text, /button "Does nothing" \[ref=(e\d+)\]/);
await check("a click that changes nothing says so", async () => has(await run("click", { ref: nothing }), /Nothing on the page changed/));
await check("repeating a click that changed nothing is called out", async () => has(await run("click", { ref: nothing }), /You made this exact call before and it came out the same/));
await check("repeating a failing call is called out", async () => {
	await run("press_key", { key: "F13" });
	return fails(await run("press_key", { key: "F13" }), /Unknown key[\s\S]*You made this exact call before/);
});
await check("a call that keeps coming out the same is refused", async () => fails(await run("press_key", { key: "F13" }), /^Refused: you made this exact press_key call 2 times/));
await check("the same tool many times in a row is called out", async () => {
	for (const page of ["lamps", "rugs", "webgpu"]) await run("fetch_url", { url: `https://shop.test/article/${page}.html` });
	return has(await run("fetch_url", { url: "https://shop.test/form.html" }), /fetch_url 4 times in a row/);
});
await check("press_key takes arrow key short names", async () => (await run("press_key", { key: "down" })).error ?? true);
await check("scroll loads more items on an endless list", async () => {
	await run("navigate", { url: "https://shop.test/list.html" });
	let r;
	for (let i = 0; i < 3 && !/Item 2\d costs/.test(r?.text ?? ""); i++) r = await run("scroll", { direction: "down" });
	return has(r, /new: text "Item 2\d costs/);
});

// Invitations behind an upsell dialog.
await check("a dialog covering the page is named, repeats are refused, and closing it lets the click through", async () => {
	const page = await run("navigate", { url: "https://www.linkedin.com/mynetwork/invitation-manager/" });
	if (!/dialog|Try Premium/.test(page.text)) return `no dialog in: ${page.text}`;
	const accept = ref(page.text, /button "Accept Jan Dvorak's invitation" \[ref=(e\d+)\]/);
	const covered = await run("click", { ref: accept });
	if (!/another element is on top of it[\s\S]*dialog/.test(covered.error ?? "")) return `expected a covered error, got ${covered.error ?? covered.text}`;
	await run("click", { ref: accept });
	const refused = await run("click", { ref: accept });
	if (!/^Refused/.test(refused.error ?? "")) return `expected the third try on the same page to be refused, got ${refused.error ?? refused.text}`;
	await run("click", { ref: ref(page.text, /button "Dismiss" \[ref=(e\d+)\]/) });
	const r = await run("click", { ref: accept });
	return state.invitations.i1 === "accepted" || `not accepted: ${r.error ?? r.text}`;
});

await check("close_tab closes a tab, and using it afterwards says it is closed", async () => {
	const id = Number(/Tab (\d+)/.exec(github.text)[1]);
	const closed = await run("close_tab", { tabId: id });
	if (closed.error) return closed.error;
	return fails(await run("read_tab", { tabId: id }), /is closed or does not exist; call list_tabs/);
});
await check("with no working tab, navigate uses a tab already on that site", async () => {
	const working = JSON.parse((await run("list_tabs")).text).find((t) => t.current);
	if (working) await run("close_tab", { tabId: working.tabId });
	const before = await tabCount();
	const r = await run("navigate", { url: "https://github.com/getsentry/warden/issues" });
	if ((await tabCount()) !== before) return `a tab was opened: ${r.error ?? r.text}`;
	return userTab.url().endsWith("/getsentry/warden/issues") || `the user's GitHub tab is at ${userTab.url()}`;
});
await check("repeating a click that leads to the same page is called out", async () => {
	const repo = await run("navigate", { url: "https://github.com/getsentry/warden" });
	const issues = ref(repo.text, /link "Issues 12" \[ref=(e\d+)\]/);
	await run("click", { ref: issues });
	await run("go_back");
	const again = await run("snapshot_tab");
	return has(await run("click", { ref: ref(again.text, /link "Issues 12" \[ref=(e\d+)\]/) }), /came out the same/);
});
await check("fetch_url reads a page without opening a tab", async () => {
	const before = await tabCount();
	const r = await run("fetch_url", { url: "https://shop.test/article/webgpu.html" });
	return ((await tabCount()) === before || "a tab was opened") && has(r, /Safari 26/);
});
await check("web_search returns results (needs the internet)", async () => has(await run("web_search", { query: "WebGPU browser support" }), /^1\. /));

// Tools that only use browser APIs.
await check("get_datetime", async () => has(await run("get_datetime"), /"timeZone"/));
await check("get_location", async () => has(await run("get_location"), /"latitude": 50\.07/));
await check("get_device_info", async () => has(await run("get_device_info"), /"cpuCores"/));
await check("get_storage_info", async () => has(await run("get_storage_info"), /"quotaGB"/));
await check("show_notification", async () => has(await run("show_notification", { title: "Eval", body: "hello" }), /Notification shown/));
await check("copy_to_clipboard", async () => {
	const r = await run("copy_to_clipboard", { text: "eval clipboard text" });
	if (r.error) return r.error;
	const pasted = await harness.evaluate(() => navigator.clipboard.readText());
	return pasted === "eval clipboard text" || `clipboard holds "${pasted}"`;
});

await browser.close();
await server.close();
const failed = results.filter((r) => !r.pass);
console.log(`\ntools: ${results.length - failed.length}/${results.length} passed`);
mkdirSync(`${here}results`, { recursive: true });
writeFileSync(`${here}results/tools.json`, JSON.stringify(results, null, 1));
process.exit(failed.length ? 1 : 0);
