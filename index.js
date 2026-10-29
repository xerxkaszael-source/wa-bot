// @innovatorssoft/baileys is CommonJS: the default import is the module object.
import baileys from '@innovatorssoft/baileys';
import express from 'express';
import pino from 'pino';
import fs from 'node:fs';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Server as SocketIOServer } from 'socket.io';
import { Chess } from 'chess.js';
import ffmpegPath from 'ffmpeg-static';
import { boardPNG } from './boardpng.js';
import { fetchChessProfile, profileHtml, profileText } from './chessprofile.js';

const makeWASocket = typeof baileys === 'function' ? baileys : (baileys.default || baileys.makeWASocket);
const { useMultiFileAuthState, DisconnectReason, Browsers, generateWAMessageFromContent, generateMessageID } = baileys;
if (typeof makeWASocket !== 'function') throw new Error('Baileys socket export not found in @innovatorssoft/baileys');

// Minimal .env loader so local runs can set OWNER_NUMBER/PAIRING_TOKEN without a
// dependency; real environment variables always win.
for (const line of (fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
}

const app = express();
const server = http.createServer(app);
const io = new SocketIOServer(server, { cors: { origin: true }, transports: ['websocket', 'polling'] });
const PORT = Number(process.env.PORT || 3000);
const AUTH_DIR = process.env.AUTH_DIR || './auth_info';
const PAIRING_TOKEN = process.env.PAIRING_TOKEN || '';
// Owner gate: when set, only this number (international format, digits only) may
// use the bot's commands. Other senders get a polite refusal instead.
const OWNER_NUMBER = String(process.env.OWNER_NUMBER || '').replace(/\D/g, '');
// GenAI HTML mini-apps (in-chat interactive board) only render on clients with
// Meta AI support; elsewhere (e.g. WhatsApp Business on iOS) they show as an empty
// "Forwarded" bubble. Default is the universally-supported image board instead;
// enable the HTML bubble with RICH_HTML=1.
const RICH_HTML = String(process.env.RICH_HTML ?? '0') !== '0';
// Primary URL (Render / explicit APP_URL). A second public URL via a Cloudflare
// quick tunnel is started automatically below for local runs; appUrl() always
// returns the freshest usable URL, so board links and in-page fetches survive
// even when only the tunnel is reachable from a phone (localhost never is).
let APP_URL = (process.env.APP_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TUNNEL_ENABLED = String(process.env.CLOUDFLARE_TUNNEL ?? '1') !== '0';
const LOCAL = /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(APP_URL);
// tunnelUrl keeps the second (Cloudflare) URL; APP_URL is preferred when it is
// already public, otherwise the tunnel is the URL handed out to phones.
let tunnelUrl = null;
function appUrl() {
  if (tunnelUrl && LOCAL) return tunnelUrl;
  return APP_URL;
}
const logger = pino({ level: process.env.LOG_LEVEL || 'silent' });
app.use(express.json({ limit: '20kb' }));
app.use(express.static('public'));

let sock = null, connecting = false, connected = false;
let lastStatus = 'Belum terhubung', pairingCode = null, lastPairAttempt = 0, retryTimer = null, reconnecting = false;
let sessionWaitTimer = null;
const games = new Map();
const chatGames = new Map(); // chat jid -> game id, so moves can be typed straight into the chat
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

// --- media download (OmniDL-style: yt-dlp + gallery-dl extraction) ---
const YTDLP_RAW = process.env.YTDLP_PATH || 'yt-dlp';
const YTDLP = YTDLP_RAW.includes(' ') ? YTDLP_RAW.split(' ') : [YTDLP_RAW];
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || join(tmpdir(), 'wa-bot-downloads');
const YT_DLP_TIMEOUT = Number(process.env.YT_DLP_TIMEOUT_MS || 120000);
const YT_FORMAT = 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best';
const FFMPEG_PATH = ffmpegPath;
const YTDLP_COMMON = ['--no-warnings', '--force-ipv4', '--no-check-certificates'];

function ytDlpPlatformArgs(url) {
  if (/tiktok\.com|vt\.tiktok\.com/.test(url)) {
    return ['--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com'];
  }
  if (/youtube\.com|youtu\.be/.test(url)) {
    return [];
  }
  if (/instagram\.com/.test(url)) {
    // Instagram Reels only serve VP9; re-encode to H.264 so iPhone/WhatsApp can play it.
    return ['--postprocessor-args', 'ffmpeg:-c:v libx264 -crf 23 -preset fast -c:a aac -b:a 128k'];
  }
  return [];
}

function ensureDownloadDir() {
  try { fs.mkdirSync(DOWNLOAD_DIR, { recursive: true }); } catch {}
}

function spawnYtDlp(args) {
  return new Promise((resolve, reject) => {
    const cmd = YTDLP[0];
    const cmdArgs = [...YTDLP.slice(1), '--ffmpeg-location', FFMPEG_PATH, ...args];
    const child = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Download timeout'));
    }, YT_DLP_TIMEOUT);
    child.stdout.on('data', d => { stdout += d; });
    child.stderr.on('data', d => { stderr += d; });
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else {
        const msg = stderr.trim() || `yt-dlp exited ${code}`;
        const err = new Error(msg);
        err.code = code;
        reject(err);
      }
    });
  });
}

async function handleDownload(currentSock, jid, rawUrl) {
  const url = rawUrl.trim();
  if (!url) return;
  ensureDownloadDir();

  await currentSock.sendMessage(jid, { text: '⏳ Mengambil info media...' }).catch(() => {});

  let meta;
  try {
    const args = [...YTDLP_COMMON, ...ytDlpPlatformArgs(url), '-j', '-f', YT_FORMAT, '--', url];
    const json = await spawnYtDlp(args);
    meta = JSON.parse(json);
  } catch (err) {
    const reason = /login|sign in|cookie|private|age.restrict|empty media response/i.test(err.message)
      ? 'Post ini memerlukan login/privasi. Coba link public lain.'
      : `Gagal mengambil media: ${err.message}`;
    await currentSock.sendMessage(jid, { text: `❌ ${reason}` }).catch(() => {});
    return;
  }

  const ext = (meta.ext || '').toLowerCase();
  const isImage = ['jpg','jpeg','png','webp','avif','gif','bmp'].includes(ext);
  const title = (meta.title || 'Media').slice(0, 100);
  const fileName = `${crypto.randomUUID()}.${isImage ? 'jpg' : 'mp4'}`;
  const filePath = join(DOWNLOAD_DIR, fileName);

  await currentSock.sendMessage(jid, { text: `⏳ Mengunduh: ${title}...` }).catch(() => {});

  try {
    const args = [...YTDLP_COMMON, ...ytDlpPlatformArgs(url), '-o', filePath, '-f', YT_FORMAT, '--', url];
    await spawnYtDlp(args);
  } catch (err) {
    await currentSock.sendMessage(jid, { text: `❌ Gagal mengunduh: ${err.message}` }).catch(() => {});
    return;
  }

  try {
    const stats = fs.statSync(filePath);
    if (stats.size > 100 * 1024 * 1024) {
      await currentSock.sendMessage(jid, { text: '⚠️ File terlalu besar (>100MB).' }).catch(() => {});
      return;
    }
    if (isImage) {
      await currentSock.sendMessage(jid, { image: { url: filePath }, caption: title });
    } else {
      await currentSock.sendMessage(jid, { video: { url: filePath }, caption: title, mimetype: 'video/mp4' });
    }
  } catch (err) {
    await currentSock.sendMessage(jid, { text: `❌ Gagal kirim media: ${err.message}` }).catch(() => {});
  } finally {
    try { fs.unlinkSync(filePath); } catch {}
  }
}

