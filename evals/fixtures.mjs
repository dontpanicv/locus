// Local copies of the kinds of sites the agent was tried on, for repeatable evals. Chrome is started with
// host-resolver rules that send www.linkedin.com, github.com and shop.test here, so the agent uses real URLs
// but never reaches the real sites. Each fake is built like the real thing where that tripped the agent up:
// rows that are plain clickable divs, checkboxes drawn by their labels, content that a script fetches and draws
// after "load", and a dialog that covers the page.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";

export const HOSTS = ["www.linkedin.com", "linkedin.com", "github.com", "shop.test"];
export const HTTPS_PORT = 8443;
export const HTTP_PORT = 8790; // the tool harness page, which must be on 127.0.0.1 to reach the extension
const here = fileURLToPath(new URL(".", import.meta.url));

const CONVERSATIONS = [
	{
		id: "c1", name: "Ada Novak", slug: "ada-novak", time: "9:41 AM", messages: [
			{ from: "Ada Novak", text: "Hi! Are we still on for the demo on Thursday at 10?" },
			{ from: "You", text: "Yes, Thursday at 10 works for me." },
			{ from: "Ada Novak", text: "Great, I will bring the pricing questions from our CFO." },
		],
	},
	{
		id: "c2", name: "Tomas Berg", slug: "tomas-berg", time: "Yesterday", messages: [
			{ from: "Tomas Berg", text: "Thanks for the intro to the data team, I sent them the proposal this morning." },
		],
	},
	{
		id: "c3", name: "Lena Fischer", slug: "lena-fischer", time: "Mon", messages: [
			{ from: "Lena Fischer", text: "Could you review the onboarding doc by Friday?" },
			{ from: "You", text: "Sure, I will send comments on Thursday." },
		],
	},
];
const INVITATIONS = [
	{ id: "i1", name: "Jan Dvorak", headline: "Data engineer at Northwind" },
	{ id: "i2", name: "Maria Rossi", headline: "Product manager at Contoso" },
	{ id: "i3", name: "Kenji Sato", headline: "Founder of Tiny Robots" },
];
const PRODUCTS = [
	{ name: "Arc floor lamp", price: 129 }, { name: "Mini desk lamp", price: 24 }, { name: "Paper lamp shade", price: 39 },
	{ name: "Oak desk", price: 349 }, { name: "Wool rug", price: 199 }, { name: "Reading lamp", price: 59 },
];

