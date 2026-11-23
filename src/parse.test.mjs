// node src/parse.test.mjs
import assert from "node:assert/strict";
import { handsBack, parseToolCalls, visibleText } from "./parse.js";
import { changes, clickableIds, formatSnapshot, refId } from "./snapshot.js";

const one = "<tool_call>\n<function=web_search>\n<parameter=query>\n2026 Tour de France winner\n</parameter>\n</function>\n</tool_call>";
assert.deepEqual(parseToolCalls(one), [{ name: "web_search", arguments: { query: "2026 Tour de France winner" } }]);

const two = `Sure.<tool_call>\n<function=speak>\n<parameter=text>\nhi\n</parameter>\n<parameter=rate>\n1.5\n</parameter>\n</function>\n</tool_call>\n\n<tool_call>\n<function=get_datetime>\n</function>\n</tool_call>`;
assert.deepEqual(parseToolCalls(two), [
	{ name: "speak", arguments: { text: "hi", rate: 1.5 } },
	{ name: "get_datetime", arguments: {} },
]);
assert.equal(visibleText(two), "Sure.");

// Truncated output still yields the call it started.
assert.deepEqual(parseToolCalls("<tool_call>\n<function=notify>\n<parameter=title>\nx\n</parameter>\n"), [
	{ name: "notify", arguments: { title: "x" } },
]);
assert.equal(visibleText("Hello <to"), "Hello ");
assert.equal(visibleText("<think>plan</think>Answer"), "Answer");
assert.equal(visibleText("Draft answer.</think>Final answer."), "Final answer.");
assert.deepEqual(parseToolCalls("No tools here."), []);
// Listed out of page order, as Chrome does; the combobox's option must not show.
const ax = [
	{ nodeId: "6", parentId: "1", role: { value: "link" }, name: { value: "Help" }, backendDOMNodeId: 6 },
	{ nodeId: "1", childIds: ["2", "3", "4", "5", "7", "6"], role: { value: "RootWebArea" }, name: { value: "Shop" }, backendDOMNodeId: 1 },
	{ nodeId: "2", parentId: "1", role: { value: "heading" }, name: { value: "Sign  in" }, properties: [{ name: "level", value: { value: 1 } }], backendDOMNodeId: 2 },
	{ nodeId: "3", parentId: "1", role: { value: "textbox" }, name: { value: "Email" }, value: { value: "a@b.c" }, backendDOMNodeId: 3 },
	{ nodeId: "4", parentId: "1", role: { value: "checkbox" }, name: { value: "Remember" }, properties: [{ name: "checked", value: { value: "true" } }], backendDOMNodeId: 4 },
	{ nodeId: "5", parentId: "1", role: { value: "button" }, name: { value: "Go" }, ignored: true, backendDOMNodeId: 5 },
	{ nodeId: "7", parentId: "1", childIds: ["8"], role: { value: "combobox" }, name: { value: "Size" }, value: { value: "M" }, backendDOMNodeId: 7 },
	{ nodeId: "8", parentId: "7", role: { value: "option" }, name: { value: "M" }, backendDOMNodeId: 8 },
];
assert.equal(
	formatSnapshot(ax),
	'- heading "Sign in" level=1\n- textbox "Email" value="a@b.c" [ref=e3]\n- checkbox "Remember" checked [ref=e4]\n- combobox "Size" value="M" [ref=e7]\n- link "Help" [ref=e6]',
);
assert.equal(formatSnapshot(ax, { max: 2 }).split("\n").at(-1), "[3 more lines cut; use read_tab for all of the page text]");

// Page text: inline pieces of a paragraph share a line, menu text and text inside controls are left out, and a
// clickable div (a conversation row) gets a ref named by its text, with its own controls still listed.
const N = (id, parent, role, name, extra) => ({ nodeId: String(id), parentId: parent && String(parent), role: { value: role }, name: { value: name }, backendDOMNodeId: id, ...extra });
const page = [
	N(1, 0, "RootWebArea", "x", { childIds: ["2", "3", "10", "15"] }),
	N(2, 1, "navigation", "", { childIds: ["4", "5"] }), N(4, 2, "link", "Home", { childIds: ["6"] }), N(6, 4, "StaticText", "Home"), N(5, 2, "StaticText", "menu"),
	N(3, 1, "paragraph", "", { childIds: ["7", "8"] }), N(7, 3, "StaticText", "Hello "), N(8, 3, "generic", "", { childIds: ["9"] }), N(9, 8, "StaticText", "world"),
	N(10, 1, "generic", "", { childIds: ["11", "12", "13"] }), N(11, 10, "heading", "Ada", { childIds: ["14"] }), N(14, 11, "StaticText", "Ada"),
	N(12, 10, "StaticText", "See you Thursday"), N(13, 10, "button", "Options"),
	N(15, 1, "paragraph", "", { childIds: ["16"] }), N(16, 15, "StaticText", "Second paragraph"),
];
const lines = formatSnapshot(page, { clickable: new Set([10]) });
assert.equal(lines, '- link "Home" [ref=e4]\n- text "Hello world"\n- clickable "Ada See you Thursday" [ref=e10]\n- button "Options" [ref=e13]\n- text "Second paragraph"');

// Only the outermost element with cursor: pointer counts; text nodes (type 3) never do.
const dom = {
	strings: ["auto", "pointer"],
	documents: [{ nodes: { parentIndex: [-1, 0, 1, 2], nodeType: [9, 1, 1, 3], backendNodeId: [1, 2, 3, 4] }, layout: { nodeIndex: [1, 2, 3], styles: [[0], [1], [1]] } }],
};
assert.deepEqual([...clickableIds(dom)], [3]);
dom.documents[0].layout.styles[0] = [1];
assert.deepEqual([...clickableIds(dom)], [2]);

// What an action changed: nothing, a few lines, or a different page (undefined: show it whole).
const before = { url: "u", lines: ['- button "Open" [ref=e1]', '- text "a"'] };
assert.equal(changes(before, { url: "u", lines: [...before.lines] }), "Nothing on the page changed, so that probably had no effect.");
assert.equal(
	changes(before, { url: "u", lines: ['- button "Open" expanded [ref=e1]', '- text "a"', '- menuitem "Star" [ref=e2]'] }),
	'Same page; 2 lines appeared and 1 went away. Other refs still work.\nnew: button "Open" expanded [ref=e1]\nnew: menuitem "Star" [ref=e2]\ngone: button "Open" [ref=e1]',
);
assert.equal(changes(before, { url: "v", lines: [] }), undefined);
assert.equal(changes(undefined, before), undefined);
assert.equal(refId("@e42"), 42);
assert.throws(() => refId("button"), /Bad ref/);
// Answers that hand the work back to the user, and ones that don't.
assert.ok(handsBack('To see the last 3 messages, please **click on "Notifications"** so the panel opens.'));
assert.ok(handsBack("To read your last couple of messages on LinkedIn, you would need to:\n\n1. Navigate to the LinkedIn website"));
assert.ok(handsBack("You can open the Messaging tab to read them."));
for (const done of ["Here are your last 3 messages: Ada asked about the demo.", "Item 45 costs $142.", "The task is complete. I clicked the Press me button.", "I opened the page in a new tab."]) {
	assert.ok(!handsBack(done), done);
}
console.log("parse: ok");
