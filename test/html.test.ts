import { describe, expect, test } from "bun:test";
import { decodeEntities, htmlTitle, htmlToText } from "../src/html.ts";

describe("htmlToText", () => {
	test("keeps headings, lists and paragraphs", () => {
		const html = "<h1>Title</h1><p>First <b>bold</b> line.</p><ul><li>one</li><li>two</li></ul><h2>Next</h2><p>End</p>";
		expect(htmlToText(html)).toBe("# Title\n\nFirst **bold** line.\n\n- one\n- two\n\n## Next\n\nEnd");
	});

	test("drops scripts, styles and page chrome", () => {
		const html =
			"<html><head><title>T</title><style>p{}</style></head><body><nav><a href='/x'>Menu</a></nav>" +
			"<script>alert(1)</script><main><p>Content</p></main><footer>Footer</footer></body></html>";
		expect(htmlToText(html)).toBe("Content");
	});

	test("makes links absolute and keeps their text", () => {
		const html = '<p>See <a href="/docs/a?b=1&amp;c=2">the docs</a> and <a href="#top">top</a>.</p>';
		expect(htmlToText(html, "https://example.org/page")).toBe("See [the docs](https://example.org/docs/a?b=1&c=2) and top.");
	});

	test("keeps the whitespace of code blocks", () => {
		const html = "<p>Run:</p><pre><code>make  test\n  --all</code></pre><p>Done</p>";
		expect(htmlToText(html)).toBe("Run:\n\n```\nmake  test\n  --all\n```\n\nDone");
	});

	test("decodes entities", () => {
		expect(decodeEntities("a &lt; b &amp;&amp; c &#8212; &#x41; &nbsp;&unknown;")).toBe("a < b && c — A  &unknown;");
		expect(decodeEntities("New&rarr; 5&times;3")).toBe("New→ 5×3");
	});

	test("reads the title", () => {
		expect(htmlTitle("<head><title> A &amp; B\n</title></head>")).toBe("A & B");
		expect(htmlTitle("<p>none</p>")).toBeUndefined();
	});
});
