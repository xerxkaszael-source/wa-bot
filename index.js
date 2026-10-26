import baileys from '@whiskeysockets/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import { Chess } from 'chess.js';

// The requested fork may be published as CommonJS; normalize its exports.
const makeWASocket = typeof baileys === 'function' ? baileys : (baileys.default || baileys.makeWASocket);
const { useMultiFileAuthState, DisconnectReason } = baileys;
if (typeof makeWASocket !== 'function') throw new Error('Baileys socket export not found in github:PrasszTzy66/Bail');

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true }, transports: ['websocket', 'polling'] });
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const PAIRING_TOKEN = process.env.PAIRING_TOKEN || '';
const APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

let sock = null, connecting = false, connected = false;
let lastStatus = 'Belum terhubung', pairingCode = null, lastPairAttempt = 0, retryTimer = null, reconnecting = false;
const games = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function statusPayload() { return { connected, connecting, status: lastStatus, pairingCode }; }
function checkToken(req, res, next) {
  if (PAIRING_TOKEN && req.get('x-pairing-token') !== PAIRING_TOKEN) return res.status(401).json({ error: 'Token akses salah.' });
  next();
}
function messageText(message) {
  let m = message;
  for (let i = 0; i < 5 && m; i++) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    break;
  }
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || m?.documentMessage?.caption || '';
}
function gameStatus(game) {
  const chess = game.chess;
  let status = 'Permainan berlangsung';
  if (chess.isCheckmate()) status = `Skakmat! ${chess.turn() === 'w' ? 'Hitam' : 'Putih'} menang.`;
  else if (chess.isDraw()) status = 'Remis.';
  else if (chess.isCheck()) status = 'Skak!';
  return {
    id: game.id, fen: chess.fen(), pgn: chess.pgn(), turn: chess.turn(), status,
    gameOver: chess.isGameOver(), check: chess.isCheck(), checkmate: chess.isCheckmate(), draw: chess.isDraw(),
    legalMoves: chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion || null })),
    players: game.players.map(p => p ? { name: p.name, color: p.color } : null), lastMove: game.lastMove
  };
}
function broadcastGame(game) { io.to(game.id).emit('game:state', gameStatus(game)); }
function createGame() {
  const id = crypto.randomBytes(5).toString('hex');
  const game = { id, chess: new Chess(), players: [null, null], sockets: new Map(), createdAt: Date.now(), lastMove: null };
  games.set(id, game);
  return game;
}
function sendMenu(jid) {
  return sock.sendMessage(jid, { text: '*MENU BOT*\n\n• ping / .ping / !ping — cek bot\n• menu / .menu / !menu — tampilkan menu\n• chess / .chess / !chess — buat game catur online\n• chesshelp — cara bermain catur' });
}
async function handleCommand(currentSock, jid, rawBody) {
  const body = rawBody.trim();
  if (!body) return;
  // Accept plain commands and common prefixes, regardless of case.
  const match = body.match(/^[.!/](ping|menu|chess|chesshelp)\b\s*(.*)$/i) || body.match(/^(ping|menu|chess|chesshelp)\b\s*(.*)$/i);
  if (!match) return;
  const command = match[1].toLowerCase();
  if (command === 'ping') {
    await currentSock.sendMessage(jid, { text: 'Pong! Bot aktif ✅' });
  } else if (command === 'menu') {
    await sendMenu(jid);
  } else if (command === 'chesshelp') {
    await currentSock.sendMessage(jid, { text: '*CARA MAIN CATUR ONLINE* ♟️\n1. Kirim .chess di chat pribadi atau grup.\n2. Bot mengirim satu link game ke chat itu.\n3. Dua pemain buka link yang sama. Pemain pertama jadi Putih, pemain kedua jadi Hitam.\n4. Main bergantian di browser; papan diperbarui realtime.\n\nPerintah: .chess, .ping, .menu\nCatatan: game tersimpan di memori server dan bisa hilang saat Render restart/tidur.' });
  } else if (command === 'chess') {
    const game = createGame();
    const url = `${APP_URL}/chess.html?game=${game.id}`;
    await currentSock.sendMessage(jid, { text: `♟️ *GAME CATUR ONLINE DIBUAT!*\n\nKirim/buka link ini bersama teman di chat ini:\n${url}\n\nPemain pertama yang masuk jadi Putih, pemain kedua jadi Hitam. Game berjalan realtime selama server aktif.\n\nKetik .chesshelp untuk cara bermain.` });
  }
}

