import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultBackend, loadConfig, parseEnvFile } from "../src/config.ts";
import { ExaClient, parseRpcBody, postIpv4 } from "../src/exa.ts";
import { formatResults, searxngSearch } from "../src/searxng.ts";

const signal = new AbortController().signal;

describe("SearXNG", () => {
	let server: ReturnType<typeof Bun.serve>;
	let lastUrl: URL | undefined;
	let lastAuth: string | null = null;
	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch(req) {
				lastUrl = new URL(req.url);
				lastAuth = req.headers.get("authorization");
				if (lastUrl.searchParams.get("q") === "blocked") return new Response("no", { status: 403 });
				return Response.json({
					unresponsive_engines: lastUrl.searchParams.get("q") === "captcha" ? [["duckduckgo", "CAPTCHA"]] : [],
					results: [
						{ title: "One", url: "https://one.example/", content: "first" },
						{ title: "Two", url: "https://two.example/", content: "" },
						{ title: "Three", url: "https://three.example/", content: "third" },
					],
				});
			},
		});
	});
	afterAll(() => server.stop());

	test("asks for JSON and maps the results", async () => {
		const answer = await searxngSearch(`http://localhost:${server.port}/sx`, "a b", 2, signal);
		const results = answer.results;
		expect(lastAuth).toBeNull();
		expect(lastUrl?.pathname).toBe("/sx/search");
		expect(lastUrl?.searchParams.get("format")).toBe("json");
		expect(lastUrl?.searchParams.get("q")).toBe("a b");
		expect(results).toEqual([
			{ title: "One", url: "https://one.example/", snippet: "first" },
			{ title: "Two", url: "https://two.example/", snippet: "" },
		]);
		expect(formatResults(answer)).toBe("1. One\n   https://one.example/\n   first\n\n2. Two\n   https://two.example/");
	});

	test("sends the token as a bearer token", async () => {
		await searxngSearch(`http://localhost:${server.port}`, "q", 1, signal, "s3cret");
		expect(lastAuth).toBe("Bearer s3cret");
	});

	test("names the engines that failed", async () => {
		const answer = await searxngSearch(`http://localhost:${server.port}`, "captcha", 1, signal);
		expect(answer.unresponsive).toEqual(["duckduckgo: CAPTCHA"]);
		expect(formatResults(answer)).toEndWith("(Engines that failed for this query: duckduckgo: CAPTCHA.)");
	});

	test("explains a 403 without showing the token", async () => {
		const failure = searxngSearch(`http://localhost:${server.port}`, "blocked", 2, signal, "s3cret");
		await expect(failure).rejects.toThrow("this one was not accepted");
		await expect(failure).rejects.not.toThrow("s3cret");
		await expect(searxngSearch(`http://localhost:${server.port}`, "blocked", 2, signal)).rejects.toThrow("none is configured");
	});
});

describe("Exa", () => {
	let server: ReturnType<typeof Bun.serve>;
	const seen: Array<{ method: string; session: string | null }> = [];
	let expireNext = false;
	beforeAll(() => {
		let sessions = 0;
		server = Bun.serve({
			port: 0,
			async fetch(req) {
				const message = (await req.json()) as { id?: number; method: string; params?: any };
				const session = req.headers.get("mcp-session-id");
				seen.push({ method: message.method, session });
				if (message.method === "initialize") {
					sessions += 1;
					return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} })}\n\n`, {
						headers: { "content-type": "text/event-stream", "mcp-session-id": `s${sessions}` },
					});
				}
				if (message.id === undefined) return new Response(null, { status: 202 });
				if (expireNext) {
					expireNext = false;
					return new Response("gone", { status: 404 });
				}
				const query = message.params.arguments.query as string;
				return Response.json({
					jsonrpc: "2.0",
					id: message.id,
					result: { content: [{ type: "text", text: `results for ${query} in ${session}` }], isError: query === "bad" },
				});
			},
		});
	});
	afterAll(() => server.stop());

	test("opens a session once and calls the tool in it", async () => {
		const exa = new ExaClient(`http://localhost:${server.port}/mcp`, 5000, postIpv4);
		expect((await exa.callTool("web_search_exa", { query: "q1" }, signal)).text).toBe("results for q1 in s1");
		expect((await exa.callTool("web_search_exa", { query: "q2" }, signal)).text).toBe("results for q2 in s1");
		expect(seen.map((s) => s.method)).toEqual(["initialize", "notifications/initialized", "tools/call", "tools/call"]);
	});

	test("opens a new session after the server forgot the old one", async () => {
		const exa = new ExaClient(`http://localhost:${server.port}/mcp`, 5000, postIpv4);
		await exa.callTool("web_search_exa", { query: "warm" }, signal);
		expireNext = true;
		expect((await exa.callTool("web_search_exa", { query: "again" }, signal)).text).toBe("results for again in s3");
	});

	test("reports a tool error", async () => {
		const exa = new ExaClient(`http://localhost:${server.port}/mcp`, 5000, postIpv4);
		expect((await exa.callTool("web_search_exa", { query: "bad" }, signal)).isError).toBe(true);
	});

	test("explains HTTP errors", async () => {
		const post = async () => ({ status: 429, headers: {}, body: "" });
		const exa = new ExaClient("http://unused/", 5000, post);
		await expect(exa.callTool("web_search_exa", { query: "x" }, signal)).rejects.toThrow("rate limit");
	});

	test("finds the answer in an SSE body", () => {
		const body = 'event: message\ndata: {"jsonrpc":"2.0","method":"note"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":true}}\n';
		expect(parseRpcBody(body, "text/event-stream", 7).result).toEqual({ ok: true });
	});
});

