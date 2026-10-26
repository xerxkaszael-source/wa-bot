import express from 'express';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason
} from '@whiskeysockets/baileys';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const PAIRING_TOKEN = process.env.PAIRING_TOKEN || '';
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });

app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

let sock = null;
let connecting = false;
let connected = false;
let lastStatus = 'Belum terhubung';
let pairingCode = null;
let lastPairAttempt = 0;
let retryTimer = null;

function statusPayload() {
  return {
    connected,
    connecting,
    status: lastStatus,
    pairingCode: pairingCode || null
  };
}

function checkToken(req, res, next) {
  // Set PAIRING_TOKEN in Render Environment to protect the pairing page/API.
  if (PAIRING_TOKEN && req.get('x-pairing-token') !== PAIRING_TOKEN) {
    return res.status(401).json({ error: 'Token akses salah.' });
  }
  next();
}

async function startSocket(phoneNumber = null) {
  if (connecting || connected) {
    throw new Error(connected ? 'WhatsApp sudah terhubung.' : 'Bot sedang memulai koneksi.');
  }

  connecting = true;
  lastStatus = 'Menyiapkan koneksi WhatsApp...';
  pairingCode = null;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Simple Web Pairing Bot', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
      if (connection === 'open') {
        connected = true;
        connecting = false;
        pairingCode = null;
        lastStatus = 'WhatsApp terhubung';
      } else if (connection === 'close') {
        connected = false;
        connecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastStatus = code === DisconnectReason.loggedOut
          ? 'Sesi logout. Hapus sesi melalui endpoint reset lalu pairing ulang.'
          : 'Koneksi terputus. Coba mulai pairing ulang jika tidak tersambung kembali.';

        if (code !== DisconnectReason.loggedOut && !retryTimer) {
          retryTimer = setTimeout(() => {
            retryTimer = null;
            startSocket().catch(err => {
              connecting = false;
              lastStatus = `Gagal menyambung ulang: ${err.message}`;
            });
          }, 5000);
        }
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const body =
          msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ??
          '';
        const command = body.trim().toLowerCase();

        if (command === 'ping') {
          await sock.sendMessage(jid, { text: 'Pong! Bot aktif ✅' });
        } else if (command === 'menu') {
          await sock.sendMessage(jid, {
            text: '*MENU BOT*\\n\\n• ping — cek bot\\n• menu — tampilkan menu'
          });
        }
      }
    });

    if (!state.creds.registered) {
      if (!phoneNumber) {
        connecting = false;
        lastStatus = 'Sesi belum tertaut. Masukkan nomor WhatsApp untuk pairing.';
        return;
      }

      // Give the socket a moment to initialize before requesting the code.
      await new Promise(resolve => setTimeout(resolve, 1500));
      const code = await sock.requestPairingCode(phoneNumber);
      pairingCode = String(code);
      lastStatus = 'Kode pairing siap. Masukkan di WhatsApp pada Perangkat Tertaut.';
      connecting = false;
    } else {
      lastStatus = 'Sesi tersimpan ditemukan; menunggu WhatsApp tersambung...';
    }
  } catch (error) {
    connecting = false;
    lastStatus = `Gagal: ${error.message}`;
    throw error;
  }
}

app.get('/api/status', checkToken, (_req, res) => {
  res.json(statusPayload());
});

app.post('/api/pair', checkToken, async (req, res) => {
  const now = Date.now();
  if (now - lastPairAttempt < 15000) {
    return res.status(429).json({ error: 'Tunggu 15 detik sebelum mencoba lagi.' });
  }
  lastPairAttempt = now;

  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Masukkan nomor internasional dengan kode negara, angka saja. Contoh Indonesia: 628123456789.' });
  }
  if (connected) return res.status(409).json({ error: 'WhatsApp sudah terhubung.' });
  if (connecting) return res.status(409).json({ error: 'Bot sedang memulai koneksi. Tunggu sebentar.' });

  try {
    await startSocket(phone);
    res.json(statusPayload());
  } catch (error) {
    res.status(500).json({ error: error.message, ...statusPayload() });
  }
});

app.post('/api/reset', checkToken, async (_req, res) => {
  try {
    if (sock) {
      try { sock.end(undefined); } catch {}
      sock = null;
    }
    connected = false;
    connecting = false;
    pairingCode = null;
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    lastStatus = 'Sesi lokal dihapus. Masukkan nomor untuk pairing ulang.';
    res.json(statusPayload());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Web pairing app listening on port ${PORT}`);
  // If an auth session already exists, try reconnecting it automatically.
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    try {
      await startSocket();
    } catch (error) {
      console.error('Auto reconnect failed:', error.message);
    }
  }
});