function statusPayload() {
  const actuallyConnected = Boolean(connected && sock?.user);
  return { connected: actuallyConnected, connecting, status: lastStatus, pairingCode: actuallyConnected ? null : pairingCode, phone: sock?.user?.id || null };
}
// Re-arm the reconnect instead of dropping it: a single failed attempt used to
// leave the bot permanently offline until the next manual pairing.
function scheduleRetry(delayMs) {
  if (retryTimer) return;
  retryTimer = setTimeout(async () => {
    retryTimer = null;
    if (reconnecting) return;
    reconnecting = true;
    try { await startSocket(); }
    catch (err) {
      reconnecting = false; connecting = false; connected = false;
      lastStatus = `Gagal menyambung ulang: ${err.message}`;
      scheduleRetry(10000);
    }
  }, delayMs);
}
function clearSessionWaitTimer() {
  if (sessionWaitTimer) { clearTimeout(sessionWaitTimer); sessionWaitTimer = null; }
}
function checkToken(req, res, next) {
  if (PAIRING_TOKEN && req.get('x-pairing-token') !== PAIRING_TOKEN) return res.status(401).json({ error: 'Token akses salah.' });
  next();
}
// Key ids of messages this process sent via sock.sendMessage. WhatsApp echoes our
// own sends back through messages.upsert with fromMe=true; if we re-handled them,
// the text of e.g. the menu ("ping / .ping / !ping") would trigger those very
// commands again in an endless loop. Fresh fromMe messages typed by the owner (from
// WhatsApp itself) have a different key id, so they are still handled.
export const sentIds = new Set();
// Record the key id of a message this process sent, so the echoed fromMe copy does
// not get re-handled by the command loop. Accepts a WAMessage result (sendMessage)
// or { messageId } (rich relays).
function rememberSent(result) {
  const id = result?.key?.id || result?.messageId;
  if (!id) return result;
  sentIds.add(id);
  // Keep the set bounded: drop the oldest ids once it grows past 500.
  if (sentIds.size > 500) for (const old of sentIds) { sentIds.delete(old); if (sentIds.size <= 250) break; }
  return result;
}

// The bot is paired with the owner's own number, so every message the owner types
// arrives with fromMe=true (same WhatsApp account). remoteJid comparison does not
// work here — ownJid carries a :device suffix, and in groups remoteJid is the group
// JID, which would have dropped all owner commands. Instead we handle every fromMe
// message except the echoes of our own outgoing sends (filtered by sentIds above).
export function shouldHandleMessage(msg, ownJid) {
  if (!msg.message) return false;
  const jid = msg.key?.remoteJid;
  if (!jid || jid === 'status@broadcast' || jid.endsWith('@newsletter')) return false;
  if (msg.key.fromMe) return Boolean(msg.key.id) && !sentIds.has(msg.key.id);
  return true;
}
function bareJid(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}
function messageText(message) {
  let m = message;
  for (let i = 0; i < 8 && m; i++) {
    if (m.ephemeralMessage?.message) { m = m.ephemeralMessage.message; continue; }
    if (m.viewOnceMessage?.message) { m = m.viewOnceMessage.message; continue; }
    if (m.viewOnceMessageV2?.message) { m = m.viewOnceMessageV2.message; continue; }
    if (m.documentWithCaptionMessage?.message) { m = m.documentWithCaptionMessage.message; continue; }
    if (m.editedMessage?.message) { m = m.editedMessage.message; continue; }
    if (m.deviceSentMessage?.message) { m = m.deviceSentMessage.message; continue; }
    break;
  }
  return m?.conversation || m?.extendedTextMessage?.text || m?.imageMessage?.caption || m?.videoMessage?.caption || m?.documentMessage?.caption || '';
}

// --- access allowlist ---
// Only numbers (or chats) explicitly added by the admin get any reply; everyone
// else is ignored silently. The bot's own account (= the WhatsApp number the bot
// is paired with) and OWNER_NUMBER in .env are permanent admins who can manage the
// list: .allowlist <number> / .delallow <number> / .listallow.
const ALLOW_FILE = process.env.ALLOW_FILE || './allowlist.json';
const allowed = new Set();
// Transient LID<->phone mapping learned from .allowlist resolution. While fresh it
// lets a phone-number entry match a sender that reports an LID (WhatsApp privacy
// IDs), and vice versa.
const lidToPn = new Map();
function loadAllow() { try { for (const e of JSON.parse(fs.readFileSync(ALLOW_FILE, 'utf8'))) allowed.add(e); } catch {} }
function saveAllow() { try { fs.writeFileSync(ALLOW_FILE, JSON.stringify([...allowed], null, 1)); } catch (err) { console.error('[Allow] gagal simpan:', err?.message || err); } }
// Resolve a phone-number allowlist entry to its LID (and vice versa) via USync so
// senders that report an LID still match a phone-number allowlist entry.
const lidQueried = new Set();
async function resolveLid(sender, currentSock) {
  if (!sender || lidToPn.has(sender) || lidQueried.has(sender) || !currentSock?.onWhatsApp) return false;
  lidQueried.add(sender);
  try {
    const res = await currentSock.onWhatsApp(sender.endsWith('@lid') ? sender : `${sender}@lid`);
    for (const r of res || []) {
      const lid = r?.lid ? bareJid(r.lid) : sender;
      const pn = r?.pn || r?.jid ? bareJid(r.pn || r.jid) : '';
      if (lid && pn && pn !== lid) { lidToPn.set(lid, pn); return allowed.has(pn); }
      if (lid && r?.lid) return false;
    }
  } catch (err) { console.error('[Allow] LID->PN lookup gagal:', err?.message || err); }
  return false;
}
// Proactively map every phone-number allowlist entry to its LID as soon as the
// connection is open, so allowlisted users never hit a miss. OWNER_NUMBER is
// included even when it is not in allowlist.json, because groups report the
// owner as an LID and fromMe is false for non-bot-account senders.
async function backfillLidMap(currentSock) {
  const entries = new Set([...allowed]);
  if (OWNER_NUMBER && /^\d+$/.test(OWNER_NUMBER)) entries.add(OWNER_NUMBER);
  for (const entry of entries) {
    if (entry.includes('@')) continue; // already an LID/jid tag form
    try {
      const res = currentSock.onWhatsApp ? await currentSock.onWhatsApp(entry) : [];
      for (const r of res || []) {
        if (!r?.lid) continue;
        const lid = bareJid(r.lid);
        if (!lid || lid === entry) continue;
        lidToPn.set(lid, entry);
        if (!allowed.has(`${lid}@lid`) && !allowed.has(lid)) {
          allowed.add(`${lid}@lid`); // persist so restarts skip the lookup
          saveAllow();
          console.log(`[Allow] ${entry} ↔ LID ${lid} tersimpan`);
        }
      }
    } catch {}
  }
}
function normAllowTarget(t) {
  const s = String(t || '').trim().toLowerCase();
  if (!s) return '';
  if (s.endsWith('@g.us') || s.endsWith('@s.whatsapp.net') || s.endsWith('@lid')) {
    const bare = bareJid(s);
    return s.endsWith('@g.us') ? `${bare}@g.us` : bare;
  }
  const d = s.replace(/\D/g, '');
  return d.length >= 6 ? d : '';
}
// Admin = the bot's own account (fromMe) or the OWNER_NUMBER in .env.
function isAdminMessage(msg, ownJid) {
  if (msg.key.fromMe) return true;
  const sender = playerKey(msg);
  return !sender || sender === bareJid(ownJid) || (OWNER_NUMBER && sender === OWNER_NUMBER);
}
function isAllowedMessage(msg, ownJid) {
  if (isAdminMessage(msg, ownJid)) return true;
  const sender = playerKey(msg);
  if (!sender) return false;
  if (bareJid(ownJid) === sender) return true;
  if (OWNER_NUMBER && sender === OWNER_NUMBER) return true;
  // Senders may report an LID instead of their phone number, so compare the raw
  // sender digits, the LID tag form, the chat jid, and any learned LID->phone map.
  return allowed.has(sender)
    || allowed.has(`${sender}@lid`)
    || allowed.has(msg.key.remoteJid)
    || (lidToPn.has(sender) && allowed.has(lidToPn.get(sender)));
}
export { allowed as allowlistStore };