describe("config", () => {
	const home = mkdtempSync(join(tmpdir(), "pi-web-test-"));
	const path = join(home, "config.json");
	const envFile = join(home, ".config", "pi-web", "searxng.env");
	const env = { XDG_CONFIG_HOME: join(home, ".config") };

	test("defaults to Exa without a SearXNG URL, and to SearXNG with one", () => {
		expect(defaultBackend(loadConfig(join(home, "missing.json"), env, home).config)).toBe("exa");
		writeFileSync(path, JSON.stringify({ searxngUrl: "https://search.example" }));
		expect(defaultBackend(loadConfig(path, env, home).config)).toBe("searxng");
	});

	test("reads the URL and the token from the SearXNG env file", () => {
		mkdirSync(join(home, ".config", "pi-web"), { recursive: true });
		writeFileSync(envFile, "# comment\nSEARXNG_URL=https://sx.example\nexport SEARXNG_TOKEN='tok'\n");
		const { config } = loadConfig(join(home, "missing.json"), env, home);
		expect(config.searxngUrl).toBe("https://sx.example");
		expect(config.searxngToken).toBe("tok");
		expect(defaultBackend(config)).toBe("searxng");
		rmSync(envFile);
	});

	test("the environment wins over the files", () => {
		writeFileSync(path, JSON.stringify({ backend: "searxng", searxngUrl: "https://a.example" }));
		const { config } = loadConfig(
			path,
			{ ...env, PI_WEB_SEARCH: "exa", PI_WEB_SEARXNG_URL: "https://b.example", PI_WEB_SEARXNG_TOKEN: "t2" },
			home,
		);
		expect(config.backend).toBe("exa");
		expect(config.searxngUrl).toBe("https://b.example");
		expect(config.searxngToken).toBe("t2");
	});

	test("reports a bad file or variable, and keeps the defaults", () => {
		writeFileSync(path, "{not json");
		expect(loadConfig(path, env, home).error).toContain(path);
		expect(loadConfig(join(home, "missing.json"), { ...env, PI_WEB_SEARCH: "google" }, home).error).toContain("PI_WEB_SEARCH");
	});

	test("reads a browser command and an env file path with ~", () => {
		writeFileSync(path, JSON.stringify({ browserCommand: ["~/bin/fetch", "--text"], searxngEnvFile: "~/secret.env" }));
		const { config, error } = loadConfig(path, env, home);
		expect(error).toBeUndefined();
		expect(config.browserCommand).toEqual([join(home, "bin/fetch"), "--text"]);
		expect(config.searxngEnvFile).toBe(join(home, "secret.env"));
		writeFileSync(path, JSON.stringify({ browserCommand: "fetch --text" }));
		expect(loadConfig(path, env, home).error).toContain("browserCommand");
	});

	test("uses arcesse when it is on PATH and the file names no browser command", () => {
		const bin = join(home, "bin");
		mkdirSync(bin, { recursive: true });
		writeFileSync(join(bin, "arcesse"), "#!/bin/sh\n", { mode: 0o755 });
		const withArcesse = { ...env, PATH: bin };
		expect(loadConfig(join(home, "missing.json"), withArcesse, home).config.browserCommand).toEqual(["arcesse", "read"]);
		expect(loadConfig(join(home, "missing.json"), env, home).config.browserCommand).toBeUndefined();
		writeFileSync(path, JSON.stringify({ browserCommand: null }));
		expect(loadConfig(path, withArcesse, home).config.browserCommand).toBeUndefined();
		writeFileSync(path, JSON.stringify({ browserCommand: ["other", "--text"] }));
		expect(loadConfig(path, withArcesse, home).config.browserCommand).toEqual(["other", "--text"]);
	});

	test("parses env files", () => {
		expect(parseEnvFile('A=1\n  # x\nexport B="two words"\nC=\nnot a line\n')).toEqual({ A: "1", B: "two words", C: "" });
	});
});
