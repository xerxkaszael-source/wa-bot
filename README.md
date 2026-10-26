# Baileys Web Pairing + Realtime Chess

Bot WhatsApp memakai fork `github:PrasszTzy66/Bail`, halaman pairing code, perintah chat, dan game catur web realtime.

## Deploy di Render
- Build command: `npm install`
- Start command: `npm start`
- Node.js 20 atau lebih baru.
- Set `APP_URL` ke URL publik service Render (mis. `https://nama-service.onrender.com`). Jika tidak diatur, kode mencoba `RENDER_EXTERNAL_URL`.
- Opsional: set `PAIRING_TOKEN` ke secret acak untuk melindungi endpoint pairing.
- Setelah ganti `package.json`, gunakan **Manual Deploy → Clear build cache & deploy**.

## Commands
- `ping`, `.ping`, `/ping`, `!ping` → `Pong! Bot aktif ✅`
- `menu`, `.menu`, `/menu`, `!menu` → daftar perintah
- `chess`, `.chess`, `/chess`, `!chess` → buat game dan kirim link ke chat tempat perintah dikirim
- `chesshelp` → petunjuk main

## Main catur online
1. Kirim `.chess` di chat pribadi atau grup WhatsApp.
2. Bot membalas dengan link game. Kedua pemain buka link yang sama.
3. Pemain pertama yang menekan Gabung jadi Putih; pemain kedua jadi Hitam.
4. Langkah divalidasi server dan papan disiarkan realtime ke kedua browser. Tap bidak lalu kotak tujuan.

Game berjalan di browser, bukan sebagai papan interaktif langsung di dalam tampilan chat WhatsApp. Kedua pemain perlu membuka link tersebut. Game disimpan di memori server, jadi akan hilang saat server restart atau tidur. Render Free bisa sleep dan filesystem lokalnya tidak persisten; sesi WhatsApp bisa ikut hilang saat redeploy/restart.

Jangan commit `auth_info`, token, atau API key.