// --- unified-response HTML relay (GenAI mini-app) ---
// sendRichHtml()'s generated payload is missing the __typename fields the WhatsApp
// GenAI renderer decodes by (root GenAIUnifiedResponse, section
// GenAIUnifiedResponseSection, primitive FOAHtmlPrimitiveDemoDONOTUSE) — the exact
// shape used by the working page.js/snake.js examples in the fork repo. Without
// them the mini-app does not render, so the chess board never appears. We build
// that payload ourselves and relay it directly.
function unifiedPayload(responseId, html, trusted) {
  return {
    __typename: 'GenAIUnifiedResponse',
    response_id: responseId,
    sections: [{
      __typename: 'GenAIUnifiedResponseSection',
      view_model: {
        __typename: 'GenAISingleLayoutViewModel',
        primitive: {
          __typename: 'FOAHtmlPrimitiveDemoDONOTUSE',
          trusted_sources: trusted,
          payload: html
        }
      }
    }]
  };
}
async function relayRichHtml(jid, html, { responseId = crypto.randomUUID(), trusted = [] } = {}) {
  // Mirror real Meta AI messages: contextInfo.forwardedAiBotMessageInfo on the rich
  // content plus messageContextInfo.botMetadata on the outer message — both from
  // the fork's sendRichHtml. Newer clients check these when deciding whether the
  // unifiedResponse can be rendered.
  const content = {
    messageContextInfo: {
      deviceListMetadata: {},
      deviceListMetadataVersion: 2,
      botMetadata: { messageDisclaimerText: '', botResponseId: responseId }
    },
    botForwardedMessage: {
      message: {
        richResponseMessage: {
          messageType: 1,
          unifiedResponse: { data: Buffer.from(JSON.stringify(unifiedPayload(responseId, html, trusted))).toString('base64') },
          contextInfo: {
            isForwarded: true,
            forwardOrigin: 4,
            forwardedAiBotMessageInfo: { botJid: '867051314767696@bot' }
          }
        }
      }
    }
  };
  const full = generateWAMessageFromContent(jid, content, { userJid: sock?.user?.id || '', messageId: generateMessageID() });
  rememberSent(full);
  await sock.relayMessage(jid, full.message, { messageId: full.key.id });
  return full.key;
}

function gameStatus(game) {
  const chess = game.chess;
  const st = htmlState(game);
  return {
    id: game.id, fen: chess.fen(), pgn: chess.pgn(), turn: chess.turn(), status: st.status,
    phase: game.phase, clock: game.time ? { w: game.time.w, b: game.time.b, mode: game.time.mode } : null,
    result: game.result,
    gameOver: chess.isGameOver() || game.phase === 'over', check: chess.isCheck(), checkmate: chess.isCheckmate(), draw: chess.isDraw(),
    legalMoves: chess.moves({ verbose: true }).map(m => ({ from: m.from, to: m.to, promotion: m.promotion || null })),
    players: game.players.map(p => p ? { name: p.name, color: p.color } : null), lastMove: game.lastMove
  };
}
const FILES = 'abcdefgh';
const PIECE_GLYPH = { wk: '♔', wq: '♕', wr: '♖', wb: '♗', wn: '♘', wp: '♙', bk: '♚', bq: '♛', br: '♜', bb: '♝', bn: '♞', bp: '♟' };
const MOVE_RE = /^([a-h][1-8])[\s-]?([a-h][1-8])(?:[\s-]?([qrbn]))?$/i;
const MODE_RE = /^(\d{1,2})\s*(m|menit|min|minute)?$/i;
const PROMO = { q: 'q', r: 'r', b: 'b', n: 'n' };
const MODES = { 1: 1, 10: 10, 15: 15 };   // minutes, agreed by both players

// A player is their group participant when in a group, else the chat counterpart.
// fromMe messages are the owner's own account, so attribute them to the bot's own
// bare number — otherwise a command the owner sends in a DM would be attributed to
// the person being chatted with (remoteJid) and their ELO.
function playerKey(msg) {
  if (msg.key.fromMe) return bareJid(msg.key.participant || '');
  return bareJid(msg.key.participant || msg.key.remoteJid || '');
}
function displayName(key) {
  const e = elo.get(key);
  if (e?.name && e.name !== key) return e.name;
  return key.length > 4 ? '•••' + key.slice(-4) : key;
}

