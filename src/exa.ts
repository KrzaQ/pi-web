import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

/** One HTTP POST, as the MCP client needs it. */
export type Post = (
	url: string,
	headers: Record<string, string>,
	body: string,
	signal: AbortSignal,
) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

/**
 * POST over IPv4 only. Exa serves keyless calls only over a direct IPv4
 * connection; over IPv6 or a proxy it answers 403.
 */
export const postIpv4: Post = (url, headers, body, signal) =>
	new Promise((resolve, reject) => {
		const target = new URL(url);
		const request = target.protocol === "https:" ? httpsRequest : httpRequest;
		const req = request(
			target,
			{ method: "POST", family: 4, headers: { ...headers, "accept-encoding": "identity" }, signal },
			(res) => {
				const chunks: Buffer[] = [];
				res.on("data", (chunk: Buffer) => chunks.push(chunk));
				res.on("end", () => {
					const out: Record<string, string> = {};
					for (const [key, value] of Object.entries(res.headers)) {
						if (typeof value === "string") out[key.toLowerCase()] = value;
					}
					resolve({ status: res.statusCode ?? 0, headers: out, body: Buffer.concat(chunks).toString("utf8") });
				});
				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.end(body);
	});

const PROTOCOL_VERSION = "2025-06-18";

interface RpcMessage {
	id?: number;
	result?: any;
	error?: { code: number; message: string };
}

/** The JSON-RPC message with this id, from a JSON or an SSE response body. */
export function parseRpcBody(body: string, contentType: string, id: number): RpcMessage {
	const messages: RpcMessage[] = [];
	if (contentType.includes("text/event-stream")) {
		for (const line of body.split(/\r?\n/)) {
			if (!line.startsWith("data:")) continue;
			const data = line.slice(5).trim();
			if (data) messages.push(JSON.parse(data) as RpcMessage);
		}
	} else {
		const parsed = JSON.parse(body) as RpcMessage | RpcMessage[];
		messages.push(...(Array.isArray(parsed) ? parsed : [parsed]));
	}
	const message = messages.find((m) => m.id === id);
	if (!message) throw new Error("Exa sent no answer to the request");
	return message;
}

function httpError(status: number): Error {
	if (status === 429) return new Error("Exa's free rate limit is used up for now (HTTP 429). Try SearXNG or wait.");
	if (status === 403) return new Error("Exa refused the call (HTTP 403). Keyless use needs a direct IPv4 connection.");
	return new Error(`Exa answered HTTP ${status}`);
}

export interface ToolResult {
	text: string;
	isError: boolean;
}

/** The smallest MCP client that Exa's hosted server needs: one session, tool calls. */
export class ExaClient {
	private session: string | undefined;
	private initialized = false;
	private nextId = 1;

	constructor(
		private readonly url: string,
		private readonly timeoutMs: number,
		private readonly post: Post = postIpv4,
	) {}

	private headers(): Record<string, string> {
		const headers: Record<string, string> = {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
		};
		if (this.initialized) headers["mcp-protocol-version"] = PROTOCOL_VERSION;
		if (this.session) headers["mcp-session-id"] = this.session;
		return headers;
	}

	private async send(payload: object, signal: AbortSignal) {
		const timeout = AbortSignal.timeout(this.timeoutMs);
		const response = await this.post(this.url, this.headers(), JSON.stringify(payload), AbortSignal.any([signal, timeout]));
		const session = response.headers["mcp-session-id"];
		if (session) this.session = session;
		return response;
	}

	private async rpc(method: string, params: object, signal: AbortSignal): Promise<any> {
		const id = this.nextId++;
		const response = await this.send({ jsonrpc: "2.0", id, method, params }, signal);
		if (response.status < 200 || response.status >= 300) throw Object.assign(httpError(response.status), { status: response.status });
		const message = parseRpcBody(response.body, response.headers["content-type"] ?? "", id);
		if (message.error) throw new Error(`Exa: ${message.error.message}`);
		return message.result;
	}

	private async connect(signal: AbortSignal): Promise<void> {
		if (this.initialized) return;
		await this.rpc(
			"initialize",
			{ protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "pi-web", version: "0.1.0" } },
			signal,
		);
		this.initialized = true;
		await this.send({ jsonrpc: "2.0", method: "notifications/initialized" }, signal);
	}

	async callTool(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
		await this.connect(signal);
		let result: any;
		try {
			result = await this.rpc("tools/call", { name, arguments: args }, signal);
		} catch (error) {
			// A server forgets a session after a while and answers 404 for it.
			if ((error as { status?: number }).status !== 404) throw error;
			this.session = undefined;
			this.initialized = false;
			await this.connect(signal);
			result = await this.rpc("tools/call", { name, arguments: args }, signal);
		}
		const content = Array.isArray(result?.content) ? result.content : [];
		const text = content
			.filter((item: { type?: string }) => item.type === "text")
			.map((item: { text?: string }) => item.text ?? "")
			.join("\n");
		return { text, isError: result?.isError === true };
	}
}
