// The tool harness page: every tool the agent has, callable from the eval as run(name, args).
import { TabTools } from "../src/bridge-tools.js";
import { BrowserTools } from "../src/tools.js";

const tools = Object.fromEntries([...TabTools.tools, ...BrowserTools.tools].map((t) => [t.name, t]));
globalThis.run = async (name, args) => {
	try {
		return { text: (await tools[name].execute(args ?? {})).output[0].text };
	} catch (error) {
		return { error: error.message };
	}
};