async function startSocket(phoneNumber = null) {
  if (connecting || connected) throw new Error(connected ? 'WhatsApp sudah terhubung.' : 'Koneksi sedang dimulai, tunggu sebentar.');
  connecting = true; lastStatus = 'Menyiapkan koneksi WhatsApp...'; pairingCode = null;
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const currentSock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: ['Ubuntu', 'Chrome', '20.00.1'], markOnlineOnConnect: false, syncFullHistory: false });
    sock = currentSock;
    currentSock.ev.on('creds.update', saveCreds);
    let qrSeenResolve;
    const qrSeen = new Promise(resolve => { qrSeenResolve = resolve; });
    let closeHandled = false;
    currentSock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (qr) qrSeenResolve();
      if (connection === 'open') { connected = true; connecting = false; reconnecting = false; pairingCode = null; lastStatus = 'WhatsApp terhubung'; }
      if (connection === 'close' && !closeHandled) {
        closeHandled = true; connected = false; connecting = false;
        const code = lastDisconnect?.error?.output?.statusCode;
        lastStatus = code === DisconnectReason.loggedOut ? 'Sesi logout. Reset sesi lalu pairing ulang.' : `Koneksi terputus (${code ?? 'unknown'}). Mencoba menyambung ulang...`;
        if (code !== DisconnectReason.loggedOut && !retryTimer) {
          retryTimer = setTimeout(async () => { retryTimer = null; if (reconnecting) return; reconnecting = true; try { await startSocket(); } catch (err) { reconnecting = false; connecting = false; lastStatus = `Gagal menyambung ulang: ${err.message}`; } }, code === DisconnectReason.restartRequired ? 500 : 3000);
        }
      }
    });
    currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        const jid = msg.key.remoteJid;
        if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) continue;
        try { await handleCommand(currentSock, jid, messageText(msg.message)); }
        catch (err) { logger.error({ err: err.message }, 'Command handler failed'); }
      }
    });
    if (!state.creds.registered && phoneNumber) {
      lastStatus = 'Menunggu socket siap untuk meminta kode pairing...';
      await Promise.race([qrSeen, wait(15000).then(() => { throw new Error('Socket belum siap (event QR tidak diterima). Coba lagi beberapa saat.'); })]);
      if (sock !== currentSock) throw new Error('Socket telah diganti. Coba minta kode lagi.');
      pairingCode = String(await currentSock.requestPairingCode(phoneNumber));
      lastStatus = 'Kode pairing siap. Masukkan di WhatsApp → Perangkat tertaut → Tautkan dengan nomor telepon.';
      connecting = false;
    } else if (!state.creds.registered) { connecting = false; lastStatus = 'Belum tertaut. Masukkan nomor WhatsApp untuk meminta kode.'; }
    else lastStatus = 'Sesi tersimpan ditemukan; menunggu WhatsApp tersambung...';
  } catch (error) { connecting = false; lastStatus = `Gagal: ${error.message}`; throw error; }
}

