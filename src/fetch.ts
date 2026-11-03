import { execFile } from "node:child_process";
import { htmlTitle, htmlToText } from "./html.ts";

/** Bytes read from one response at most. Bigger bodies are cut. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;

const USER_AGENT = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 pi-web";

/** A page shorter than this after conversion is probably built by JavaScript. */
const MIN_TEXT_CHARS = 200;

export interface Page {
	text: string;
	via: "http" | "browser";
	title?: string;
	/** Why pi-web used the browser instead of the plain response. */
	fallback?: string;
}

export interface FetchDeps {
	fetch: typeof fetch;
	/** Fetches a page with a real browser. Unset when no browser command is configured. */
	browser?: (url: string, signal: AbortSignal) => Promise<string>;
}

/** Runs the configured browser command with the URL appended, and returns its output. */
export function runBrowser(command: string[], timeoutMs: number): NonNullable<FetchDeps["browser"]> {
	const [program, ...args] = command;
	if (!program) throw new Error("browserCommand is empty");
	return (url, signal) =>
		new Promise((resolve, reject) => {
			execFile(
				program,
				[...args, url],
				{ timeout: timeoutMs, maxBuffer: MAX_BODY_BYTES * 2, signal },
				(error, stdout, stderr) => {
					if (error) reject(new Error(`the browser fetch failed: ${(stderr || error.message).trim()}`));
					else resolve(stdout);
				},
			);
		});
}

/** The markers of the bot-protection pages that a plain fetch gets instead of the content. */
export function isChallenge(status: number, body: string): boolean {
	if (status === 403 || status === 429 || status === 503) return true;
	return /cf-chl-|challenge-platform|<title>\s*(Just a moment|Attention Required)|Enable JavaScript and cookies to continue/i.test(
		body,
	);
}

function checkUrl(raw: string): URL {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new Error(`Not a URL: ${raw}`);
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new Error(`Only http and https URLs can be fetched, not ${url.protocol}`);
	}
	return url;
}

async function readBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < MAX_BODY_BYTES) {
		const { done, value } = await reader.read();
		if (done) break;
		chunks.push(value);
		size += value.byteLength;
	}
	await reader.cancel().catch(() => {});
	return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES));
}

async function viaBrowser(url: URL, deps: FetchDeps, signal: AbortSignal, fallback?: string): Promise<Page> {
	if (!deps.browser) throw new Error("no browser fetch is configured (browserCommand)");
	const text = (await deps.browser(url.href, signal)).trim();
	return { text, via: "browser", fallback };
}

/**
 * Fetch a page as readable text. A plain HTTP fetch first; the configured
 * browser command when the site blocks the plain fetch, when the page is
 * empty without JavaScript, or when `browser` asks for it.
 */
export async function fetchPage(raw: string, browser: boolean, deps: FetchDeps, signal: AbortSignal): Promise<Page> {
	const url = checkUrl(raw);
	if (browser) return viaBrowser(url, deps, signal);

	const response = await deps.fetch(url, {
		redirect: "follow",
		headers: {
			"user-agent": USER_AGENT,
			accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
		},
		signal,
	});
	const body = await readBody(response);
	const type = response.headers.get("content-type") ?? "";
	const isHtml = /html/i.test(type) || (!type && /^\s*</.test(body));

	const fallback = async (reason: string, original: () => Error): Promise<Page> => {
		try {
			return await viaBrowser(url, deps, signal, reason);
		} catch (error) {
			throw new Error(`${original().message}; ${(error as Error).message}`);
		}
	};

	if (isChallenge(response.status, isHtml ? body : "")) {
		return fallback(`the site answered HTTP ${response.status} or a bot check`, () => new Error(`HTTP ${response.status}`));
	}
	if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());

	if (isHtml) {
		const text = htmlToText(body, response.url || url.href);
		if (text.length < MIN_TEXT_CHARS) {
			return fallback("the page has almost no text without JavaScript", () => new Error("the page is empty"));
		}
		return { text, via: "http", title: htmlTitle(body) };
	}
	if (/^text\/|json|xml|javascript|yaml|toml/i.test(type) || !type) return { text: body, via: "http" };
	throw new Error(`The page is ${type}, not text (${body.length} bytes). pi-web does not show binary content.`);
}
