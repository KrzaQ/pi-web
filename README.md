# pi-web

A [pi](https://pi.dev) extension that adds two tools:

- `web_search` searches the web through [SearXNG](https://docs.searxng.org)
  or [Exa](https://exa.ai)'s hosted MCP server.
- `web_fetch` reads a page as text close to Markdown, with absolute links.
  When a site blocks plain requests or needs JavaScript, it can fall back to
  a browser command that you configure.

It has no runtime dependencies beyond pi and Node.js.

## Install

```bash
make deploy    # copy the extension to ~/.pi/agent/extensions/pi-web
make run       # or: start pi with pi-web loaded for one session
```

`deploy` copies the files, so that a session working in this repo cannot
change the extension that pi loads.

## Search backends

- **Exa** needs no key: pi-web uses the keyless hosted endpoint, which has a
  free rate limit and serves keyless calls only over IPv4.
- **SearXNG** needs an instance with `json` in `search.formats`. When the
  instance requires a bearer token, pi-web sends it with every request.

Without a setting, pi-web uses SearXNG when an instance is configured, and
Exa otherwise. `/search` shows the backend, and `/search exa` or
`/search searxng` switches it for the session. The status line shows it.

## Configuration

`~/.config/pi-web/config.json` (all keys optional):

```json
{
  "backend": "searxng",
  "searxngUrl": "https://search.example",
  "searxngEnvFile": "~/.config/pi-web/searxng.env",
  "browserCommand": ["my-browser-fetch", "--text"],
  "timeoutMs": 30000
}
```

- `searxngEnvFile` is a shell-style file with `SEARXNG_URL` and
  `SEARXNG_TOKEN`. Keep the token there, with mode 600, not in
  `config.json`. The default is `~/.config/pi-web/searxng.env`.
- `browserCommand` fetches a page with a real browser and prints it as text.
  pi-web appends the URL. Without it, pi-web has no browser fallback.

These environment variables override the files for one pi run:
`PI_WEB_SEARCH` (`exa` or `searxng`), `PI_WEB_SEARXNG_URL` and
`PI_WEB_SEARXNG_TOKEN`.

## Security

- Search results and fetched pages are untrusted text. Both tools tell the
  model not to follow instructions found in them.
- A URL or a search query can carry data out. pi has no permission prompts
  of its own, so consider an extension that gates tool calls.
- With Exa, Exa sees every query.

## Development

```bash
make test      # run the tests
make lint      # check the types
```
