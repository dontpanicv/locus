// Tools built only on browser APIs. Read-only ones are replay-safe; ones with side effects are not,
// so pi reports "interrupted" instead of repeating them after a crash.
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

const ok = (value) => ({ output: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 1) }] });
const none = { type: "object", properties: {} };

const getDatetime = defineTool({
	name: "get_datetime",
	description: "Get the current local date, time, time zone and locale of the user.",
	parameters: none,
	replay: "safe",
	execute: async () => {
		const now = new Date();
		const { timeZone, locale } = Intl.DateTimeFormat().resolvedOptions();
		return ok({ local: now.toLocaleString(locale, { dateStyle: "full", timeStyle: "long" }), iso: now.toISOString(), timeZone, locale });
	},
});

const getLocation = defineTool({
	name: "get_location",
	description: "Get the user's current GPS location (latitude, longitude, accuracy in meters). Asks the user for permission.",
	parameters: none,
	replay: "safe",
	execute: async () => {
		const pos = await new Promise((resolve, reject) =>
			navigator.geolocation.getCurrentPosition(resolve, (e) => reject(new Error(e.message)), { timeout: 15000 }),
		);
		const { latitude, longitude, accuracy } = pos.coords;
		return ok({ latitude, longitude, accuracyMeters: Math.round(accuracy) });
	},
});

const deviceInfo = defineTool({
	name: "get_device_info",
	description: "Get information about the user's device and browser: OS, CPU cores, memory, screen, network, battery and GPU.",
	parameters: none,
	replay: "safe",
	execute: async () => {
		const ua = navigator.userAgentData ? await navigator.userAgentData.getHighEntropyValues(["platformVersion", "architecture", "model"]) : {};
		const battery = await navigator.getBattery?.().catch(() => undefined);
		const gpu = await navigator.gpu?.requestAdapter().catch(() => undefined);
		const c = navigator.connection;
		return ok({
			browser: ua.brands?.map((b) => `${b.brand} ${b.version}`).filter((b) => !b.includes("Not")).join(", ") ?? navigator.userAgent,
			platform: [ua.platform, ua.platformVersion, ua.architecture].filter(Boolean).join(" ") || navigator.platform,
			cpuCores: navigator.hardwareConcurrency,
			memoryGB: navigator.deviceMemory,
			languages: navigator.languages,
			screen: `${screen.width}x${screen.height} @${devicePixelRatio}x, ${screen.colorDepth}-bit`,
			online: navigator.onLine,
			network: c && { type: c.effectiveType, downlinkMbps: c.downlink, rttMs: c.rtt },
			battery: battery && { levelPercent: Math.round(battery.level * 100), charging: battery.charging },
			gpu: gpu?.info && { vendor: gpu.info.vendor, architecture: gpu.info.architecture },
		});
	},
});

const storageInfo = defineTool({
	name: "get_storage_info",
	description: "Get how much browser storage this app uses and has available, and whether it is persistent.",
	parameters: none,
	replay: "safe",
	execute: async () => {
		const { usage, quota } = await navigator.storage.estimate();
		const gb = (n) => +(n / 1e9).toFixed(2);
		return ok({ usedGB: gb(usage), quotaGB: gb(quota), persistent: await navigator.storage.persisted() });
	},
});

const notify = defineTool({
	name: "show_notification",
	description: "Show a desktop notification to the user. Asks for permission the first time.",
	parameters: {
		type: "object",
		properties: { title: { type: "string" }, body: { type: "string" } },
		required: ["title"],
	},
	execute: async ({ title, body }) => {
		if ((await Notification.requestPermission()) !== "granted") throw new Error("Notification permission was not granted");
		new Notification(String(title), { body: body ? String(body) : undefined });
		return ok("Notification shown.");
	},
});

const copy = defineTool({
	name: "copy_to_clipboard",
	description: "Copy a text to the user's clipboard.",
	parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
	execute: async ({ text }) => {
		try {
			await navigator.clipboard.writeText(String(text));
		} catch (error) {
			if (!document.hasFocus()) throw new Error("The clipboard only works while this chat's tab is in front, and the user is on another tab. Tell the user that, and give them the text in your answer instead.");
			throw error;
		}
		return ok("Copied to clipboard.");
	},
});

export const BrowserTools = defineExtension({
	name: "browser-tools",
	tools: [getDatetime, getLocation, deviceInfo, storageInfo, notify, copy],
});
