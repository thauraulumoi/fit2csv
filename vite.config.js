import { defineConfig } from "vite";
import { resolve } from "node:path";
export default defineConfig({build:{rollupOptions:{input:{main:resolve(__dirname,"index.html"),garmin:resolve(__dirname,"garmin-fit-to-csv/index.html"),coros:resolve(__dirname,"coros-fit-to-csv/index.html"),ai:resolve(__dirname,"fit-to-csv-for-ai/index.html")}}}});
