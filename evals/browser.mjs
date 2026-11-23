// Starts a throwaway Chrome profile with the bridge extension and the fake sites mapped in.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";
import { chromeArgs } from "./fixtures.mjs";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const EXTENSION = fileURLToPath(new URL("../extension", import.meta.url));

export async function launch() {
	const profile = mkdtempSync(join(tmpdir(), "local-agent-eval-"));
	const browser = await puppeteer.launch({
		executablePath: CHROME,
		headless: process.env.HEADFUL ? false : true,
		pipe: true, // needed to install an unpacked extension
		enableExtensions: true,
		protocolTimeout: 420_000, // longer than a scenario, since waiting for the agent is one call
		userDataDir: profile,
		args: [...chromeArgs, "--enable-unsafe-webgpu"],
	});
	await browser.installExtension(EXTENSION);
	const close = browser.close.bind(browser);
	browser.close = async () => {
		await close();
		rmSync(profile, { recursive: true, force: true });
	};
	return browser;
}
