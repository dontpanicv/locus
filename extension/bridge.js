// Bridge between the Local Agent page and Chrome. Only pages listed in manifest "externally_connectable"
// can send messages here, and only the commands below run. The agent itself stays in the page.
const MAX_BODY = 2_000_000; // characters; the page trims further for the model

function webUrl(url) {
	const u = new URL(String(url));
	if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("Only http and https URLs are allowed");
	return u.href;
}

function tabInfo(t) {
	return { tabId: t.id, title: t.title, url: t.url, active: t.active, windowId: t.windowId };
}

function waitForLoad(tabId, ms = 20_000) {
	return new Promise((resolve) => {
		const done = () => {
			chrome.tabs.onUpdated.removeListener(onUpdated);
			clearTimeout(timer);
			resolve();
		};
		const onUpdated = (id, change) => id === tabId && change.status === "complete" && done();
		const timer = setTimeout(done, ms); // slow pages still return what has loaded so far
		chrome.tabs.onUpdated.addListener(onUpdated);
		chrome.tabs.get(tabId).then((t) => t.status === "complete" && done(), done);
	});
}

// The DevTools protocol, for agent-browser style control: Chrome shows a "debugging this browser" bar while attached.
const IDLE_DETACH_MS = 60_000;
const attached = new Map(); // tabId → idle detach timer
chrome.debugger.onDetach.addListener(({ tabId }) => {
	clearTimeout(attached.get(tabId));
	attached.delete(tabId);
});
async function debuggee(tabId) {
	const target = { tabId: Number(tabId) };
	if (!attached.has(target.tabId)) {
		try {
			await chrome.debugger.attach(target, "1.3");
		} catch (error) {
			// After a service worker restart the tab can still be attached to us; sendCommand tells if it isn't.
			if (!/already attached/i.test(error?.message)) throw error;
		}
	}
	clearTimeout(attached.get(target.tabId));
	attached.set(target.tabId, setTimeout(() => chrome.debugger.detach(target).catch(() => {}), IDLE_DETACH_MS));
	return target;
}

const commands = {
	ping: async () => ({ version: chrome.runtime.getManifest().version }),
	list_tabs: async () => (await chrome.tabs.query({})).map(tabInfo),
	open_tab: async ({ url, active = false }) => {
		const tab = await chrome.tabs.create({ url: webUrl(url), active: Boolean(active) });
		await waitForLoad(tab.id);
		return tabInfo(await chrome.tabs.get(tab.id));
	},
	close_tab: async ({ tabId }) => {
		await chrome.tabs.remove(Number(tabId));
		return { closed: Number(tabId) };
	},
	read_tab: async ({ tabId }) => {
		const [frame] = await chrome.scripting.executeScript({
			target: { tabId: Number(tabId) },
			func: () => ({ title: document.title, url: location.href, text: document.body?.innerText ?? "" }),
		});
		return frame.result;
	},
	cdp: async ({ tabId, method, params }) => chrome.debugger.sendCommand(await debuggee(tabId), String(method), params ?? {}),
	// Runs here, not in the page, so other sites' responses are readable. No cookies are sent.
	fetch: async ({ url }) => {
		const res = await fetch(webUrl(url), { credentials: "omit", redirect: "follow" });
		const body = (await res.text()).slice(0, MAX_BODY);
		return { status: res.status, url: res.url, contentType: res.headers.get("content-type"), body };
	},
};

chrome.runtime.onMessageExternal.addListener((msg, _sender, reply) => {
	const run = Object.hasOwn(commands, msg?.command) && commands[msg.command];
	if (!run) {
		reply({ error: `Unknown command: ${msg?.command}` });
		return false;
	}
	run(msg.args ?? {}).then(
		(result) => reply({ result }),
		(error) => reply({ error: error?.message ?? String(error) }),
	);
	return true; // keeps the channel open for the async reply
});
