// Tool-call format of Qwen3.5 and LFM3 (qwen3_coder style):
// <tool_call>\n<function=NAME>\n<parameter=KEY>\nVALUE\n</parameter>\n</function>\n</tool_call>

const TOOL_CALL = "<tool_call>";

/** Text the user may see while streaming: everything before the first tool call, minus thinking. */
export function visibleText(raw) {
	let text = raw.replace(/<think>[\s\S]*?(<\/think>|$)/g, "");
	// Even with thinking off, the model sometimes writes a draft and ends it with a bare "</think>".
	const close = text.lastIndexOf("</think>");
	if (close >= 0) text = text.slice(close + "</think>".length).trimStart();
	const at = text.indexOf(TOOL_CALL);
	if (at >= 0) return text.slice(0, at).trimEnd();
	// Hold back a trailing "<", "<to", ... that may still become "<tool_call>".
	for (let n = Math.min(TOOL_CALL.length - 1, text.length); n > 0; n--) {
		if (TOOL_CALL.startsWith(text.slice(-n))) return text.slice(0, -n);
	}
	return text;
}

/** A parameter value is JSON when it parses (numbers, booleans, objects); otherwise the raw string. */
function parseValue(value) {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** Every complete or truncated tool call in the model's raw output. */
export function parseToolCalls(raw) {
	const calls = [];
	const fn = /<function=([^>\s]+)>([\s\S]*?)(?:<\/function>|$)/g;
	for (const [, name, body] of raw.matchAll(fn)) {
		const args = {};
		for (const [, key, value] of body.matchAll(/<parameter=([^>\s]+)>\n?([\s\S]*?)\n?<\/parameter>/g)) {
			args[key] = parseValue(value);
		}
		calls.push({ name, arguments: args });
	}
	return calls;
}

// An answer that hands the work back: "please click on Notifications", "you would need to: 1. Navigate to ...".
const HANDS_BACK = /\b(please|you (?:can|could|should|need to|would need to|will need to|may want to|might want to|have to))\b(?:[^.?!]|\d\.){0,30}?\b(click|tap|open|go to|navigate|visit|scroll|select|press|log ?in|sign ?in)\b/i;

/** Whether a final answer tells the user to do steps in the browser, which the agent could do itself. */
export const handsBack = (text) => HANDS_BACK.test(text.replace(/[*_`#]/g, ""));