// --- ELO rating ---
const ELO_FILE = process.env.ELO_FILE || './elo.json';
const elo = new Map(); // player key -> { rating, name, w, l, d }
function loadElo() { try { for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(ELO_FILE, 'utf8')))) elo.set(k, v); } catch {} }
function saveElo() { try { fs.writeFileSync(ELO_FILE, JSON.stringify(Object.fromEntries(elo))); } catch {} }
function eloEntry(key, name) {
  if (!elo.has(key)) elo.set(key, { rating: 1000, name: name || key, w: 0, l: 0, d: 0 });
  const e = elo.get(key);
  if (name && (!e.name || e.name === key)) e.name = String(name).slice(0, 24);
  return e;
}
export function eloLeaderboard(limit = 10) {
  return [...elo.values()].sort((a, b) => b.rating - a.rating || b.w - a.w).slice(0, limit);
}
// Standard Elo with K=32. scoreA is 1/0.5/0 for the white seat.
function eloPair(a, b, scoreA) {
  const expectedA = 1 / (1 + Math.pow(10, (b.rating - a.rating) / 400));
  const k = 32;
  return [Math.round(a.rating + k * (scoreA - expectedA)), Math.round(b.rating + k * ((1 - scoreA) - (1 - expectedA)))];
}
function applyResult(game, loserColor) {
  const w = game.seats?.w, b = game.seats?.b;
  if (!w || !b || w === b) return;
  const ew = eloEntry(w), eb = eloEntry(b);
  const scoreA = loserColor === 'w' ? 0 : loserColor === 'b' ? 1 : 0.5;
  [ew.rating, eb.rating] = eloPair(ew, eb, scoreA);
  if (loserColor === 'w') { ew.l++; eb.w++; }
  else if (loserColor === 'b') { ew.w++; eb.l++; }
  else { ew.d++; eb.d++; }
  saveElo();
}

// --- time control ---
export function startClock(game, mins) {
  const ms = mins * 60 * 1000;
  game.phase = 'playing';
  game.time = { mode: mins, w: ms, b: ms, last: Date.now() };
}
// The side to move pays for the time spent since the last move; a zero clock flags.
function chargeClock(game) {
  if (!game.time || game.phase !== 'playing') return null;
  const now = Date.now();
  const side = game.chess.turn();
  game.time[side] = Math.max(0, game.time[side] - (now - game.time.last));
  game.time.last = now;
  return game.time[side] === 0 ? side : null;
}
// Settles the game when it is over; returns true if it ended on this call.
export function finishIfNeeded(game) {
  if (game.phase === 'over') return true;
  let loser = null;
  let reason = '';
  if (game.flagged) { loser = game.flagged; reason = 'waktu habis'; }
  else if (game.chess.isCheckmate()) { loser = game.chess.turn(); reason = 'skakmat'; }
  else if (game.chess.isDraw()) { loser = null; reason = 'remis'; }
  else return false;
  game.phase = 'over';
  game.result = { loser, reason };
  applyResult(game, loser);
  return true;
}

