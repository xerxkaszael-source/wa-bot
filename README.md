# Baileys Web Pairing + Realtime Chess

Bot WhatsApp memakai fork `github:PrasszTzy66/Bail`, halaman pairing code, perintah chat, dan game catur web realtime.

## Deploy di Render
- Build command: `npm install`
- Start command: `npm start`
- Node.js 20 atau lebih baru.
- Set `APP_URL` ke URL publik service Render (mis. `https://nama-service.onrender.com`). Jika tidak diatur, kode mencoba `RENDER_EXTERNAL_URL`.
- Opsional: set `PAIRING_TOKEN` ke secret acak untuk melindungi endpoint pairing.
- Setelah ganti `package.json`, gunakan **Manual Deploy → Clear build cache & deploy**.

## Library
`@innovatorssoft/baileys` (npm, v7.x) — fork Baileys yang punya `sendRichHtml` (papan & leaderboard dirender sebagai halaman HTML di dalam gelembung chat), `sendTable`, `sendList`, `captureUnifiedResponse`.

Catatan:
- Fork sebelumnya (`@xrelly-stack/bails` / github.com/Xrelly-stack/xbailz) **di-drop**. Spec `github:owner/repo` tidak bisa di-install di mesin ini (npm mengubahnya jadi `ssh://git@github.com/...` → `Permission denied (publickey)`), dan fork itu tidak punya `sendRichHtml`. `@innovatorssoft/baileys` ada di npm, jadi install normal dan aman untuk Render.
- `sendRichHtml` dirender lewat GenAI HTML primitive (`trusted_sources` = daftar origin yang diizinkan). **Tidak ada jembatan klik balik** di fork manapun — semua contoh HTML di repo memakai `FOAHtmlPrimitiveDemoDONOTUSE` dan tidak ada `postMessage`/`fetch`. Karena itu langkah di kirim lewat HTTP callback ke `/chess/move` (token per game), dengan fallback ketik langkah.
- `syncFullHistory: false` **adalah default yang benar** di fork ini; jangan dipaksa `true`.
- `fetchLatestWAWebVersion` tidak diekspor; versi WA Web mengikuti default fork.

## Riwayat chat
Fork ini tidak mengirim event `messaging-history.status`, dan `syncFullHistory: false` (default) memang mematikan sinkronisasi riwayat — itu perilaku yang benar untuk bot, bukan error. Kalau bot tampak "macet" setelah pairing, cek Render Logs untuk baris `[WA] Connection open` / `[WA] Connection closed`.

## participant (kirim sebagai konteks grup)
`relayMessage(jid, content, { participant: { jid } })` — `participant` menerima JID maupun username (diresolusi otomatis), dan dipakai untuk mengirim dengan konteks device peserta tertentu. Tidak ada flag `ptcp` yang bisa diset langsung di fork ini.

## Commands
- `ping`, `.ping`, `/ping`, `!ping` → `Pong! Bot aktif ✅`
- `menu`, `.menu`, `/menu`, `!menu` → daftar perintah
- `chess`, `.chess`, `/chess`, `!chess` → buat game + lobby pilih waktu
- `chesshelp` → petunjuk main
- `elo`, `.elo` → rating ELO kamu
- `top`, `.top`, `ranking` → papan peringkat ELO (10 teratas)

Bot dijawab juga untuk pesan yang dikirim dari nomor yang sama dengan nomor bot (chat ke diri sendiri), karena pesan seperti itu ditandai `fromMe` oleh Baileys. Kirim perintah dari chat nomor tersebut.

### Pemilik (owner)
Set `OWNER_NUMBER` (format internasional, angka saja) untuk membatasi **perintah** hanya ke nomor itu. Permainan tidak dibatasi: siapa pun di chat yang sama bisa memakai langkah, jadi game tetap 2 pemain online. Contoh `.env` lokal:

```
OWNER_NUMBER=447463445574
PAIRING_TOKEN=change-me-to-a-long-random-secret   # opsional
```

## Main catur online
1. Kirim `.chess` di chat pribadi atau grup WhatsApp.
2. Papan muncul di chat itu sebagai halaman HTML (tap bidak → tap tujuan) plus jam.
3. Dua pemain memilih waktu dengan membalas `1`, `10`, atau `15`. Kalau pilihannya sama, jam mulai; kalau beda, keduanya diminta memilih lagi.
4. Giliran bergantian. Langkah bisa lewat tap pada papan, atau diketik (`e2e4`, promosi `e7e8q`).
5. Waktu habis = kalah. Skakmat/remis dihitung otomatis. Papan + jam diperbarui di chat tiap langkah.
6. Versi tap-bidak di browser tetap tersedia lewat link yang dikirim.

### Rating ELO
Dihitung tiap game selesai (K=32, rating awal 1000), disimpan ke `elo.json`, dan dibuat per game hanya kalau kedua pemain dikenal. Menang +, kalah −, remis setengah. `elo.json` sengaja tidak di-commit.

## Test
- `npm test` → self-check filter pesan masuk + validasi papan/langkah/jam/ELO (`test/should-handle-message.test.mjs`).

## Catatan Render
- Render Free me-spin-down web service setelah 15 menit tanpa traffic dan **menghapus semua yang ditulis ke disk** saat itu (termasuk `auth_info`). Itulah penyebab status berubah jadi "belum terhubung" setelah refresh. App ini otomatis ping URL publiknya sendiri setiap 8 menit supaya service tetap aktif dan sesi tidak hilang.
- Ping itu tidak menyelamatkan saat **redeploy** atau instance dipindah. Untuk itu, jalankan di plan berbayar dan pasang **Persistent Disk**, lalu set `AUTH_DIR=/var/data/auth_info`.
- Saat pertama deploy atau setelah redeploy, status akan berbunyi "Sesi WhatsApp tidak ditemukan..." — masukkan nomor lalu pairing ulang.

Jangan commit `auth_info`, token, atau API key.