app.get('/healthz', (_req, res) => res.json({ ok: true, connected, games: games.size }));
app.get('/api/status', checkToken, (_req, res) => res.json(statusPayload()));
app.post('/api/pair', checkToken, async (req, res) => {
  if (Date.now() - lastPairAttempt < 15000) return res.status(429).json({ error: 'Tunggu 15 detik sebelum mencoba lagi.' });
  lastPairAttempt = Date.now();
  const phone = String(req.body?.phone || '').replace(/\D/g, '');
  if (phone.length < 8 || phone.length > 15) return res.status(400).json({ error: 'Masukkan nomor internasional dengan kode negara, angka saja. Contoh: 628123456789.' });
  if (connected) return res.status(409).json({ error: 'WhatsApp sudah terhubung.' });
  if (connecting) return res.status(409).json({ error: 'Koneksi sedang dimulai. Tunggu sebentar.' });
  try { await startSocket(phone); res.json(statusPayload()); }
  catch (error) { res.status(500).json({ error: error.message, ...statusPayload() }); }
});
app.post('/api/reset', checkToken, (_req, res) => {
  try {
    if (retryTimer) clearTimeout(retryTimer); retryTimer = null;
    if (sock) { try { sock.end(undefined); } catch {} sock = null; }
    connected = false; connecting = false; reconnecting = false; pairingCode = null;
    fs.rmSync(AUTH_DIR, { recursive: true, force: true }); lastStatus = 'Sesi lokal dihapus. Masukkan nomor untuk pairing ulang.'; res.json(statusPayload());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

io.on('connection', socket => {
  socket.on('game:join', ({ gameId, name } = {}, callback = () => {}) => {
    const game = games.get(String(gameId || ''));
    if (!game) return callback({ ok: false, error: 'Game tidak ditemukan atau server baru saja restart. Buat game baru dengan .chess.' });
    const existing = game.sockets.get(socket.id);
    if (existing) return callback({ ok: true, color: existing.color, state: gameStatus(game) });
    let slot = game.players.findIndex(p => p && p.socketId === socket.id);
    if (slot < 0) slot = game.players.findIndex(p => !p);
    if (slot < 0) return callback({ ok: false, error: 'Game sudah penuh (2 pemain). Minta link game baru.' });
    const color = slot === 0 ? 'w' : 'b';
    const player = { socketId: socket.id, name: String(name || (color === 'w' ? 'Putih' : 'Hitam')).slice(0, 24), color };
    game.players[slot] = player; game.sockets.set(socket.id, player);
    socket.join(game.id); socket.data.gameId = game.id;
    callback({ ok: true, color, state: gameStatus(game) });
    broadcastGame(game);
  });
  socket.on('game:move', ({ gameId, from, to, promotion } = {}, callback = () => {}) => {
    const game = games.get(String(gameId || socket.data.gameId || ''));
    const player = game?.sockets.get(socket.id);
    if (!game || !player) return callback({ ok: false, error: 'Gabung game dulu.' });
    if (game.chess.isGameOver()) return callback({ ok: false, error: 'Permainan sudah selesai.' });
    if (game.chess.turn() !== player.color) return callback({ ok: false, error: 'Belum giliranmu.' });
    try {
      const move = game.chess.move({ from, to, promotion: promotion || 'q' });
      game.lastMove = { from: move.from, to: move.to, san: move.san };
      broadcastGame(game); callback({ ok: true, state: gameStatus(game) });
    } catch { callback({ ok: false, error: 'Langkah tidak valid.' }); }
  });
  socket.on('game:reset', ({ gameId } = {}, callback = () => {}) => {
    const game = games.get(String(gameId || socket.data.gameId || ''));
    const player = game?.sockets.get(socket.id);
    if (!game || !player) return callback({ ok: false, error: 'Gabung game dulu.' });
    game.chess.reset(); game.lastMove = null; broadcastGame(game); callback({ ok: true });
  });
  socket.on('disconnect', () => {
    for (const game of games.values()) {
      const player = game.sockets.get(socket.id);
      if (player) { game.sockets.delete(socket.id); const slot = game.players.findIndex(p => p?.socketId === socket.id); if (slot >= 0) game.players[slot] = null; broadcastGame(game); }
    }
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Web pairing + realtime chess app listening on port ${PORT}; APP_URL=${APP_URL}`);
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    try { await startSocket(); } catch (error) { console.error('Auto reconnect failed:', error.message); }
  }
});
