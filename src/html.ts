// HTML to readable text, close to Markdown. It needs no parser: pages are
// often broken HTML, and the model only needs the text, the structure and the
// links, not a faithful rendering.

const NAMED: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	copy: "©",
	reg: "®",
	trade: "™",
	middot: "·",
	bull: "•",
	laquo: "«",
	raquo: "»",
	rarr: "→",
	larr: "←",
	uarr: "↑",
	darr: "↓",
	harr: "↔",
	times: "×",
	divide: "÷",
	plusmn: "±",
	deg: "°",
	euro: "€",
	pound: "£",
	yen: "¥",
	sect: "§",
	para: "¶",
	shy: "",
	zwj: "",
	zwnj: "",
};

export function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, code: string) => {
		if (code[0] === "#") {
			const n = code[1] === "x" || code[1] === "X" ? Number.parseInt(code.slice(2), 16) : Number.parseInt(code.slice(1), 10);
			return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : match;
		}
		return NAMED[code.toLowerCase()] ?? match;
	});
}

/** The page title, when the page has one. */
export function htmlTitle(html: string): string | undefined {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	const title = match?.[1] ? decodeEntities(match[1]).replace(/\s+/g, " ").trim() : "";
	return title || undefined;
}

function stripTags(html: string): string {
	return html.replace(/<[^>]*>/g, "");
}

function attribute(tag: string, name: string): string | undefined {
	const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
	return match ? (match[2] ?? match[3] ?? match[4]) : undefined;
}

function absolute(href: string, base: string | undefined): string {
	try {
		return base ? new URL(href, base).href : href;
	} catch {
		return href;
	}
}

export function htmlToText(html: string, baseUrl?: string): string {
	let s = html;

	// Parts that hold no readable text.
	s = s.replace(/<!--[\s\S]*?-->/g, "");
	// The title too: htmlTitle reports it on its own.
	s = s.replace(/<(script|style|noscript|template|svg|canvas|iframe|head|title|select)\b[\s\S]*?<\/\1\s*>/gi, "");
	// Page chrome: menus, sidebars and footers repeat on every page.
	s = s.replace(/<(nav|aside|footer)\b[\s\S]*?<\/\1\s*>/gi, "");

	// Code blocks keep their whitespace. They are taken out first and put back
	// last, so that the rest of the conversion does not reflow them.
	const blocks: string[] = [];
	s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_m, inner: string) => {
		blocks.push(decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/\n+$/, ""));
		return `\n\n\u0000${blocks.length - 1}\u0000\n\n`;
	});

	s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_m, level: string, inner: string) => {
		const text = stripTags(inner).replace(/\s+/g, " ").trim();
		return text ? `\n\n${"#".repeat(Number(level))} ${text}\n\n` : "\n\n";
	});
	s = s.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (_m, attrs: string, inner: string) => {
		const text = stripTags(inner).replace(/\s+/g, " ").trim();
		const href = attribute(attrs, "href");
		if (!text) return "";
		if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return text;
		return `[${text}](${absolute(decodeEntities(href), baseUrl)})`;
	});
	s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code\s*>/gi, (_m, inner: string) => `\`${stripTags(inner)}\``);
	s = s.replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1\s*>/gi, "**$2**");
	s = s.replace(/<li\b[^>]*>/gi, "\n- ");
	s = s.replace(/<br\s*\/?>/gi, "\n");
	s = s.replace(/<(td|th)\b[^>]*>/gi, " | ");
	s = s.replace(/<\/?(p|div|section|article|main|header|ul|ol|table|tr|blockquote|dl|dt|dd|figure|figcaption|form|hr)\b[^>]*>/gi, "\n\n");

	s = decodeEntities(stripTags(s));

	// Collapse the whitespace that the markup left behind.
	s = s
		.split("\n")
		.map((line) => line.replace(/[ \t ]+/g, " ").trim())
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();

	return s.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `\`\`\`\n${blocks[Number(i)]}\n\`\`\``);
}