/** What the agent did on the sites, for the evals to check. */
export const state = {};
export function reset() {
	Object.assign(state, {
		conversations: structuredClone(CONVERSATIONS),
		invitations: Object.fromEntries(INVITATIONS.map((i) => [i.id, "pending"])),
		connected: [], // "Connect" on people you may know: the agent shouldn't press it when asked to accept
		selected: [],
	});
}
reset();

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (title, body, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font:15px system-ui;margin:0}header{display:flex;gap:16px;padding:8px 16px;background:#eee}main{padding:16px}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}</style></head><body>${body}<script>${script}</script></body></html>`;

// ---- www.linkedin.com ----
const liHeader = `<header role="banner"><a href="/feed/">LinkedIn</a><input aria-label="Search" role="combobox">
<nav><a href="/feed/">Home</a> <a href="/mynetwork/">My Network</a> <a href="/jobs/">Jobs</a> <a href="/messaging/">Messaging</a>
<a href="/notifications/" aria-label="Notifications, 3 new notifications">Notifications <b>3</b></a></nav><h2 class="vh">0 notifications total</h2><button>Me</button></header>`;

const messagingScript = `
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
let list = [];
async function load(id) {
	await new Promise((r) => setTimeout(r, 500)); // the app fetches and draws well after "load", like the real one
	list = await (await fetch("/api/conversations")).json();
	id ??= location.pathname.split("/")[3] || list[0].id;
	history.replaceState(null, "", "/messaging/thread/" + id + "/");
	render(id);
}
function render(id) {
	const c = list.find((c) => c.id === id);
	document.title = "(" + list.length + ") Messaging | LinkedIn";
	$("#list").innerHTML = list.map((x) => '<li class="row" style="display:flex;gap:8px;align-items:center;position:relative">' +
		'<div style="position:relative;width:20px;height:20px"><input type="checkbox" id="s' + x.id + '" style="position:absolute;inset:0;margin:0" onchange="fetch(\\'/api/select/' + x.id + '\\',{method:\\'POST\\'})">' +
		'<label for="s' + x.id + '" style="position:absolute;inset:0;background:#fff;border:1px solid #888"><span class="vh">Select conversation with ' + esc(x.name) + '</span></label></div>' +
		'<div class="open" style="cursor:pointer;flex:1" onclick="openThread(\\'' + x.id + '\\')"><h3 style="margin:0">' + esc(x.name) + '</h3>' +
		'<p style="margin:0">' + esc(x.messages.at(-1).from.split(" ")[0]) + ': ' + esc(x.messages.at(-1).text.slice(0, 40)) + '…</p><time>' + x.time + '</time></div>' +
		'<button aria-label="Open the options list in your conversation with ' + esc(x.name) + '" onclick="this.nextElementSibling.hidden=!this.nextElementSibling.hidden;this.setAttribute(\\'aria-expanded\\',!this.nextElementSibling.hidden)">⋯</button>' +
		'<div hidden role="menu"><button role="menuitem">Star</button><button role="menuitem">Mute</button><button role="menuitem">Mark as unread</button></div></li>').join("");
	$("#thread").innerHTML = '<h2>' + esc(c.name) + '</h2><a href="/in/' + c.slug + '/">View ' + esc(c.name) + '\\'s profile</a>' +
		'<ul>' + c.messages.map((m) => '<li><span>' + esc(m.from) + '</span><p>' + esc(m.text) + '</p></li>').join("") + '</ul>' +
		'<div contenteditable="true" role="textbox" aria-label="Write a message" style="border:1px solid #888;min-height:40px" onkeydown="if (event.key === \\'Enter\\' && !event.shiftKey) { event.preventDefault(); send(\\'' + c.id + '\\'); }"></div>' +
		'<button onclick="send(\\'' + c.id + '\\')">Send</button>';
}
async function openThread(id) {
	history.pushState(null, "", "/messaging/thread/" + id + "/");
	$("#thread").innerHTML = "<p>Loading…</p>";
	await new Promise((r) => setTimeout(r, 300));
	render(id);
}
async function send(id) {
	const box = $("[aria-label='Write a message']");
	const text = box.innerText.trim();
	if (!text) return;
	await fetch("/api/send/" + id, { method: "POST", body: text });
	list = await (await fetch("/api/conversations")).json();
	render(id);
}
addEventListener("popstate", () => render(location.pathname.split("/")[3]));
load();`;

const invitationsScript = `
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => "&#" + c.charCodeAt(0) + ";");
async function load() {
	await new Promise((r) => setTimeout(r, 500));
	const list = await (await fetch("/api/invitations")).json();
	document.querySelector("#inv").innerHTML = list.map((i) => i.status === "pending"
		? '<li><h3>' + esc(i.name) + '</h3><p>' + esc(i.headline) + '</p><button aria-label="Ignore an invitation from ' + esc(i.name) + '" onclick="answer(\\'' + i.id + '\\',\\'ignore\\')">Ignore</button>' +
		  ' <button aria-label="Accept ' + esc(i.name) + '\\'s invitation" onclick="answer(\\'' + i.id + '\\',\\'accept\\')">Accept</button></li>'
		: '<li><p>' + esc(i.name) + (i.status === "accepted" ? " is now a connection." : " was ignored.") + '</p></li>').join("");
	document.querySelector("#count").textContent = "Invitations (" + list.filter((i) => i.status === "pending").length + ")";
	// An upsell dialog covers the page a moment later, as real sites do.
	setTimeout(() => { if (!sessionStorage.dismissed) document.querySelector("#upsell").hidden = false; }, 700);
}
async function answer(id, how) {
	await fetch("/api/invitations/" + id + "/" + how, { method: "POST" });
	load();
}
load();`;

const linkedin = {
	"/": () => page("Feed | LinkedIn", `${liHeader}<main><h1 class="vh">Feed</h1><p>Start a post</p><article><h3>Northwind</h3><p>We are hiring data engineers in Prague.</p></article></main>`),
	"/feed/": () => linkedin["/"](),
	"/messaging/": () => page("Messaging | LinkedIn", `${liHeader}<main style="display:flex;gap:24px"><section style="width:40%"><h1>Messaging</h1>
<input type="search" aria-label="Search messages"><button>Unread</button><button>InMail</button><h2 class="vh">Conversation List</h2><ul id="list"></ul></section>
<section id="thread" style="flex:1"></section></main>`, messagingScript),
	"/mynetwork/": () => page("My Network | LinkedIn", `${liHeader}<main><h1>Manage my network</h1><p>Invitations (${Object.values(state.invitations).filter((s) => s === "pending").length})</p>
<a href="/mynetwork/invitation-manager/">Show all invitations</a><h2>People you may know</h2>
${["Petra Kral", "Omar Haddad"].map((n) => `<div><h3>${n}</h3><button aria-label="Invite ${n} to connect" onclick="fetch('/api/connect/${encodeURIComponent(n)}',{method:'POST'}).then(()=>this.textContent='Pending')">Connect</button></div>`).join("")}</main>`),
	"/mynetwork/invitation-manager/": () => page("Invitations | LinkedIn", `${liHeader}<main><h1 id="count">Invitations</h1><ul id="inv"></ul></main>
<div id="upsell" hidden role="dialog" aria-label="Try Premium" style="position:fixed;inset:0;background:rgba(0,0,0,.5);display:grid;place-items:center">
<div style="background:#fff;padding:24px"><h2>Try Premium for free</h2><p>See who viewed your profile.</p><button>Start free trial</button>
<button aria-label="Dismiss" onclick="sessionStorage.dismissed=1;document.querySelector('#upsell').hidden=true">✕</button></div></div>
<style>#upsell[hidden]{display:none!important}</style>`, invitationsScript),
	// Lures for "messages": the real feed shows new notifications and none for Messaging.
	"/notifications/": () => page("Notifications | LinkedIn", `${liHeader}<main><h1>Notifications</h1><p>Kenji Sato viewed your profile.</p>
<p>Petra Kral posted: Five lessons from our first year of selling data tools.</p><p>Jan Dvorak and 2 others invited you to connect.</p>
<a href="/mynetwork/invitation-manager/">See all invitations</a></main>`),
	"/jobs/": () => page("Jobs | LinkedIn", `${liHeader}<main><h1>Jobs</h1><p>Top job picks for you</p><a href="#">Data engineer at Northwind</a></main>`),
	"/in/": (path) => {
		const c = CONVERSATIONS.find((c) => path.startsWith(`/in/${c.slug}`));
		return c && page(`${c.name} | LinkedIn`, `${liHeader}<main><h1>${c.name}</h1><p>500+ connections</p><a href="/messaging/thread/${c.id}/">Message</a><button>More</button></main>`);
	},
	"/messaging/thread/": () => linkedin["/messaging/"](),
};

// ---- github.com ----
const repoNav = (active) => `<header role="banner"><a href="/">GitHub</a><input aria-label="Search or jump to…"></header>
<main><h1><a href="/getsentry">getsentry</a> / <a href="/getsentry/warden">warden</a></h1><nav aria-label="Repository">
${[["Code", ""], ["Issues 12", "/issues"], ["Pull requests 3", "/pulls"], ["Actions", "/actions"], ["Security", "/security"]]
	.map(([t, p]) => `<a href="/getsentry/warden${p}"${t.startsWith(active) ? ' aria-current="page"' : ""}>${t}</a>`).join(" ")}</nav>`;
const github = {
	"/getsentry/warden": () => page("GitHub - getsentry/warden: Agents that review your code.", `${repoNav("Code")}<h2>README</h2>
<p>Warden runs agents that review your code on every pull request.</p><p>Install it with npx warden init.</p></main>`),
	"/getsentry/warden/actions": () => page("All Workflow Runs · getsentry/warden · GitHub", `${repoNav("Actions")}<h2>All workflows</h2>
<ul><li><a href="#">CI #412</a> <span>main · passed · 3 minutes ago</span></li><li><a href="#">Release #77</a> <span>v0.9.1 · failed · yesterday</span></li></ul></main>`),
	"/getsentry/warden/issues": () => page("Issues · getsentry/warden · GitHub", `${repoNav("Issues")}<h2>12 open issues</h2><ul><li><a href="#">Reviews time out on large diffs</a></li><li><a href="#">Support GitLab</a></li></ul></main>`),
	"/getsentry/warden/pulls": () => page("Pull requests · getsentry/warden · GitHub", `${repoNav("Pull")}<h2>3 open pull requests</h2></main>`),
};

// ---- shop.test ----
const shop = {
	"/article/webgpu.html": () => page("WebGPU arrives everywhere | Shop Journal", `<header role="banner"><a href="/">Shop Journal</a></header><main><article><h1>WebGPU arrives everywhere</h1>
<p>Chrome shipped WebGPU in version 113 in 2023. Firefox followed on Windows in version 141.</p>
<p>Safari enabled WebGPU by default in Safari 26, so every major browser now supports it.</p>
<p>The fastest demo in our tests ran a 4 billion parameter model at 30 tokens per second.</p></article></main>`),
	"/article/lamps.html": () => page("How to light a desk | Shop Journal", `<main><article><h1>How to light a desk</h1><p>Put the lamp on the side opposite your writing hand.</p><p>Warm light of 2700 K is best in the evening.</p></article></main>`),
	"/article/rugs.html": () => page("Choosing a rug | Shop Journal", `<main><article><h1>Choosing a rug</h1><p>Wool rugs last about twenty years.</p><p>Leave 45 cm of floor around the rug.</p></article></main>`),
	"/form.html": () => page("Test form", `<main><h1>Test form</h1><label>Name <input id="name" value="old"></label>
<label>Color <select id="color"><option>Red</option><option>Blue</option></select></label>
<form onsubmit="event.preventDefault(); out.textContent = 'submitted ' + q.value + ' ' + document.getElementById('name').value + ' ' + document.getElementById('color').value">
<input id="q" aria-label="Query"></form>
<button onclick="out.textContent = 'clicked trusted=' + event.isTrusted + ' name=' + document.getElementById('name').value + ' color=' + document.getElementById('color').value">Press me</button>
<div style="position:relative;display:inline-block"><button onclick="out.textContent='covered clicked'">Covered</button><div style="position:absolute;inset:0;background:rgba(0,0,0,.3)">overlay</div></div>
<button onclick="void 0">Does nothing</button><p id="out"></p><div style="height:3000px"></div><button onclick="out.textContent = 'far clicked'">Far away</button></main>`),
	"/list.html": () => page("All items | Shop", `<main><h1>All items</h1><ul id="items"></ul><p id="more">Scroll for more</p></main>`, `
let n = 0;
const more = () => { if (n >= 60) return; const ul = document.getElementById("items");
	for (const end = n + 20; n < end;) { n++; ul.insertAdjacentHTML("beforeend", "<li style='height:40px'>Item " + n + " costs $" + (n * 3 + 7) + "</li>"); } };
more();
addEventListener("scroll", () => { if (innerHeight + scrollY > document.body.scrollHeight - 200) more(); });`),
	"/products.html": () => page("Products | Shop", `<main><h1>Products</h1><form onsubmit="event.preventDefault();search()"><input type="search" aria-label="Search products" id="q"></form><ul id="results"></ul></main>`, `
const all = ${JSON.stringify(PRODUCTS)};
async function search() { const q = document.getElementById("q").value.toLowerCase(); document.getElementById("results").innerHTML = "<li>Searching…</li>";
	await new Promise((r) => setTimeout(r, 400));
	document.getElementById("results").innerHTML = all.filter((p) => p.name.toLowerCase().includes(q)).map((p) => "<li>" + p.name + " — $" + p.price + "</li>").join("") || "<li>No results</li>"; }`),
};

const sites = { "www.linkedin.com": linkedin, "linkedin.com": linkedin, "github.com": github, "shop.test": shop };

function route(host, path) {
	const site = sites[host];
	if (!site) return undefined;
	if (site[path]) return site[path](path);
	// Longest prefix with a trailing slash, for /in/<name>/ and /messaging/thread/<id>/.
	const prefix = Object.keys(site).filter((p) => p.endsWith("/") && p !== "/" && path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
	return prefix && site[prefix](path);
}

async function api(req, res, path) {
	const body = await new Promise((r) => { let s = ""; req.on("data", (c) => (s += c)); req.on("end", () => r(s)); });
	const json = (v) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(v));
	if (path === "/api/conversations") return json(state.conversations);
	if (path === "/api/invitations") return json(INVITATIONS.map((i) => ({ ...i, status: state.invitations[i.id] })));
	let m;
	if ((m = /^\/api\/invitations\/(\w+)\/(accept|ignore)$/.exec(path))) {
		state.invitations[m[1]] = m[2] === "accept" ? "accepted" : "ignored";
		return json({ ok: true });
	}
	if ((m = /^\/api\/send\/(\w+)$/.exec(path))) {
		state.conversations.find((c) => c.id === m[1])?.messages.push({ from: "You", text: body });
		return json({ ok: true });
	}
	if ((m = /^\/api\/connect\/(.+)$/.exec(path))) return json(state.connected.push(decodeURIComponent(m[1])));
	if ((m = /^\/api\/select\/(\w+)$/.exec(path))) return json(state.selected.push(m[1]));
	res.writeHead(404).end();
}

function handler(extra = {}) {
	return (req, res) => {
		const url = new URL(req.url, "http://x");
		const host = (req.headers.host ?? "").replace(/:\d+$/, "");
		if (url.pathname.startsWith("/api/")) return api(req, res, url.pathname);
		const file = extra[url.pathname];
		// Like the real sites, a path without its trailing slash redirects to the one with it.
		if (!file && !route(host, url.pathname) && route(host, `${url.pathname}/`)) return res.writeHead(301, { location: `${url.pathname}/` }).end();
		const html = file ? readFileSync(file, "utf8") : route(host, url.pathname);
		if (!html) return res.writeHead(404, { "content-type": "text/html" }).end("<title>Page not found</title><h1>Page not found</h1>");
		res.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
	};
}

/** A throwaway self-signed certificate; Chrome runs with --ignore-certificate-errors, so it only needs to exist. */
function certificate() {
	const dir = `${here}.cert`;
	if (!existsSync(`${dir}/cert.pem`)) {
		mkdirSync(dir, { recursive: true });
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${dir}/key.pem`, "-out", `${dir}/cert.pem`, "-days", "365", "-subj", "/CN=eval fixtures"], { stdio: "ignore" });
	}
	return { key: readFileSync(`${dir}/key.pem`), cert: readFileSync(`${dir}/cert.pem`) };
}

/** Starts the fake sites; `files` maps extra paths on the HTTP server (the tool harness) to files on disk. */
export async function start(files = {}) {
	const secure = https.createServer(certificate(), handler());
	const plain = http.createServer(handler(files));
	await Promise.all([
		new Promise((r) => secure.listen(HTTPS_PORT, "127.0.0.1", r)),
		new Promise((r) => plain.listen(HTTP_PORT, "127.0.0.1", r)),
	]);
	return { close: () => Promise.all([secure, plain].map((s) => new Promise((r) => s.close(r)))) };
}

/** Chrome flags that send the fake hosts to this server. */
export const chromeArgs = [
	`--host-resolver-rules=${HOSTS.map((h) => `MAP ${h} 127.0.0.1:${HTTPS_PORT}`).join(", ")}`,
	"--ignore-certificate-errors",
];
