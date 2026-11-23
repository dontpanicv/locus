// Chrome's accessibility tree → an agent-browser style snapshot: one line per element in page order, refs on the
// ones you can act on, and the page's text between them, so the model sees what the page says and what it can do.
// A ref is "e" + Chrome's backend node id, so it needs no stored map and stays valid while the element exists.
const ACTIONABLE = new Set([
	"button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio", "switch", "slider",
	"spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
]);
// Site menus and footers: their links and buttons are listed, their text is left out.
const CHROME = new Set(["navigation", "banner", "contentinfo", "complementary"]);
// Roles that don't start a new block of text, so their text joins the line around them.
const INLINE = new Set(["generic", "none", "StaticText", "InlineTextBox", "LineBreak", "strong", "emphasis", "mark", "time", "code"]);
// shortcut: a fixed cut keeps a snapshot within a small model's context; add paging if pages need more.
const MAX_LINES = 150;
const TEXT_CHARS = 200;

const clip = (text, n) => {
	const t = String(text ?? "").replace(/\s+/g, " ").trim();
	return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * Backend node ids of elements styled as clickable (cursor: pointer) that aren't inside another such element,
 * from DOMSnapshot.captureSnapshot with computedStyles ["cursor"]. Catches rows and cards built from plain divs.
 */
export function clickableIds({ documents, strings }) {
	const ids = new Set();
	for (const doc of documents) {
		const cursor = new Map(doc.layout.nodeIndex.map((node, i) => [node, strings[doc.layout.styles[i][0]]]));
		for (const [node, value] of cursor) {
			if (value !== "pointer" || doc.nodes.nodeType[node] !== 1) continue;
			let parent = doc.nodes.parentIndex[node];
			while (parent >= 0 && !cursor.has(parent)) parent = doc.nodes.parentIndex[parent];
			if (cursor.get(parent) !== "pointer") ids.add(doc.nodes.backendNodeId[node]);
		}
	}
	return ids;
}

/** Nodes in page order with what their ancestors say about them. A <select>'s options are skipped; fill picks them. */
function* inPageOrder(nodes) {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const roots = nodes.filter((n) => !byId.has(n.parentId)).reverse();
	const stack = roots.map((node) => ({ node, quiet: false, block: node.nodeId }));
	const seen = new Set();
	while (stack.length) {
		const item = stack.pop();
		const n = item.node;
		if (seen.has(n.nodeId)) continue;
		seen.add(n.nodeId);
		yield item;
		const role = n.role?.value;
		if (role === "combobox") continue;
		// Text inside a named control is its name, already shown; text in menus and footers is noise.
		const quiet = item.quiet || ACTIONABLE.has(role) || role === "heading" || CHROME.has(role);
		// Inside a clickable element its text and headings are on its own line; set by the caller before it asks for more.
		const named = item.named || item.clickable;
		const block = INLINE.has(role) || n.ignored ? item.block : n.nodeId;
		for (const id of [...(n.childIds ?? [])].reverse()) {
			if (byId.has(id)) stack.push({ node: byId.get(id), quiet, named, block });
		}
	}
}

/** All the text under a node, for naming a clickable element that has no name of its own. */
function textUnder(node, byId) {
	const parts = [];
	const walk = (n) => {
		if (n.role?.value === "StaticText" && !n.ignored) parts.push(n.name?.value ?? "");
		for (const id of n.childIds ?? []) if (byId.has(id)) walk(byId.get(id));
	};
	walk(node);
	return parts.join(" ");
}

/**
 * The snapshot as lines. `clickable` holds backend ids from clickableIds: such elements get a ref even without
 * an accessible role, and their text is shown on their line instead of after it.
 */
export function snapshotLines(nodes, { clickable = new Set(), max = MAX_LINES } = {}) {
	const byId = new Map(nodes.map((n) => [n.nodeId, n]));
	const lines = [];
	let cut = 0;
	let textBlock; // the block the last text line came from, so inline pieces of one paragraph share a line
	const push = (line) => {
		if (lines.length >= max) return cut++;
		lines.push(line);
	};
	const items = inPageOrder(nodes);
	for (const item of items) {
		const n = item.node;
		const role = n.role?.value;
		if (n.ignored || !n.backendDOMNodeId) continue;
		if (role === "StaticText") {
			if (item.quiet || item.named) continue;
			const text = clip(n.name?.value, TEXT_CHARS);
			if (!text) continue;
			const last = lines.length - 1;
			if (textBlock === item.block && lines[last]?.startsWith("- text ") && lines[last].length + text.length < TEXT_CHARS + 12) {
				lines[last] = `${lines[last].slice(0, -1)} ${text}"`;
			} else {
				push(`- text "${text}"`);
				textBlock = item.block;
			}
			continue;
		}
		const actionable = ACTIONABLE.has(role);
		const isClickable = !actionable && role !== "heading" && clickable.has(n.backendDOMNodeId);
		if (isClickable) item.clickable = true; // read by inPageOrder when it queues this node's children
		if (!(actionable || isClickable || role === "heading")) continue;
		textBlock = undefined;
		const name = clip(n.name?.value || (isClickable ? textUnder(n, byId) : ""), isClickable ? 120 : 80);
		if (isClickable && !name) continue;
		if (role === "heading" && (!name || item.named)) continue;
		const props = Object.fromEntries((n.properties ?? []).map((p) => [p.name, p.value?.value]));
		const state = [
			n.value?.value && `value="${clip(n.value.value, 60)}"`,
			(props.checked === true || props.checked === "true") && "checked",
			(props.selected === true || props.selected === "true") && role === "tab" && "selected",
			props.expanded === true && "expanded",
			props.disabled === true && "disabled",
			role === "heading" && props.level && `level=${props.level}`,
		].filter(Boolean);
		const shown = isClickable ? "clickable" : role;
		push(`- ${shown}${name && ` "${name}"`}${state.map((s) => ` ${s}`).join("")}${actionable || isClickable ? ` [ref=e${n.backendDOMNodeId}]` : ""}`);
	}
	if (cut) lines.push(`[${cut} more lines cut; use read_tab for all of the page text]`);
	return lines.length ? lines : ["(the page shows no text or interactive elements)"];
}

export const formatSnapshot = (nodes, options) => snapshotLines(nodes, options).join("\n");

/**
 * What an action changed on the same page, or undefined when the page is a different one (then show it whole).
 * Small changes come back as the lines that appeared and went, so the model can tell a click that did something
 * from one that did nothing.
 */
export function changes(before, after, max = 40) {
	if (!before || before.url !== after.url) return undefined;
	const had = new Set(before.lines);
	const has = new Set(after.lines);
	const added = after.lines.filter((l) => !had.has(l));
	const gone = before.lines.filter((l) => !has.has(l));
	if (!added.length && !gone.length) return "Nothing on the page changed, so that probably had no effect.";
	if (added.length + gone.length > max) return undefined;
	return [
		`Same page; ${added.length} line${added.length === 1 ? "" : "s"} appeared and ${gone.length} went away. Other refs still work.`,
		...added.map((l) => `new: ${l.slice(2)}`),
		...gone.map((l) => `gone: ${l.slice(2)}`),
	].join("\n");
}

/** "e123" or "@e123" → 123. */
export function refId(ref) {
	const id = Number(/^@?e(\d+)$/.exec(String(ref).trim())?.[1]);
	if (!id) throw new Error(`Bad ref "${ref}"; use a ref from the latest snapshot, like e123`);
	return id;
}
