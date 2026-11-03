import { describe, expect, test } from "bun:test";
import { type FetchDeps, fetchPage, isChallenge } from "../src/fetch.ts";

const LONG = "<p>" + "Readable text. ".repeat(30) + "</p>";

function deps(response: { status?: number; type?: string; body: string }, browserText = "via the browser"): FetchDeps & {
	browserCalls: string[];
} {
	const browserCalls: string[] = [];
	return {
		browserCalls,
		fetch: (async () =>
			new Response(response.body, {
				status: response.status ?? 200,
				headers: response.type === undefined ? { "content-type": "text/html; charset=utf-8" } : { "content-type": response.type },
			})) as unknown as typeof fetch,
		browser: async (url) => {
			browserCalls.push(url);
			return browserText;
		},
	};
}

const signal = new AbortController().signal;

describe("fetchPage", () => {
	test("returns the converted page of a plain fetch", async () => {
		const d = deps({ body: `<title>T</title>${LONG}` });
		const page = await fetchPage("https://example.org/", false, d, signal);
		expect(page.via).toBe("http");
		expect(page.title).toBe("T");
		expect(page.text.startsWith("Readable text.")).toBe(true);
		expect(d.browserCalls).toEqual([]);
	});

	test("falls back to the browser on a bot check", async () => {
		const d = deps({ status: 403, body: "<title>Just a moment...</title>" });
		const page = await fetchPage("https://example.org/", false, d, signal);
		expect(page.via).toBe("browser");
		expect(page.text).toBe("via the browser");
		expect(d.browserCalls).toEqual(["https://example.org/"]);
	});

	test("falls back to the browser when the page is empty without JavaScript", async () => {
		const d = deps({ body: "<div id='app'></div>" });
		const page = await fetchPage("https://example.org/", false, d, signal);
		expect(page.via).toBe("browser");
		expect(page.fallback).toContain("JavaScript");
	});

	test("uses the browser from the start when asked", async () => {
		const d = deps({ body: LONG });
		const page = await fetchPage("https://example.org/", true, d, signal);
		expect(page.via).toBe("browser");
	});

	test("returns plain text as it is", async () => {
		const d = deps({ type: "text/plain", body: "just text" });
		expect((await fetchPage("https://example.org/a.txt", false, d, signal)).text).toBe("just text");
	});

	test("refuses binary content and other schemes", async () => {
		await expect(fetchPage("https://example.org/a.png", false, deps({ type: "image/png", body: "x" }), signal)).rejects.toThrow(
			"not text",
		);
		await expect(fetchPage("file:///etc/passwd", false, deps({ body: "" }), signal)).rejects.toThrow("Only http and https");
	});

	test("reports an HTTP error without a fallback", async () => {
		await expect(fetchPage("https://example.org/", false, deps({ status: 404, body: "missing" }), signal)).rejects.toThrow("HTTP 404");
	});

	test("names both failures when the browser fails too", async () => {
		const d = deps({ status: 503, body: "" });
		d.browser = async () => {
			throw new Error("the browser fetch failed: no browser");
		};
		await expect(fetchPage("https://example.org/", false, d, signal)).rejects.toThrow(
			"HTTP 503; the browser fetch failed: no browser",
		);
	});

	test("reports a blocked page when no browser is configured", async () => {
		const d = deps({ status: 403, body: "" });
		delete d.browser;
		await expect(fetchPage("https://example.org/", false, d, signal)).rejects.toThrow("HTTP 403; no browser fetch is configured");
	});
});

describe("isChallenge", () => {
	test("recognizes blocking statuses and Cloudflare pages", () => {
		expect(isChallenge(429, "")).toBe(true);
		expect(isChallenge(200, '<script src="/cdn-cgi/challenge-platform/x"></script>')).toBe(true);
		expect(isChallenge(200, "<p>fine</p>")).toBe(false);
	});
});
