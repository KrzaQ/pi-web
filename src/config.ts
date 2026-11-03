import { readFileSync } from "node:fs";
import { join } from "node:path";

export type Backend = "exa" | "searxng";
export const BACKENDS: readonly Backend[] = ["exa", "searxng"];

export interface Config {
	/** The search backend. Unset: SearXNG when searxngUrl is set, else Exa. */
	backend?: Backend;
	/** The SearXNG base URL, for example https://search.example. */
	searxngUrl?: string;
	/** A bearer token for SearXNG, for an instance that requires one. Never shown. */
	searxngToken?: string;
	/**
	 * A shell-style env file with SEARXNG_URL and SEARXNG_TOKEN. The token
	 * belongs in a file like this, mode 600, not in config.json.
	 */
	searxngEnvFile: string;
	/** Exa's hosted MCP endpoint. Keyless use needs a direct IPv4 connection. */
	exaUrl: string;
	/**
	 * A command that fetches a page with a real browser and prints it as text,
	 * for pages behind bot protection. pi-web appends the URL. Unset: no
	 * browser fallback.
	 */
	browserCommand?: string[];
	timeoutMs: number;
}

export function defaults(env: NodeJS.ProcessEnv, home: string): Config {
	return {
		exaUrl: "https://mcp.exa.ai/mcp",
		timeoutMs: 30_000,
		searxngEnvFile: join(configDir(env, home), "searxng.env"),
	};
}

export function configDir(env: NodeJS.ProcessEnv, home: string): string {
	return join(env.XDG_CONFIG_HOME || join(home, ".config"), "pi-web");
}

/** A leading ~/ means the home directory, as in a shell. */
export function expandHome(path: string, home: string): string {
	return path === "~" ? home : path.startsWith("~/") ? join(home, path.slice(2)) : path;
}

/** KEY=VALUE lines, with optional `export ` and quotes; # starts a comment line. */
export function parseEnvFile(text: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
		if (!match?.[1]) continue;
		let value = match[2] ?? "";
		const quote = value[0];
		if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) value = value.slice(1, -1);
		out[match[1]] = value;
	}
	return out;
}

export interface LoadedConfig {
	config: Config;
	/** Set when the file exists but pi-web cannot use it. */
	error?: string;
}

function isBackend(value: unknown): value is Backend {
	return typeof value === "string" && (BACKENDS as readonly string[]).includes(value);
}

/**
 * The config file, then the SearXNG env file, then the environment on top:
 * PI_WEB_SEARCH picks the backend for one pi run, PI_WEB_SEARXNG_URL and
 * PI_WEB_SEARXNG_TOKEN the SearXNG instance and its token.
 */
export function loadConfig(path: string, env: NodeJS.ProcessEnv, home: string): LoadedConfig {
	const config: Config = defaults(env, home);
	let error: string | undefined;

	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// No file: the defaults apply.
	}
	if (raw !== undefined) {
		try {
			const data = JSON.parse(raw) as Record<string, unknown>;
			if (data.backend !== undefined) {
				if (isBackend(data.backend)) config.backend = data.backend;
				else error = `${path}: backend must be one of ${BACKENDS.join(", ")}`;
			}
			for (const key of ["searxngUrl", "searxngEnvFile", "exaUrl"] as const) {
				if (typeof data[key] === "string" && data[key]) config[key] = data[key];
			}
			config.searxngEnvFile = expandHome(config.searxngEnvFile, home);
			if (data.browserCommand !== undefined) {
				const command = data.browserCommand;
				if (Array.isArray(command) && command.length > 0 && command.every((part) => typeof part === "string" && part)) {
					config.browserCommand = command.map((part, i) => (i === 0 ? expandHome(part, home) : part));
				} else {
					error = `${path}: browserCommand must be a list of strings, for example ["my-browser-fetch", "--text"]`;
				}
			}
			if (typeof data.timeoutMs === "number" && data.timeoutMs > 0) config.timeoutMs = data.timeoutMs;
		} catch (e) {
			error = `${path}: ${(e as Error).message}`;
		}
	}

	let envFile: string | undefined;
	try {
		envFile = readFileSync(config.searxngEnvFile, "utf8");
	} catch {
		// No env file: SearXNG needs a URL from somewhere else, or is not used.
	}
	if (envFile !== undefined) {
		const values = parseEnvFile(envFile);
		if (values.SEARXNG_URL && !config.searxngUrl) config.searxngUrl = values.SEARXNG_URL;
		if (values.SEARXNG_TOKEN) config.searxngToken = values.SEARXNG_TOKEN;
	}

	if (env.PI_WEB_SEARXNG_URL) config.searxngUrl = env.PI_WEB_SEARXNG_URL;
	if (env.PI_WEB_SEARXNG_TOKEN) config.searxngToken = env.PI_WEB_SEARXNG_TOKEN;
	if (env.PI_WEB_SEARCH) {
		if (isBackend(env.PI_WEB_SEARCH)) config.backend = env.PI_WEB_SEARCH;
		else error = `PI_WEB_SEARCH must be one of ${BACKENDS.join(", ")}`;
	}
	return { config, error };
}

export function defaultBackend(config: Config): Backend {
	return config.backend ?? (config.searxngUrl ? "searxng" : "exa");
}
