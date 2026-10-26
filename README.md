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

Bot dijawab juga untuk pesan yang dikirim dari nomor yang sama dengan nomor bot (chat ke diri sendiri), karena pesan seperti itu ditandai `fromMe` oleh Baileys. Kirim perintah dari chat nomor tersebut.

## Test
- `npm test` → self-check filter pesan masuk (`test/should-handle-message.test.mjs`).

## Main catur online
1. Kirim `.chess` di chat pribadi atau grup WhatsApp.
2. Bot membalas dengan link game. Kedua pemain buka link yang sama.
3. Pemain pertama yang menekan Gabung jadi Putih; pemain kedua jadi Hitam.
4. Langkah divalidasi server dan papan disiarkan realtime ke kedua browser. Tap bidak lalu kotak tujuan.

Game berjalan di browser, bukan sebagai papan interaktif langsung di dalam tampilan chat WhatsApp. Kedua pemain perlu membuka link tersebut. Game disimpan di memori server, jadi akan hilang saat server restart atau tidur. Render Free bisa sleep dan filesystem lokalnya tidak persisten; sesi WhatsApp bisa ikut hilang saat redeploy/restart.

## Catatan Render
- Render Free me-spin-down web service setelah 15 menit tanpa traffic dan **menghapus semua yang ditulis ke disk** saat itu (termasuk `auth_info`). Itulah penyebab status berubah jadi "belum terhubung" setelah refresh. App ini otomatis ping URL publiknya sendiri setiap 8 menit supaya service tetap aktif dan sesi tidak hilang.
- Ping itu tidak menyelamatkan saat **redeploy** atau instance dipindah. Untuk itu, jalankan di plan berbayar dan pasang **Persistent Disk**, lalu set `AUTH_DIR=/var/data/auth_info`.
- Saat pertama deploy atau setelah redeploy, status akan berbunyi "Sesi WhatsApp tidak ditemukan..." — masukkan nomor lalu pairing ulang.

Jangan commit `auth_info`, token, atau API key.