export function boardText(chess) {
  const lines = [];
  for (let r = 0; r < 8; r++) {
    const rank = 8 - r;
    let line = rank + ' ';
    for (let c = 0; c < 8; c++) {
      const piece = chess.get(FILES[c] + rank);
      line += (piece ? PIECE_GLYPH[piece.color + piece.type] : '·') + ' ';
    }
    lines.push(line);
  }
  lines.push('  ' + FILES.split('').join(' '));
  return lines.join('\n');
}
function clockText(game) {
  if (!game.time) return '';
  const fmt = ms => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
  return `⏱ Putih ${fmt(game.time.w)} • Hitam ${fmt(game.time.b)} (${game.time.mode} menit)`;
}
// Everything the in-bubble page needs to render and to send a move back.
function htmlState(game) {
  const chess = game.chess;
  const occupied = {};
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const piece = chess.get(FILES[c] + (8 - r));
    if (piece) occupied[FILES[c] + (8 - r)] = piece.color + piece.type;
  }
  const legal = {};
  for (const m of chess.moves({ verbose: true })) (legal[m.from] = legal[m.from] || []).push(m.to);
  const turn = chess.turn() === 'w' ? 'Putih' : 'Hitam';
  const result = game.result;
  const status = result
    ? (result.loser ? `${result.reason === 'waktu habis' ? '⏱ Waktu habis' : '👑 ' + result.reason.charAt(0).toUpperCase() + result.reason.slice(1)} — ${result.loser === 'w' ? 'Hitam' : 'Putih'} menang.` : '🤝 Remis.')
    : chess.isCheckmate() ? `Skakmat! ${chess.turn() === 'w' ? 'Hitam' : 'Putih'} menang.`
      : chess.isDraw() ? 'Remis.'
        : chess.isCheck() ? `Skak! Giliran ${turn}.`
          : game.phase === 'lobby' ? `LOBBY — pilih waktu: balas 1 / 10 / 15`
            : `Giliran ${turn}. Tap bidakmu, lalu tap petak tujuan.`;
  return {
    occupied, legal, turn, status, over: game.phase === 'over' || chess.isGameOver(),
    lobby: game.phase === 'lobby',
    clock: game.time ? `${fmtClock(game.time.w)} · ${fmtClock(game.time.b)}` : ''
  };
}
function fmtClock(ms) {
  return `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`;
}
function chessBoardHtml(game) {
  const st = htmlState(game);
  const css = '*{-webkit-tap-highlight-color:transparent;box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}body{background:#0b1110;color:#e7f5ec}.wrap{padding:10px;max-width:420px}.hdr{display:flex;justify-content:space-between;align-items:center;margin-bottom:8px}.t{font-weight:800;font-size:14px}.st{font-size:11px;color:#9db0a8}.clk{margin-bottom:8px;display:flex;justify-content:space-between;font-size:11px;color:#fbbf24;background:#0c1a13;border:1px solid #3f7659;border-radius:8px;padding:6px 8px}.board{display:grid;grid-template-columns:repeat(8,1fr);border:1px solid #263b34;border-radius:8px;overflow:hidden}.sq{aspect-ratio:1;display:grid;place-items:center;font-size:20px;user-select:none;cursor:pointer}.l{background:#1d3b2a}.d{background:#0f241b}.sel{outline:3px solid #25d366;outline-offset:-3px}.tg{background:#14532d!important}.msg{margin-top:8px;font-size:11px;color:#9db0a8;min-height:14px}';
  const js = 'var CFG=' + JSON.stringify({ url: `${appUrl()}/chess/move`, token: game.token, state: st }).replace(/</g, '\\u003c') + ';'
    + 'var sel=null;function el(id){return document.getElementById(id)}function paint(){var s=CFG.state,html="";for(var r=8;r>=1;r--){for(var i=0;i<8;i++){var f="abcdefgh"[i],k=f+r,p=s.occupied[k];var cl=((i+r)%2)?"l":"d";if(k===sel)cl="sel";else if(sel&&(s.legal[sel]||[]).indexOf(k)>=0)cl="tg";html+="<div class=\\"sq "+cl+"\\" data-k=\\""+k+"\\">"+(p?({"wp":"♙","wn":"♘","wb":"♗","wr":"♖","wq":"♕","wk":"♔","bp":"♟","bn":"♞","bb":"♝","br":"♜","bq":"♛","bk":"♚"})[p]||"")+"</div>"}}el("bd").innerHTML=html;el("st").textContent=s.status;el("cl").textContent=s.clock||""}'
    + 'function say(t){el("msg").textContent=t}function go(from,to){fetch(CFG.url,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({token:CFG.token,from:from,to:to})}).then(function(r){return r.json()}).then(function(d){if(d&&d.ok){CFG.state=d.state;paint();say(d.state.status)}else{say(d&&d.error||"Langkah ditolak")}}).catch(function(){say("Klik tidak terkirim (diblokir). Ketik langkahmu, contoh e2e4")})}'
    + 'el("bd").addEventListener("click",function(e){var k=e.target.getAttribute("data-k");if(!k||CFG.state.over||CFG.state.lobby)return;if(!sel){if(CFG.state.occupied[k]&&CFG.state.legal[k]){sel=k;paint()}return}if(k===sel){sel=null;paint();return}var f=sel;sel=null;paint();go(f,k)})';
  return '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no"><style>' + css + '</style></head><body><div class="wrap"><div class="hdr"><span class="t">♟ Catur</span><span class="st" id="st"></span></div><div class="clk" id="cl"></div><div class="board" id="bd"></div><div class="msg" id="msg"></div></div><script>' + js + '</script></body></html>';
}
export function applyMove(game, from, to, promotion) {
  if (game.phase === 'lobby') return { ok: false, error: 'Masih di lobby. Pilih waktu: 1 / 10 / 15.' };
  if (game.phase === 'over' || game.chess.isGameOver()) return { ok: false, error: 'Permainan sudah selesai.' };
  game.flagged = null;
  const expired = chargeClock(game);
  if (expired) { game.flagged = expired; return { ok: false, error: 'Waktu habis.' }; }
  try {
    const move = game.chess.move({ from, to, promotion: PROMO[String(promotion || 'q').toLowerCase()] ? String(promotion).toLowerCase() : 'q' });
    if (!move) return { ok: false, error: 'Langkah tidak valid.' };
    game.lastMove = { from: move.from, to: move.to, san: move.san };
    game.moverColor = move.color;
    return { ok: true, move };
  } catch { return { ok: false, error: 'Langkah tidak valid.' }; }
}
function broadcastGame(game) {
  io.to(game.id).emit('game:state', gameStatus(game));
  // Universal realtime update (works on every client incl. iOS WhatsApp Business):
  // a board image + short status line, sent from game creation, on clock start and
  // after every move.
  if (game.chatJid && sock) {
    sendMoveUpdate(game).catch(err => console.error('[Chess] gagal kirim update langkah:', err?.message || err));
    // The GenAI HTML mini-app renders only on clients with Meta AI support; on
    // WhatsApp Business/iOS it shows as an empty "Forwarded" bubble, so it is
    // opt-in via RICH_HTML=1. The tap-board link stays available in the .chess text.
    if (RICH_HTML) sendBoardToChat(game).catch(err => console.error('[Chess] gagal kirim papan HTML:', err?.message || err));
  }
}
function moveStatusText(game) {
  const st = htmlState(game);
  const lm = game.lastMove;
  return `${lm ? `♟️ *${lm.san}*` : '♟️ *GAME CATUR*'}\n${st.status}${st.clock ? `\n${st.clock}` : ''}`;
}
async function sendMoveUpdate(game) {
  try {
    await sock.sendMessage(game.chatJid, { image: boardPNG(game.chess, game.lastMove), caption: moveStatusText(game) });
  } catch (err) {
    console.error('[Chess] PNG gagal, pakai teks:', err?.message || err);
    await sock.sendMessage(game.chatJid, { text: moveStatusText(game) }).catch(() => {});
  }
}
function createGame(chatJid = null) {
  const id = crypto.randomBytes(5).toString('hex');
  const game = {
    id, chess: new Chess(), players: [null, null], sockets: new Map(), createdAt: Date.now(), lastMove: null,
    chatJid, token: crypto.randomBytes(12).toString('hex'),
    phase: 'lobby', choice: {}, seats: { w: null, b: null }, time: null, flagged: null, result: null, boardKey: null
  };
  games.set(id, game);
  if (chatJid) chatGames.set(chatJid, id);
  return game;
}
// The board is rendered inside the chat bubble as HTML. Each move we re-relay the
// updated board with the same response_id family and delete the previous bubble, so
// the chat shows exactly ONE live board refresh with every move (aka realtime).
// Also: if WhatsApp blocks the in-page fetch, the player types the move instead
// (handleMove) — that path always works and needs no whitelist.
async function sendBoardToChat(game) {
  const st = htmlState(game);
  const fallback = `♟️ *GAME CATUR ONLINE*\n${st.status}${st.clock ? '\n' + st.clock : ''}\n\nBalas langkahmu di chat ini, contoh: *e2e4*\n\n\`\`\`\n${boardText(game.chess)}\n\`\`\``;
  try {
    const key = await relayRichHtml(game.chatJid, chessBoardHtml(game), {
      responseId: `chess-${game.id}`,
      trusted: [appUrl()]
    });
    const previous = game.boardKey;
    game.boardKey = key;
    if (previous) { try { await sock.sendMessage(game.chatJid, { delete: previous }); } catch {} }
  } catch (err) {
    console.error('[Chess] papan HTML gagal, pakai teks:', err?.message || err);
    await sock.sendMessage(game.chatJid, { text: fallback });
  }
}
// Returns true when the text was a time-control pick for the chat's lobby.
function handleModePick(senderKey, chatJid, raw) {
  const game = games.get(chatGames.get(chatJid));
  if (!game || game.phase !== 'lobby') return false;
  const m = String(raw).trim().match(MODE_RE);
  if (!m || !MODES[m[1]]) return false;
  const mins = MODES[m[1]];
  game.choice[senderKey] = mins;
  const picks = Object.entries(game.choice);
  if (picks.length >= 2 && picks.every(([, v]) => v === mins)) {
    startClock(game, mins);
    broadcastGame(game);
    return true;
  }
  if (picks.length >= 2) {
    // Players disagree — reset the vote so they can pick a mode together.
    const summary = picks.map(([k, v]) => `${displayName(k)}: ${v}m`).join(' vs ');
    game.choice = {};
    sock.sendMessage(chatJid, { text: `⏱ Pilihan beda (${summary}). Pilih lagi: balas 1, 10, atau 15.` }).catch(() => {});
    return true;
  }
  sock.sendMessage(chatJid, { text: `⏱ ${displayName(senderKey)} memilih ${mins} menit. Pemain lain balas 1 / 10 / 15 untuk setuju.` }).catch(() => {});
  return true;
}
// Returns true when the text was a chess move for the chat's active game.
function handleMove(senderKey, jid, raw) {
  const game = games.get(chatGames.get(jid));
  if (!game) return false;
  const m = String(raw).trim().match(MOVE_RE);
  if (!m) return false;
  const result = applyMove(game, m[1].toLowerCase(), m[2].toLowerCase(), m[3] || 'q');
  if (game.moverColor) game.seats[game.moverColor] = game.seats[game.moverColor] || senderKey;
  // A flag ends the game even though the move itself was refused.
  if (finishIfNeeded(game)) { broadcastGame(game); return true; }
  if (!result.ok) { sock.sendMessage(jid, { text: `❌ ${result.error}` }).catch(() => {}); return true; }
  broadcastGame(game);
  return true;
}
function sendMenu(jid) {
  return sock.sendMessage(jid, { text: '*MENU BOT*\n\n• ping / .ping / !ping — cek bot\n• menu / .menu / !menu — tampilkan menu\n• download / .download / !download <url> — unduh video TikTok/YouTube/Instagram\n• chess / .chess / !chess — buat game + lobby waktu\n• chess <username> — profilChess.com (rating, form, kurva)\n• chesshelp — cara bermain\n• elo — rating ELO kamu\n• top — papan peringkat' });
}
// .chess <username> — Chess.com profile card. Sends the aesthetic HTML card when the
// client can render rich HTML (RICH_HTML), otherwise (and as error-free fallback) a
// symbol-only text summary. No emoji faces: unicode symbols ♛ ★ ⚡ ▲ ▼ █ only.
async function sendChessProfile(currentSock, jid, arg) {
  const username = (arg.split(/\s+/)[0] || '').trim();
  await currentSock.sendMessage(jid, { text: `⌕ Mengambil profil Chess.com *${username}*…` }).catch(() => {});
  let data;
  try {
    data = await fetchChessProfile(username);
  } catch (err) {
    await currentSock.sendMessage(jid, { text: `✕ Gagal: ${err.message}\nPakai: .chess <username Chess.com>` }).catch(() => {});
    return;
  }
  if (RICH_HTML) {
    try {
      await relayRichHtml(jid, profileHtml(data), {
        responseId: 'chess-profile-' + data.profile.username.toLowerCase(),
        trusted: [appUrl()],
      });
      return;
    } catch (err) { console.error('[ChessProfile] HTML gagal, pakai teks:', err?.message || err); }
  }
  await currentSock.sendMessage(jid, { text: profileText(data) }).catch(() => {});
}
async function handleCommand(currentSock, jid, rawBody, senderKey = '', admin = false, msg = null) {
  const body = rawBody.trim();
  if (!body) return;
  // Accept plain commands and common prefixes, regardless of case.
  const normalized = body.replace(/^[.!/]+\s*/, '').trim();
  const match = normalized.match(/^(ping|menu|download|chess|chesshelp|elo|top|allowlist|delallow|listallow)\b\s*(.*)$/i);
  if (!match) return;
  const command = match[1].toLowerCase();
  const arg = (match[2] || '').trim();
  const key = senderKey || bareJid(jid);
  if (command === 'ping') {
    await currentSock.sendMessage(jid, { text: 'Pong! Bot aktif ✅' });
  } else if (command === 'menu') {
    await sendMenu(jid);
  } else if (command === 'allowlist' || command === 'delallow' || command === 'listallow') {
    if (!admin) return; // admin-only; outsiders are ignored silently
    // Target resolution: explicit number argument, or reply-mode: admin doesn't
    // need to know the sender's identity — replying to any of their messages with
    // .allowlist/.delallow adds/removes the EXACT jid WhatsApp reported for them
    // (possibly an LID), which always matches their future messages. If the target
    // is a phone number, its LID is resolved via USync/onWhatsApp too.
    const ctx = msg?.message?.extendedTextMessage?.contextInfo;
    const repliedKey = ctx?.quotedMessage ? ctx : null;
    let targets = [];
    if (command !== 'listallow') {
      if (!arg && repliedKey) {
        const replied = bareJid(repliedKey.participant || jid);
        if (replied) targets = [replied.endsWith('@lid') ? replied : `${replied}@lid`];
      } else {
        const digits = normAllowTarget(arg.split(/\s+/)[0]);
        if (digits) {
          targets = [digits];
          if (command === 'allowlist') {
            try {
              const res = currentSock.onWhatsApp ? await currentSock.onWhatsApp(digits) : [];
              for (const r of res) {
                if (!r?.exists || !r?.lid) continue;
                const lidDigits = bareJid(r.lid);
                if (lidDigits && lidDigits !== digits) { targets.push(`${lidDigits}@lid`); lidToPn.set(lidDigits, digits); }
              }
            } catch (err) { console.error('[Allow] LID lookup failed:', err?.message || err); }
          }
        }
      }
    }
    if (command === 'listallow') {
      const list = [...allowed];
      await currentSock.sendMessage(jid, { text: list.length
        ? `📋 *DAFTAR ALLOWLIST*\n${list.map((e, i) => `${i + 1}. ${e}`).join('\n')}\n\nAdmin: .allowlist <nomor atau balas pesan orang> • .delallow <nomor>`
        : 'Allowlist kosong. Admin: .allowlist <nomor> / balas pesan orang dengan .allowlist.' });
    } else if (!targets.length) {
      await currentSock.sendMessage(jid, { text: 'Pakai: .allowlist <nomor internasional> ATAU balas pesan orang dengan .allowlist / .delallow.\nContoh: .allowlist 628123456789' });
    } else if (command === 'allowlist') {
      for (const t of targets) allowed.add(t);
      saveAllow();
      await currentSock.sendMessage(jid, { text: `✅ ${targets.join(', ')} ditambahkan ke allowlist. Sekarang bisa pakai semua command.` });
    } else {
      const removed = targets.filter(t => allowed.delete(t));
      saveAllow();
      await currentSock.sendMessage(jid, { text: removed.length ? `🗑️ ${removed.join(', ')} dihapus dari allowlist.` : `⚠️ ${targets[0]} tidak ada di allowlist.` });
    }
  } else if (command === 'elo') {
    const e = eloEntry(key);
    const rank = eloLeaderboard().findIndex(x => x === e);
    await currentSock.sendMessage(jid, { text: `📊 *ELO KAMU*\n\nRating: *${e.rating}*\nPeringkat: #${rank >= 0 ? rank + 1 : '-'}\nMenang: ${e.w} • Kalah: ${e.l} • Remis: ${e.d}\n\nKetik .top untuk leaderboard.` });
  } else if (command === 'top') {
    await sendLeaderboard(jid);
  } else if (command === 'chesshelp') {
    await currentSock.sendMessage(jid, { text: '*CARA MAIN CATUR ONLINE* ♟️\n1. Kirim .chess di chat pribadi atau grup.\n2. Papan muncul di chat. Dua pemain memilih waktu dengan membalas 1, 10, atau 15.\n3. Kalau pilihan sama, jam mulai. Tap bidak lalu petak tujuan di papan, atau ketik langkah (contoh: e2e4).\n4. Giliran bergantian; papan + jam diperbarui di chat setiap langkah.\n5. Waktu habis = kalah. Skakmat/remis dihitung otomatis.\n\nRating ELO dihitung tiap game selesai. Ketik .elo untuk cek, .top untuk peringkat.\n\nVersi tap-bidak di browser tetap tersedia lewat link yang dikirim.\n\nPerintah: .chess, .ping, .menu, .elo, .top\nCatatan: game tersimpan di memori server dan bisa hilang saat Render restart/tidur.' });
  } else if (command === 'chess') {
    if (arg) return sendChessProfile(currentSock, jid, arg);
    const game = createGame(jid);
    const url = `${appUrl()}/chess.html?game=${game.id}`;
    await currentSock.sendMessage(jid, { text: `♟️ *GAME CATUR ONLINE DIBUAT!*\n\nPapan muncul di chat ini. Dua pemain memilih waktu: balas *1*, *10*, atau *15* (menit). Kalau pilihannya sama, jam langsung mulai.\n\nSetelah mulai: tap bidak lalu petak tujuan di papan, atau ketik langkah (contoh: *e2e4*).\nPemain pertama yang masuk jadi Putih, pemain kedua jadi Hitam.\n\nVersi tap-bidak di browser: ${url}\n\nKetik .chesshelp untuk cara main.` });
    await broadcastGame(game);
  } else if (command === 'download') {
    if (!arg) {
      await currentSock.sendMessage(jid, { text: 'Pakai: .download <url tiktok/youtube/instagram>' }).catch(() => {});
      return;
    }
    await handleDownload(currentSock, jid, arg);
  }
}
// Leaderboard rendered in the chat bubble. Same rich-HTML channel as the board.
async function sendLeaderboard(jid) {
  const rows = eloLeaderboard(10);
  const medal = ['🥇', '🥈', '🥉'];
  const html = '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>'
    + 'body{margin:0;padding:12px;background:#0b1110;color:#e7f5ec;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif}'
    + '.c{max-width:400px}.h{font-size:16px;font-weight:800;margin-bottom:2px}.s{font-size:11px;color:#9db0a8;margin-bottom:10px}'
    + '.r{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:10px;margin-bottom:6px;background:#121c19;border:1px solid #263b34}'
    + '.r.top{background:linear-gradient(90deg,#143e2b,#0c1a13);border-color:#3f7659}'
    + '.m{width:22px;font-size:15px;text-align:center}.n{flex:1;font-size:13px;font-weight:600}.e{font-size:14px;font-weight:800;color:#25d366}'
    + '.d{font-size:10px;color:#9db0a8}.empty{font-size:12px;color:#9db0a8;padding:14px;text-align:center}</style></head>'
    + '<body><div class="c"><div class="h">🏆 Papan Peringkat</div><div class="s">Rating ELO • 10 teratas</div>'
    + (rows.length ? rows.map((r, i) => '<div class="r' + (i < 3 ? ' top' : '') + '"><span class="m">' + (medal[i] || (i + 1)) + '</span><span class="n">' + escapeHtml(r.name) + '</span><span class="e">' + r.rating + '</span><span class="d">' + r.w + 'M ' + r.l + 'K ' + r.d + 'R</span></div>').join('') : '<div class="empty">Belum ada game selesai. Mainkan .chess!</div>')
    + '</div></body></html>';
  try {
    await relayRichHtml(jid, html, { responseId: 'chess-leaderboard', trusted: [appUrl()] });
  } catch (err) {
    console.error('[Chess] leaderboard HTML gagal, pakai teks:', err?.message || err);
    const text = rows.length
      ? '🏆 *PAPAN PERINGKAT*\n\n' + rows.map((r, i) => `${medal[i] || (i + 1) + '.'} ${r.name} — *${r.rating}* (${r.w}M/${r.l}K/${r.d}R)`).join('\n')
      : 'Belum ada game selesai. Mainkan .chess!';
    await sock.sendMessage(jid, { text });
  }
}
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function startSocket(phoneNumber = null) {
  if (connecting || connected) throw new Error(connected ? 'WhatsApp sudah terhubung.' : 'Koneksi sedang dimulai, tunggu sebentar.');
  connecting = true; lastStatus = 'Menyiapkan koneksi WhatsApp...'; pairingCode = null;
  try {
    fs.mkdirSync(AUTH_DIR, { recursive: true });
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    // xbailz needs syncFullHistory (its default) so the login handshake sets
    // requireFullSync and WhatsApp delivers the initial LID mappings + history.
    // Forcing it off is what made the session unstable and left the history
    // sync stuck reporting "paused". Browser tuple comes from xbailz's own helper.
    const currentSock = makeWASocket({ auth: state, logger, printQRInTerminal: false, browser: Browsers.ubuntu('Chrome'), markOnlineOnConnect: false });
    // Record the key id of every reply the bot sends, so the echoed fromMe copy does
    // not get re-handled by the command loop.
    const rawSendMessage = currentSock.sendMessage.bind(currentSock);
    currentSock.sendMessage = async (...args) => rememberSent(await rawSendMessage(...args));
    sock = currentSock;
    // An unhandled rejection from saveCreds kills the Node process; on Render that
    // restart also wipes auth_info, which is what makes the UI flip to "not connected".
    currentSock.ev.on('creds.update', () => { saveCreds().catch(err => console.error('[WA] saveCreds failed:', err?.message || err)); });
    let qrSeenResolve;
    const qrSeen = new Promise(resolve => { qrSeenResolve = resolve; });
    let closeHandled = false;
    currentSock.ev.on('connection.update', ({ connection, qr, lastDisconnect }) => {
      if (sock !== currentSock) return;
      if (qr) qrSeenResolve();
      if (connection === 'open') {
        connected = true; connecting = false; reconnecting = false; pairingCode = null;
        clearSessionWaitTimer();
        backfillLidMap(currentSock).catch(() => {});
        lastStatus = `WhatsApp terhubung${currentSock.user?.id ? ` (${currentSock.user.id})` : ''}`;
        console.log('[WA] Connection open; user=', currentSock.user?.id || 'unknown');
      }
      if (connection === 'close' && !closeHandled) {
        closeHandled = true; connected = false; connecting = false;
        clearSessionWaitTimer();
        const code = lastDisconnect?.error?.output?.statusCode;
        console.error('[WA] Connection closed; code=', code, 'reason=', lastDisconnect?.error?.message || 'unknown');
        lastStatus = code === DisconnectReason.loggedOut ? 'Sesi logout. Reset sesi lalu pairing ulang.' : `Koneksi terputus (${code ?? 'unknown'}). Mencoba menyambung ulang...`;
        // Nothing to reconnect to until the device is paired: retrying would mint a
        // fresh pairing code and invalidate the one already shown in the UI.
        if (code !== DisconnectReason.loggedOut && state.creds.registered) scheduleRetry(code === DisconnectReason.restartRequired ? 500 : 3000);
      }
    });
    currentSock.ev.on('messages.upsert', async ({ messages, type }) => {
      console.log(`[WA] messages.upsert type=${type} count=${messages?.length || 0}`);
      if (type !== 'notify' || !Array.isArray(messages)) return;
      // Commands from the owner keep arriving as fromMe=true; shouldHandleMessage
      // keeps them and filters the echoes of the bot's own outgoing sends instead.
      const ownJid = currentSock.user?.id || '';
      for (const msg of messages) {
        if (!shouldHandleMessage(msg, ownJid)) continue;
        // Allowlist gate: before the admin allowlists a number/chat, nothing there
        // gets a reply — anonymous senders are ignored silently.
        if (!isAllowedMessage(msg, ownJid)) {
          // Last chance: the sender may be an unknown LID of an already-allowlisted
          // phone number — resolve the LID->PN mapping once and re-check.
          const sender = playerKey(msg);
          const ok = sender && !msg.key.fromMe && await resolveLid(sender, currentSock);
          if (!ok) {
            console.log(`[WA] Ignored (not allowlisted): sender=${playerKey(msg)} participant=${msg.key.participant || '-'} remote=${msg.key.remoteJid} fromMe=${msg.key.fromMe}`);
            continue;
          }
        }
        const jid = msg.key.remoteJid;
        const text = messageText(msg.message);
        if (text) console.log(`[WA] Incoming text from ${jid}: ${JSON.stringify(text.slice(0, 120))}`);
        const senderKey = playerKey(msg);
        const admin = isAdminMessage(msg, ownJid);
        // Moves and clock picks are checked first; any allowed player in the chat
        // may act.
        if (handleModePick(senderKey, jid, text)) continue;
        if (handleMove(senderKey, jid, text)) continue;
        // Commands are open to allowlisted senders; allowlist management is admin-only.
        try { await handleCommand(currentSock, jid, text, senderKey, admin, msg); }
        catch (err) { console.error('[WA] Command handler failed:', err?.stack || err); }
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
    else {
      lastStatus = 'Sesi tersimpan ditemukan; menunggu WhatsApp tersambung...';
      sessionWaitTimer = setTimeout(() => {
        sessionWaitTimer = null;
        if (sock === currentSock && !connected && connecting) {
          connecting = false;
          lastStatus = 'Sesi tersimpan belum tersambung. Periksa Render Logs; jika sesi logout, reset lalu pairing ulang.';
        }
      }, 30000);
      sessionWaitTimer.unref?.();
    }
  } catch (error) { connecting = false; lastStatus = `Gagal: ${error.message}`; throw error; }
}

app.get('/healthz', (_req, res) => res.json({ ok: true, connected, games: games.size, appUrl: appUrl(), tunnel: tunnelUrl }));
// Moves tapped inside the in-chat HTML board land here. The per-game token is the
// only thing that authorises a move, so a stranger cannot drive someone's game.
app.post('/chess/move', (req, res) => {
  const target = [...games.values()].find(g => g.token === String(req.body?.token || ''));
  if (!target) return res.status(404).json({ ok: false, error: 'Game tidak ditemukan.' });
  const result = applyMove(target, String(req.body?.from || '').toLowerCase(), String(req.body?.to || '').toLowerCase(), 'q');
  // Taps carry no sender identity, so the moving colour keeps the seat it had.
  if (target.moverColor) target.seats[target.moverColor] = target.seats[target.moverColor] || 'pemain-' + target.moverColor;
  finishIfNeeded(target);
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  broadcastGame(target);
  res.json({ ok: true, state: htmlState(target) });
});
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
    clearSessionWaitTimer();
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
    if (game.chess.turn() !== player.color) return callback({ ok: false, error: 'Belum giliranmu.' });
    const result = applyMove(game, from, to, promotion);
    if (!result.ok) return callback({ ok: false, error: result.error });
    broadcastGame(game);
    callback({ ok: true, state: gameStatus(game) });
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

// Cloudflare quick tunnel: gives the local server a public https URL without an
// account, so phones can reach /chess/move from inside the WhatsApp mini-app even
// when the machine is behind NAT and APP_URL is still localhost. Requires the
// cloudflared binary (cloudflared.exe next to index.js, SPAWNER_CLOUDFLARED, or on
// PATH). Disable with CLOUDFLARE_TUNNEL=0. A Render-style public APP_URL makes the
// tunnel unnecessary, but it also gives a second/fallback URL when asked for.
const CLOUDFLARED_BIN = process.env.SPAWNER_CLOUDFLARED
  || (fs.existsSync('./cloudflared.exe') ? './cloudflared.exe' : 'cloudflared');
function startTunnel() {
  if (!TUNNEL_ENABLED || !LOCAL) return;
  const child = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const grab = buf => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m) {
      tunnelUrl = m[0];
      console.log(`[Tunnel] Cloudflare tunnel active: ${tunnelUrl}`);
      if (sock) for (const g of games.values()) if (g.chatJid) sendBoardToChat(g).catch(() => {}); // refresh boards with the public URL
    }
  };
  child.stdout?.on('data', grab);
  child.stderr?.on('data', grab); // cloudflared logs to stderr
  child.on('error', err => console.error('[Tunnel] cloudflared gagal:', err.message));
  child.on('exit', code => {
    tunnelUrl = null;
    console.error(`[Tunnel] cloudflared keluar (code=${code})`);
    if (TUNNEL_ENABLED) setTimeout(startTunnel, 15000); // reconnect the tunnel
  });
}

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Web pairing + realtime chess app listening on port ${PORT}; APP_URL=${APP_URL}${LOCAL ? ' (Cloudflare tunnel akan dimulai)' : ''}`);
  loadElo();
  loadAllow();
  startTunnel();
  if (fs.existsSync(AUTH_DIR) && fs.readdirSync(AUTH_DIR).length > 0) {
    try { await startSocket(); } catch (error) { console.error('Auto reconnect failed:', error.message); }
  } else {
    lastStatus = 'Sesi WhatsApp tidak ditemukan. Render menghapus disk saat service restart/spin-down; masukkan nomor untuk pairing ulang.';
  }
});

// Render free-tier web services spin down after 15 minutes without inbound traffic.
// A self-ping (below) only helps while the process is already awake; it cannot wake
// a spun-down instance. Use an external cron (GitHub Actions / UptimeRobot) to keep
// the service warm. Disk (auth_info) is still wiped on spin-down/redeploy unless
// AUTH_DIR points to a persistent disk (paid plan).
if (!/localhost|127\.0\.0\.1/.test(APP_URL)) {
  setInterval(() => { fetch(`${APP_URL}/healthz`).catch(() => {}); }, 8 * 60 * 1000).unref?.();
}
