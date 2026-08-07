# FIT → CSV Converter

Trang web chuyển file `.fit` sang CSV hoàn toàn trên trình duyệt. File FIT không được upload lên backend.

## Chức năng

- Drag & drop hoặc chọn file `.fit`
- Parse FIT bằng `fit-file-parser`
- Hiển thị summary: distance, time, pace, HR, cadence, elevation, calories
- Hiển thị laps/splits
- Xuất `*_records.csv`
- Xuất `*_laps.csv`
- Xuất `*_activity.csv`
- Chạy static trên Cloudflare Workers Static Assets

## Chạy local

Yêu cầu Node.js 20+.

```bash
npm install
npm run dev
```

Vite sẽ hiện URL local, thường là `http://localhost:5173`.

## Build

```bash
npm run build
```

Output nằm trong thư mục `dist/`.

## Deploy Cloudflare Workers

Đăng nhập Cloudflare lần đầu:

```bash
npx wrangler login
```

Deploy:

```bash
npm run deploy
```

Wrangler sẽ build rồi upload thư mục `dist/` theo `wrangler.jsonc`.

## Custom domain

Sau khi deploy:

1. Cloudflare Dashboard
2. Workers & Pages
3. Chọn worker `fit-csv-converter`
4. Settings / Domains & Routes
5. Add Custom Domain

## Privacy

App dùng `File.arrayBuffer()` và parse trực tiếp trong browser. Không có endpoint upload file và không có database.
