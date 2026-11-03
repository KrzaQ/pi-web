export interface SearchResult {
	title: string;
	url: string;
	snippet: string;
}

export interface SearxngAnswer {
	results: SearchResult[];
	/** Engines that failed this query, with SearXNG's reason, such as a CAPTCHA. */
	unresponsive: string[];
}

/**
 * A query to SearXNG's JSON API. The instance must list `json` in
 * search.formats. A token, when set, goes in every request as a bearer token:
 * an instance may need it from outside its own network.
 */
export async function searxngSearch(
	baseUrl: string,
	query: string,
	count: number,
	signal: AbortSignal,
	token?: string,
	fetchFn: typeof fetch = fetch,
): Promise<SearxngAnswer> {
	const url = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
	url.searchParams.set("q", query);
	url.searchParams.set("format", "json");
	const headers: Record<string, string> = { accept: "application/json" };
	if (token) headers.authorization = `Bearer ${token}`;
	const response = await fetchFn(url, { headers, signal });
	if (response.status === 401 || response.status === 403) {
		throw new Error(
			`SearXNG refused the query (HTTP ${response.status}). From outside its network it needs a token${token ? ", and this one was not accepted" : ", and none is configured"}; or json is missing from its search.formats.`,
		);
	}
	if (!response.ok) throw new Error(`SearXNG answered HTTP ${response.status}`);
	const data = (await response.json()) as { results?: Array<Record<string, unknown>>; unresponsive_engines?: unknown };
	const unresponsive = Array.isArray(data.unresponsive_engines)
		? data.unresponsive_engines.map((entry) =>
				Array.isArray(entry) ? entry.filter((part) => typeof part === "string" && part).join(": ") : String(entry),
			)
		: [];
	const results = (data.results ?? []).slice(0, count).map((r) => ({
		title: typeof r.title === "string" ? r.title : "",
		url: typeof r.url === "string" ? r.url : "",
		snippet: typeof r.content === "string" ? r.content : "",
	}));
	return { results, unresponsive };
}

export function formatResults(answer: SearxngAnswer): string {
	const list =
		answer.results.length === 0
			? "No results."
			: answer.results
					.map((r, i) => [`${i + 1}. ${r.title || r.url}`, `   ${r.url}`, ...(r.snippet ? [`   ${r.snippet}`] : [])].join("\n"))
					.join("\n\n");
	if (answer.unresponsive.length === 0) return list;
	return `${list}\n\n(Engines that failed for this query: ${answer.unresponsive.join("; ")}.)`;
}
