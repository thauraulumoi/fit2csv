# FIT2CSV — FIT to CSV Converter

A browser-only FIT file decoder that exports all data exposed by `fit-file-parser` into one CSV file.

The FIT file never leaves the browser. There is no upload API, backend processing, or database.

## Final Export Policy

The downloaded CSV is intentionally a raw decoded export.

- No pace fields are calculated for the CSV.
- No heart-rate drift is calculated.
- No workout type is inferred.
- No coaching metrics are added.
- No activity fields are renamed.
- No activity fields are intentionally filtered out.
- Parser-native FIT units are used (`m/s` for speed, `m` for length, Celsius for temperature, and `bar` for pressure unless the FIT parser itself defines otherwise).
- `elapsedRecordField` is not enabled, so synthetic elapsed/timer record fields are not added by the app.

Because FIT is a binary protocol and CSV is text, decoding/serialization is unavoidable. The application therefore preserves the decoded field names and values returned by `fit-file-parser` rather than performing additional application-level transformations.

Two structural CSV columns are present so different FIT message types can coexist in one valid table:

- `message_type` — identifies the decoded FIT message type.
- `message_index` — identifies the occurrence of that message type.

All remaining columns are field names found in the decoded FIT messages. Arrays or object-valued fields are serialized as JSON inside a CSV cell so their contents are not discarded.

## Features

- Drag and drop or select a `.fit` file
- Parse locally with `fit-file-parser`
- Show an English activity summary and lap/split preview in the browser
- Download one `*_full.csv`
- Export every decoded FIT message available through the parser's `messages` collection
- Keep original parser field names
- No derived coaching data in the CSV
- Static deployment on Cloudflare Workers Static Assets

## Local Development

Requires Node.js 20 or later.

```bash
npm install
npm run dev
```

Vite will display a local URL, typically:

```text
http://localhost:5173
```

## Build

```bash
npm run build
```

The production output is generated in:

```text
dist/
```

## Deploy to Cloudflare Workers

Log in once:

```bash
npx wrangler login
```

Deploy:

```bash
npm run deploy
```

Wrangler builds the project and deploys the `dist/` directory according to `wrangler.jsonc`.

## Custom Domain

1. Open Cloudflare Dashboard.
2. Go to **Workers & Pages**.
3. Select `fit2csv`.
4. Open **Settings → Domains & Routes**.
5. Select **Add Custom Domain**.
6. Enter the desired domain or subdomain.

## Privacy

The application reads the FIT file with `File.arrayBuffer()` and parses it directly in the user's browser.

It does not:

- Upload the FIT file
- Store the FIT file on a server
- Send activity data to Cloudflare Workers for processing
- Use a database

Cloudflare Workers is used only to serve the static application.

## SEO configuration for fit2csv.click

This build includes production SEO settings for `https://fit2csv.click/`:

- Canonical URL
- Search title and meta description
- Open Graph and Twitter metadata
- `WebSite` and `SoftwareApplication` JSON-LD structured data
- Search-friendly visible content and FAQ
- `public/robots.txt`
- `public/sitemap.txt`
- `public/favicon.svg`

After deployment, verify the domain in Google Search Console, submit `https://fit2csv.click/sitemap.txt`, inspect `https://fit2csv.click/`, and request indexing.


## SEO Landing Pages

- `https://fit2csv.click/garmin-fit-to-csv/`
- `https://fit2csv.click/coros-fit-to-csv/`
- `https://fit2csv.click/fit-to-csv-for-ai/`

All three pages use unique metadata, canonical URLs, visible content, internal links, and are included in `public/sitemap.txt`.


## Phase 2 — Optional AI Workout Analysis

FIT2CSV includes an optional **Analyze with AI** action. The FIT-to-CSV converter remains browser-only and unchanged.

### AI model

This build uses Cloudflare's hosted OpenAI open-weight model and does not require an OpenAI API key.

Workout analysis uses the OpenAI model available through Cloudflare AI:

```text
@cf/openai/gpt-oss-120b
```

The Worker calls the model directly through the Cloudflare `AI` binding:

```js
env.AI.run('@cf/openai/gpt-oss-120b', ...)
```

No OpenAI API key is stored in the frontend, GitHub repository, or Worker secrets for this integration. A separate Workers AI REST API token is not required when the model is called from the Worker through `env.AI`.

### Privacy

When a user explicitly clicks **Analyze with AI**:

- The original FIT file is **not uploaded**.
- Filename, GPS coordinates, and device serial number are excluded.
- The browser creates a compact analysis payload from session metrics, laps, and aggregated record windows.
- Only that compact payload is sent to `POST /api/analyze`.
- The Worker sends the compact metrics to the configured AI model.
- No AI-derived values are written into the downloaded Full CSV.

### Usage limits

This build does not enforce an application-level per-IP quota.

AI requests are still subject to the availability, rate limits, and account-level usage limits of the configured Cloudflare AI model.

FIT2CSV does not read, hash, log, or store client IP addresses for AI quota enforcement.

### Analysis languages

The analysis language selector supports:

- Auto (Browser Language)
- English
- Tiếng Việt
- Español
- Deutsch
- Français
- 日本語
- 한국어
- 中文

`Auto` detects the browser's primary language and falls back to English when it is not supported.

### Cloudflare configuration

`wrangler.jsonc` includes:

```jsonc
"ai": {
  "binding": "AI"
}
```

No Durable Object or per-IP quota is used for AI analysis in this build.

Production deployment remains:

```bash
npm run deploy
```


### AI response handling

The Worker does not depend on JSON Mode for `@cf/openai/gpt-oss-120b`. The model is instructed to return one JSON object, and the Worker accepts both object and string response shapes, including a defensive fallback for accidental Markdown code fences. The returned structure is validated before it is shown in the UI.
