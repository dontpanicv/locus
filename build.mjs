// Builds the static site in public/: the bundle, the license texts of every package bundled into it, and the
// extension as a zip for the onboarding to offer.
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { build } from "esbuild";

const { metafile } = await build({
	entryPoints: ["src/app.js"],
	bundle: true,
	format: "esm",
	platform: "browser",
	target: "es2022",
	sourcemap: true,
	outfile: "public/app.js",
	metafile: true,
});

// Packages that ship no license file, with the copyright line from upstream (earendil-works/pi's LICENSE) or from
// their source headers; their MIT text is the same as ours below the copyright line.
const NOTICES = { "@earendil-works/": "Copyright (c) 2025 Mario Zechner", "onnxruntime-": "Copyright (c) Microsoft Corporation. All rights reserved." };
const MIT_TERMS = readFileSync("LICENSE", "utf8").split(/^Copyright.*$/m)[1].trim();

// The package each bundled file came from: the last node_modules/<name> in its path.
const dirs = new Set();
for (const input of Object.keys(metafile.inputs)) {
	const m = /^(.*node_modules\/(?:@[^/]+\/)?[^/]+)\//.exec(input);
	if (m) dirs.add(m[1]);
}
const sections = [...dirs].sort().map((dir) => {
	const pkg = JSON.parse(readFileSync(`${dir}/package.json`, "utf8"));
	const files = readdirSync(dir).filter((f) => /^(licen[cs]e|notice|copying)/i.test(f));
	const texts = files.map((f) => readFileSync(`${dir}/${f}`, "utf8").trim());
	const license = typeof pkg.license === "string" ? pkg.license : pkg.license?.type;
	if (!texts.length) {
		const notice = Object.entries(NOTICES).find(([prefix]) => pkg.name.startsWith(prefix))?.[1];
		if (license !== "MIT" || !notice) throw new Error(`${pkg.name} ships no license file; add its notice to NOTICES`);
		texts.push(`MIT License\n\n${notice}\n\n${MIT_TERMS}`);
	}
	return [`${pkg.name} ${pkg.version} (${license ?? "see below"})`, pkg.homepage ?? pkg.repository?.url ?? "", "", texts.join("\n\n")].join("\n");
});
const rule = `\n\n${"=".repeat(78)}\n\n`;
writeFileSync(
	"public/licenses.txt",
	[
		`Local Agent\n\n${readFileSync("LICENSE", "utf8").trim()}`,
		"Qwen3.5-4B (Apache License 2.0)\nhttps://huggingface.co/Qwen/Qwen3.5-4B/blob/main/LICENSE\n\nNot part of this site: the browser downloads the model from Hugging Face (onnx-community/Qwen3.5-4B-ONNX-OPT,\nan ONNX conversion of Qwen/Qwen3.5-4B). The full text of the Apache License 2.0 is in the @huggingface/transformers\nsection below. ONNX Runtime's wasm files come from jsDelivr and are covered by the onnxruntime-web section.",
		`Packages bundled into app.js\n\n${sections.join(rule)}`,
	].join(rule) + "\n",
);

rmSync("public/local-agent-bridge.zip", { force: true });
execFileSync("zip", ["-q", "-r", "public/local-agent-bridge.zip", "extension", "-x", "*.DS_Store"]);
if (!existsSync("public/local-agent-bridge.zip")) throw new Error("zip did not write the extension");
console.log(`built public/: app.js, licenses.txt (${dirs.size} packages), local-agent-bridge.zip`);
