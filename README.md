<p align="center">
  <img src="https://img.shields.io/badge/WhatsApp_Bot-25D366?style=for-the-badge&logo=whatsapp&logoColor=white" alt="WhatsApp Bot" />
  <img src="https://img.shields.io/badge/Chess-000000?style=for-the-badge&logo=chess.com&logoColor=white" alt="Chess" />
  <img src="https://img.shields.io/badge/Render-46E3B7?style=for-the-badge&logo=render&logoColor=white" alt="Render" />
</p>

<h1 align="center">♟️ WA Bot — Chess + Media Downloader</h1>

<p align="center">
  Bot WhatsApp self-hosted dengan game catur realtime, rating ELO, dan downloader media TikTok/YouTube/Instagram.<br />
  Deploy di Render, pairing via web, tanpa database.
</p>

---

## ✨ Fitur

| Fitur | Deskripsi |
|-------|-----------|
| **Pairing via Web** | Scan QR atau masukkan nomor langsung — tidak perlu terminal |
| **Catur Realtime** | Game catur 2 pemain di dalam chat WhatsApp dengan papan HTML interaktif |
| **Rating ELO** | Sistem rating ELO (K=32) dengan leaderboard otomatis |
| **Media Downloader** | Download video/audio dari TikTok, YouTube, Instagram langsung via chat |
| **Allowlist** | Akses kontrol — hanya nomor yang diizinkan bisa menggunakan bot |
| **Cloudflare Tunnel** | Auto tunnel untuk development lokal — publik URL otomatis |
| **Keep-Alive** | Self-ping setiap 8 menit agar Render Free tidak sleep |

---

## 🚀 Quick Start

### Prerequisites

- Node.js >= 20
- yt-dlp (`pip install yt-dlp`)
- ffmpeg (untuk proses media, opsional untuk download-only)

### Deploy di Render

1. Fork / clone repo ini
2. Buat **Web Service** baru di Render dengan settings:

| Setting | Value |
|---------|-------|
| **Build Command** | `npm install` |
| **Start Command** | `npm start` |
| **Node Version** | `20.x` atau lebih baru |

3. Set environment variables:

| Variable | Required | Value |
|----------|----------|-------|
| `APP_URL` | Ya | URL publik Render (mis. `https://nama-service.onrender.com`) |
| `PAIRING_TOKEN` | No | Secret acak untuk proteksi endpoint pairing |
| `OWNER_NUMBER` | No | Nomor admin (format internasional, tanpa `+`) |
| `YTDLP_PATH` | No | Path ke `yt-dlp` jika bukan di PATH |
| `YT_DLP_TIMEOUT_MS` | No | Timeout download (default: `120000` = 2 menit) |

4. **Manual Deploy → Clear build cache & deploy**

> ⚠️ Render Free tier spin-down setelah 15 menit tanpa traffic. Bot sudah auto-ping setiap 8 menit untuk mencegah sleep.

---

## 🎮 Commands

| Command | Deskripsi |
|---------|-----------|
| `.ping` | Cek apakah bot aktif |
| `.menu` | Tampilkan daftar perintah |
| `.download <url>` | Download video/audio dari TikTok, YouTube, Instagram |
| `.chess` | Buat game catur baru di chat |
| `.chess <username>` | Lihat profil Chess.com |
| `.chesshelp` | Cara main catur online |
| `.elo` | Lihat rating ELO kamu |
| `.top` | Papan peringkat ELO (10 teratas) |

### Admin Commands

| Command | Deskripsi |
|---------|-----------|
| `.allowlist <nomor>` | Izinkan nomor menggunakan bot |
| `.delallow <nomor>` | Hapus nomor dari allowlist |
| `.listallow` | Lihat daftar nomor yang diizinkan |

---

## ♟️ Cara Main Catur Online

1. Kirim `.chess` di chat pribadi atau grup WhatsApp.
2. Papan muncul di chat sebagai halaman HTML interaktif (tap bidak → tap tujuan).
3. Dua pemain memilih waktu dengan membalas `1`, `10`, atau `15` menit.
4. Kalau pilihan sama, jam langsung mulai. Giliran bergantian.
5. Langkah bisa lewat tap pada papan, atau diketik (`e2e4`, promosi `e7e8q`).
6. Waktu habis = kalah. Skakmat/remis dihitung otomatis.

> 💡 Papan dan leaderboard dikirim sebagai Rich HTML di dalam bubble chat WhatsApp.

---

## 🛠️ Tech Stack

<p align="left">
  <img src="https://img.shields.io/badge/Node.js-20+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js" />
  <img src="https://img.shields.io/badge/Express-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
  <img src="https://img.shields.io/badge/Socket.IO-010101?style=for-the-badge&logo=socket.io&logoColor=white" alt="Socket.IO" />
  <img src="https://img.shields.io/badge/yt--dlp-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="yt-dlp" />
  <img src="https://img.shields.io/badge/Chess.js-000000?style=for-the-badge&logo=chess.com&logoColor=white" alt="Chess.js" />
</p>

| Library | Fungsi |
|---------|--------|
| `@innovatorssoft/baileys` | WhatsApp Web API (fork dengan `sendRichHtml`) |
| `express` | HTTP server untuk pairing web + callback chess |
| `socket.io` | Realtime sync state catur antar pemain |
| `chess.js` | Logika dan validasi rule catur |
| `yt-dlp` | Ekstraksi media dari TikTok/YouTube/Instagram |
| `cloudflared` | Tunnel HTTPS untuk development lokal |

---

## 📁 Struktur Project

```
wa-bot/
├── index.js            # Entry point: socket, commands, chess engine
├── boardpng.js         # Generate PNG board catur
├── chessprofile.js     # Scrape profil Chess.com
├── public/             # Static assets (chess.html, index.html)
├── test/               # Unit tests
├── auth_info/          # Session WhatsApp (git-ignored)
├── .env                # Konfigurasi lokal (git-ignored)
├── package.json
└── README.md
```

---

## 🧪 Test

```bash
npm test
```

Menjalankan self-check untuk:
- Filter pesan masuk (`shouldHandleMessage`)
- Validasi board/langkah/jam/ELO catur

---

## ⚠️ Catatan Penting

- **Render Free**: Data di disk (`auth_info`, `elo.json`) **akan hilang** saat spin-down atau redeploy. Gunakan **Persistent Disk** + plan berbayar jika ingin sesi permanen.
- **Instagram**: Beberapa post memerlukan cookies/login. Jika download gagal, coba link TikTok/YouTube terlebih dahulu.
- **File Size**: Download dibatasi 100MB untuk mencegah timeout WhatsApp.
- **Allowlist**: Jika `OWNER_NUMBER` di-set, hanya owner yang bisa mengubah allowlist. Semua orang tetap bisa main catur di chat yang sama.

---

<p align="center">
  Dibuat dengan ♟️ dan ☕ untuk komunitas catur WhatsApp
</p>
