import express from 'express';
import baileysPkg from '@whiskeysockets/baileys';

// Compatible with forks that publish Baileys as CommonJS.
const makeWASocket = baileysPkg.default || baileysPkg.makeWASocket || baileysPkg;
const { useMultiFileAuthState, DisconnectReason } = baileysPkg;
import pino from 'pino';
import fs from 'node:fs';

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
let reconnecting = false;

function statusPayload() {
  return { connected, connecting, status: lastStatus, pairingCode };
}

function checkToken(req, res, next) {
  if (PAIRING_TOKEN && req.get('x-pairing-token') !== PAIRING_TOKEN) {
    return res.status(401).json({ error: 'Token akses salah.' });
  }
  next();
}

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function startSocket(phoneNumber = null) {
  if (connecting || connected) {
    throw new Error(connected ? 'WhatsApp sudah terhubung.' : 'Koneksi sedang dimulai, tunggu sebentar.');
  }
  connecting = true;
  lastStatus = 'Menyiapkan koneksi WhatsApp...';
  pairingCode = null;

  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // Do not call fetchLatestWAWebVersion here: the requested fork does not
    // necessarily export it. Let the fork use its own default WA Web version.
    const currentSock = makeWASocket({
      auth: state,
      logger,
      printQRInTerminal: false,
      browser: ['Ubuntu', 'Chrome', '20.00.1'],
      markOnlineOnConnect: false,
      syncFullHistory: false
    });
    sock = currentSock;
    currentSock.ev.on('creds.update', saveCreds);

    let qrSeenResolve;
    const qrSeen = new Promise(resolve => { qrSeenResolve = resolve; });
    let closeHandled = false;

    currentSock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      // Baileys uses the QR update internally as a signal that the socket is ready
      // for requestPairingCode; we do not display the QR itself.
      if (qr) qrSeenResolve();

      if (connection === 'open') {
        connected = true;
        connecting = false;
        reconnecting = false;
        pairingCode = null;
        lastStatus = 'WhatsApp terhubung';
      }

      if (connection === 'close' && !closeHandled) {
        closeHandled = true;
        connected = false;
        connecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastStatus = code === DisconnectReason.loggedOut
          ? 'Sesi logout. Reset sesi lalu pairing ulang.'
          : `Koneksi terputus (${code ?? 'unknown'}). Mencoba menyambung ulang...`;

        if (code !== DisconnectReason.loggedOut && !retryTimer) {
          retryTimer = setTimeout(async () => {
            retryTimer = null;
            if (reconnecting) return;
            reconnecting = true;
            try {
              await startSocket();
            } catch (err) {
              reconnecting = false;
              connecting = false;
              lastStatus = `Gagal menyambung ulang: ${err.message}`;
            }
          }, code === DisconnectReason.restartRequired ? 500 : 3000);
        }
      }
    });

    currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        const body = msg.message.conversation ??
          msg.message.extendedTextMessage?.text ??
          msg.message.imageMessage?.caption ?? '';
        const command = body.trim().toLowerCase();
        if (command === 'ping') {
          await currentSock.sendMessage(jid, { text: 'Pong! Bot aktif ✅' });
        } else if (command === 'menu') {
          await currentSock.sendMessage(jid, { text: '*MENU BOT*\\n\\n• ping — cek bot\\n• menu — tampilkan menu' });
        }
      }
    });

    if (!state.creds.registered && phoneNumber) {
      lastStatus = 'Menunggu socket siap untuk meminta kode pairing...';
      // Official Baileys examples advise waiting for the initial QR update before requesting code.
      await Promise.race([
        qrSeen,
        wait(15000).then(() => { throw new Error('Socket belum siap (event QR tidak diterima). Coba lagi beberapa saat.'); })
      ]);
      if (sock !== currentSock) throw new Error('Socket telah diganti. Coba minta kode lagi.');
      const code = await currentSock.requestPairingCode(phoneNumber);
      pairingCode = String(code);
      lastStatus = 'Kode pairing siap. Masukkan di WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon.';
      connecting = false;
    } else if (!state.creds.registered) {
      connecting = false;
      lastStatus = 'Belum tertaut. Masukkan nomor WhatsApp untuk meminta kode.';
    } else {
      lastStatus = 'Sesi tersimpan ditemukan; menunggu WhatsApp tersambung...';
    }
  } catch (error) {
    connecting = false;
    lastStatus = `Gagal: ${error.message}`;
    throw error;
  }
}

app.get('/api/status', checkToken, (_req, res) => res.json(statusPayload()));

app.post('/api/pair', checkToken, async (req, res) => {
  if (Date.now() - lastPairAttempt < 15000) {
    return res.status(429).json({ error: 'Tunggu 15 detik sebelum mencoba lagi.' });
  }
  lastPairAttempt = Date.now();
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) {
    return res.status(400).json({ error: 'Masukkan nomor internasional dengan kode negara, angka saja. Contoh Indonesia: 628123456789.' });
  }
  if (connected) return res.status(409).json({ error: 'WhatsApp sudah terhubung.' });
  if (connecting) return res.status(409).json({ error: 'Koneksi sedang dimulai. Tunggu sebentar.' });

  try {
    await startSocket(phone);
    res.json(statusPayload());
  } catch (error) {
    res.status(500).json({ error: error.message, ...statusPayload() });
  }
});

app.post('/api/reset', checkToken, (_req, res) => {
  try {
    if (retryTimer) clearTimeout(retryTimer);
    retryTimer = null;
    if (sock) {
      try { sock.end(undefined); } catch {}
      sock = null;
    }
    connected = false;
    connecting = false;
    reconnecting = false;
    pairingCode = null;
    fs.rmSync(AUTH_DIR, { recursive: true, force: true });
    lastStatus = 'Sesi lokal dihapus. Masukkan nomor untuk pairing ulang.';
    res.json(statusPayload());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`Web pairing app listening on port ${PORT}`);
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    try { await startSocket(); }
    catch (error) { console.error('Auto reconnect failed:', error.message); }
  }
});
