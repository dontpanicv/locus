// Static server for local development and the evals: the built site, plus the model files from models/ when they're
// there, so the page doesn't download them from Hugging Face. Usage: node server.mjs [port]
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import { extname, join, normalize, sep } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL(".", import.meta.url));
const roots = [
	["/models/", join(here, "models")],
	["/", join(here, "public")],
];
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".map": "application/json", ".json": "application/json", ".txt": "text/plain; charset=utf-8", ".zip": "application/zip" };
const port = Number(process.argv[2] ?? 8787);

http
	.createServer((req, res) => {
		const path = decodeURIComponent(new URL(req.url, "http://x").pathname);
		const [prefix, dir] = roots.find(([p]) => path.startsWith(p));
		const file = normalize(join(dir, path.slice(prefix.length) || "index.html"));
		let size;
		try {
			if (!file.startsWith(dir + sep)) throw new Error("outside root"); // no ../ escapes
			const stat = statSync(file);
			if (!stat.isFile()) throw new Error("not a file");
			size = stat.size;
		} catch {
			res.writeHead(404).end("Not found");
			return;
		}
		res.writeHead(200, {
			"content-type": types[extname(file)] ?? "application/octet-stream",
			"content-length": size,
			"cache-control": "no-cache",
		});
		if (req.method === "HEAD") return res.end();
		createReadStream(file).pipe(res);
	})
	.listen(port, "127.0.0.1", () => console.log(`Local agent on http://localhost:${port}/`));
