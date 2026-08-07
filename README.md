# FIT → CSV Converter

A privacy-first web app that converts a `.fit` activity file into one complete, AI-ready CSV directly in the browser. The FIT file is never uploaded to a backend.

## Features

- Drag & drop or browse for a `.fit` file
- Parse FIT data with `fit-file-parser`
- Display activity summary: distance, time, average pace, heart rate, cadence, elevation gain, and calories
- Display FIT laps / splits
- Export **one** `*_full.csv` file containing:
  - one `summary` row with overall activity metrics
  - all `split` rows
  - all timestamped `record` rows
- Record-level fields include distance, speed, pace, heart rate, cadence, stride length, altitude, temperature, power, and GPS when present in the FIT file
- Designed so an AI coach can analyze a single CSV without merging multiple files
- Runs as static assets on Cloudflare Workers

## Full CSV structure

The first column is `row_type`:

- `summary`: overall activity context
- `split`: one row per FIT lap / split
- `record`: timestamped activity samples

All three row types share one CSV header. Fields that do not apply to a row are left blank.

## Run locally

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Vite will print the local URL, usually `http://localhost:5173`.

## Build

```bash
npm run build
```

The output is written to `dist/`.

## Deploy to Cloudflare Workers

Login once:

```bash
npx wrangler login
```

Deploy:

```bash
npm run deploy
```

Wrangler builds the app and uploads the `dist/` directory configured in `wrangler.jsonc`.

## Privacy

The app reads the FIT file with `File.arrayBuffer()` and parses it locally in the browser. There is no upload endpoint and no database.
