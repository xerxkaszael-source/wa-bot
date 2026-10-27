// .chess <username> — Chess.com profile viewer.
// Fetches the public Chess.com API (no key needed) and renders:
//  - an aesthetic dark HTML card (sent via relayRichHtml on Meta-AI-capable clients)
//  - a symbol-only text summary fallback for clients that cannot render rich HTML.
// Design language: coordinates-style unicode symbols (♟ ♞ ♛ ★ ⚡ ▲ ▼ ◆ ●) — no emoji faces.

const API = 'https://api.chess.com/pub';

async function jfetch(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'wa-bot chess profile viewer' } });
    if (!res.ok) { const err = new Error(`HTTP ${res.status}`); err.code = res.status; throw err; }
    return await res.json();
  } finally { clearTimeout(t); }
}

export async function fetchChessProfile(usernameRaw) {
  const username = String(usernameRaw || '').trim().toLowerCase();
  if (!/^[a-z0-9_-]{2,30}$/.test(username)) throw new Error('Username tidak valid.');
  const profile = await jfetch(`${API}/player/${username}`);
  if (!profile || !profile.username) throw new Error('Profil tidak ditemukan.');
  const safe = async (p, fb) => { try { return await jfetch(p); } catch { return fb; } };
  const [stats, trophies, clubs, archives] = await Promise.all([
    safe(`${API}/player/${username}/stats`, {}),
    safe(`${API}/player/${username}/trophies`, []),
    safe(`${API}/player/${username}/clubs`, []),
    safe(`${API}/player/${username}/games/archives`, []),
  ]);
  // Country name (best-effort)
  let country = null;
  if (profile.country) {
    try { country = (await jfetch(profile.country)).name; } catch {}
  }
  // Recent games: last archive month + current live month
  const arch = (archives && Array.isArray(archives.archives)) ? archives.archives : (Array.isArray(archives) ? archives : []);
  const games = [];
  for (const url of arch.slice(-2)) {
    const data = await safe(url, { games: [] });
    games.push(...(data.games || []));
    if (games.length >= 120) break;
  }
  games.sort((a, b) => (b.end_time || 0) - (a.end_time || 0));
  const seen = new Set();
  const recent = [];
  for (const g of games) {
    const id = g.uuid || g.url;
    if (seen.has(id)) continue;
    seen.add(id);
    recent.push(g);
    if (recent.length >= 80) break;
  }
  return { profile, stats, trophies: trophies || [], clubs: clubs || [], recent, country };
}

// ---- analysis helpers ------------------------------------------------------
function resultFor(game, username) {
  const u = username.toLowerCase();
  const isWhite = (game.white?.username || '').toLowerCase() === u;
  const isBlack = (game.black?.username || '').toLowerCase() === u;
  if (!isWhite && !isBlack) return null;
  const r = isWhite ? game.white?.result : game.black?.result;
  if (r === 'win') return 'W';
  if (['checkmated', 'timeout', 'resigned', 'abandoned', 'lose', 'kingofthehilllost', 'bughousepartnerlose'].includes(r)) return 'L';
  if (['agreed', 'repetition', 'stalemate', 'insufficient', '50move', 'timevsinsufficient'].includes(r)) return 'D';
  return null;
}
function ratingFor(game, username) {
  const u = username.toLowerCase();
  if ((game.white?.username || '').toLowerCase() === u) return game.white?.rating;
  if ((game.black?.username || '') === u) return game.black?.rating;
  return null;
}
function analyze(recent, username) {
  const form = [], ratings = [], opponents = [];
  let longestW = 0, longestL = 0, curW = 0, curL = 0;
  const chrono = [...recent].filter(g => g.end_time).sort((a, b) => a.end_time - b.end_time);
  for (const g of chrono) {
    const r = resultFor(g, username);
    if (!r) continue;
    form.push(r);
    if (r === 'W') { curW++; curL = 0; longestW = Math.max(longestW, curW); }
    else if (r === 'L') { curL++; curW = 0; longestL = Math.max(longestL, curL); }
    const rt = ratingFor(g, username);
    if (rt) ratings.push({ t: (g.end_time || 0) * 1000, v: rt });
    const opp = ((g.white?.username || '').toLowerCase() === username.toLowerCase()) ? g.black : g.white;
    if (opp) opponents.push(opp);
  }
  const w = form.filter(x => x === 'W').length, l = form.filter(x => x === 'L').length, d = form.filter(x => x === 'D').length;
  return { w, l, d, wr: w + l + d ? Math.round((w / (w + l + d)) * 100) : null, longestW, longestL, ratings };
}
function fmtDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
}
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 3600) return `${Math.round(s / 60)}m lalu`;
  if (s < 86400) return `${Math.round(s / 3600)}j lalu`;
  return `${Math.round(s / 86400)}h lalu`;
}
function fmtNum(n) { return (n == null) ? '—' : Number(n).toLocaleString('id-ID'); }

// Bars in text use ▰▱; blocks ▁▂▃▄▅▆▇█
const BAR = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export function profileText({ profile, stats, recent, country }) {
  const u = profile.username;
  const a = analyze(recent, u);
  const tc = (key) => stats[key]?.last?.rating;
  const sRatings = a.ratings.slice(-24).map(r => r.v);
  let spark = '';
  if (sRatings.length >= 2) {
    const min = Math.min(...sRatings), span = Math.max(1, Math.max(...sRatings) - min);
    spark = sRatings.map(v => BAR[Math.max(0, Math.min(7, Math.round(((v - min) / span) * 7)))]).join('');
  }
  const n = a.w + a.l + a.d;
  const out = [
    `♛ *CHESS.COM — ${profile.name || u}*${profile.title ? `  〔${profile.title}〕` : ''}`,
    `　 @${u}${country ? ` • ${country}` : ''}`,
    '',
    '✧ RATINGS ─────────────',
    `　⚡ Bullet  ${tc('chess_bullet') ?? '—'}`,
    `　★ Blitz   ${tc('chess_blitz') ?? '—'}`,
    `　◆ Rapid   ${tc('chess_rapid') ?? '—'}`,
    `　● Daily   ${tc('chess_daily') ?? '—'}`,
  ];
  if (stats.tactics?.highest?.rating) out.push(`　✦ Puzzle  ${stats.tactics.highest.rating}`);
  if (stats.fide) out.push(`　▣ FIDE    ${stats.fide}`);
  out.push(
    '',
    `✧ FORM ${n} GAME ───────`,
    `　▲ ${a.w}  ▼ ${a.l}  ─ ${a.d}  •  WR ${a.wr ?? '—'}%`,
    `　Streak terbaik: ${a.longestW}W / ${a.longestL}L`,
  );
  if (spark) out.push(`　${spark}`);
  out.push(
    '',
    '✧ INFO ────────────────',
    `　Pengikut ${fmtNum(profile.followers)} • Liga ${profile.league || '—'}`,
    `　Gabung ${fmtDate(profile.joined)} • Aktif ${fmtAgo(profile.last_online)}`,
    '',
    `✧ GAME TERAKHIR ───────`,
  );
  for (const g of recent.slice(0, 8)) {
    const r = resultFor(g, u);
    const mark = r === 'W' ? '▲' : r === 'L' ? '▼' : '─';
    const opp = ((g.white?.username || '').toLowerCase() === u) ? g.black?.username : g.white?.username;
    out.push(`　${mark} ${opp || '—'} [${g.time_class || '?'}] ${fmtAgo(g.end_time)}`);
  }
  out.push('', `Lebih detail: ${profile.url}`);
  return out.join('\n');
}

// Sparkline SVG points from rating history
function sparkline(ratings, width, height) {
  if (!ratings || ratings.length < 2) return '';
  const min = Math.min(...ratings.map(r => r.v));
  const max = Math.max(...ratings.map(r => r.v));
  const span = Math.max(1, max - min);
  const pts = ratings.map((r, i) => {
    const x = (i / (ratings.length - 1)) * (width - 8) + 4;
    const y = height - 8 - ((r.v - min) / span) * (height - 20);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const colUp = ratings[ratings.length - 1].v >= ratings[0].v;
  const stroke = colUp ? '#a3d15a' : '#ff6b6b';
  const fillId = 'g' + Math.random().toString(36).slice(2, 8);
  return `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" style="width:100%;height:${height}px;display:block">
    <defs><linearGradient id="${fillId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${stroke}" stop-opacity="0.35"/><stop offset="1" stop-color="${stroke}" stop-opacity="0"/>
    </linearGradient></defs>
    <polygon points="4,${height} ${pts.join(' ')} ${width - 4},${height}" fill="url(#${fillId})"/>
    <polyline points="${pts.join(' ')}" fill="none" stroke="${stroke}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
  </svg>`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const symBullet = '⚡', symBlitz = '★', symRapid = '◆', symDaily = '●';

export function profileHtml({ profile, stats, recent, clubs, trophies, country }) {
  const u = profile.username;
  const a = analyze(recent, u);
  const avatar = profile.avatar || 'https://www.chess.com/chess-themes/avatars/default/200.png';

  const statCard = (sym, label, cls, s) => {
    if (!s?.last) return '';
    const rec = s.record || {};
    return `<div class="st ${cls}">
      <div class="st-h"><span class="st-sym">${sym}</span>${label}</div>
      <div class="st-big">${fmtNum(s.last.rating)}</div>
      <div class="st-row"><span>BEST</span><b>${fmtNum(s.best?.rating)}</b></div>
      <div class="st-row"><span>W/L/D</span><b>${rec.win ?? 0} / ${rec.loss ?? 0} / ${rec.draw ?? 0}</b></div>
    </div>`;
  };

  const formDots = recent.length
    ? recent.slice(0, 20).map(g => {
        const r = resultFor(g, u);
        return `<i class="fd ${r === 'W' ? 'fw' : r === 'L' ? 'fl' : 'fx'}">${r === 'W' ? '▲' : r === 'L' ? '▼' : '─'}</i>`;
      }).join('')
    : '';

  const spark = sparkline(a.ratings.slice(-40), 640, 110);

  const gamesRows = recent.slice(0, 10).map(g => {
    const r = resultFor(g, u);
    const opp = ((g.white?.username || '').toLowerCase() === u) ? g.black : g.white;
    const myR = ratingFor(g, u);
    return `<tr>
      <td><span class="rb ${r === 'W' ? 'rw' : r === 'L' ? 'rl' : 'rd'}">${r === 'W' ? '▲ W' : r === 'L' ? '▼ L' : '─ D'}</span></td>
      <td>${esc(opp?.username || '—')}<i class="dim"> ${opp?.rating ?? ''}</i></td>
      <td>${myR ?? '—'}</td>
      <td class="dim">${esc(g.time_class || '—')}</td>
      <td class="dim">${esc(fmtAgo(g.end_time))}</td>
      <td><a class="lnk" href="${esc(g.url || '#')}" target="_blank" rel="noopener">↗</a></td>
    </tr>`;
  }).join('');

  const clubsHtml = clubs.length
    ? clubs.slice(0, 6).map(c => `<a class="club" href="${esc(c.url || '#')}" target="_blank" rel="noopener">♟ ${esc(c.name)}</a>`).join('')
    : '<i class="dim small">Belum tergabung di klub manapun.</i>';

  return `<!DOCTYPE html>
<html lang="id"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
:root{--g:#81b64c;--g2:#a3d15a;--bg:#0b0e14;--card:#121822;--card2:#161d2a;--line:#232c3d;--tx:#e8eaf0;--dim:#8b93a7;--w:#6bcb77;--l:#ff6b6b;--d:#b0b3c0}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:Inter,system-ui,sans-serif;background:radial-gradient(1100px 500px at 80% -10%,#1c2b1a33,transparent),radial-gradient(900px 500px at -10% 110%,#1a243855,transparent),var(--bg);color:var(--tx);padding:18px}
.c{max-width:680px;margin:0 auto}
.hdr{display:flex;gap:16px;align-items:center;padding:18px;border:1px solid var(--line);border-radius:18px;background:linear-gradient(135deg,var(--card),var(--card2));position:relative;overflow:hidden}
.hdr::before{content:'';position:absolute;inset:0 0 auto 0;height:2px;background:linear-gradient(90deg,transparent,var(--g),transparent)}
.av{width:84px;height:84px;border-radius:50%;border:2px solid var(--g);object-fit:cover}
.tt{font-weight:800;background:linear-gradient(135deg,#f0c040,#e8a020);color:#1a1408;border-radius:6px;padding:2px 8px;font-size:12px;letter-spacing:1px}
.nm{font-size:22px;font-weight:800;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.un{color:var(--g2);font-weight:600;font-size:13px;margin:2px 0 8px}
.mt{display:flex;gap:14px;flex-wrap:wrap;font-size:12px;color:var(--dim)}
.mt b{color:var(--tx);font-weight:600}
.sec{margin-top:14px}
.s-t{font-size:11px;font-weight:700;letter-spacing:2px;color:var(--dim);margin:0 2px 8px;display:flex;gap:8px;align-items:center}
.s-t::after{content:'';flex:1;height:1px;background:var(--line)}
.sym{color:var(--g2)}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px}
.st{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--g);border-radius:12px;padding:12px}
.st-h{font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--g2);display:flex;gap:6px;align-items:center}
.st-big{font-size:26px;font-weight:800;margin:6px 0 4px;letter-spacing:-1px}
.st-row{display:flex;justify-content:space-between;font-size:11px;color:var(--dim)}
.st-row b{color:var(--tx)}
.fd{width:26px;height:26px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;font-style:normal;margin:3px 3px 0 0}
.fw{background:#173120;color:var(--w);border:1px solid #2b5c42}
.fl{background:#3a1717;color:var(--l);border:1px solid #632727}
.fx{background:#242734;color:var(--d);border:1px solid #3a3f52}
.charts{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px}
table{width:100%;border-collapse:collapse;font-size:12px}
th{text-align:left;color:var(--dim);font-size:10px;letter-spacing:1px;padding:4px 6px;border-bottom:1px solid var(--line)}
td{padding:7px 6px;border-bottom:1px solid var(--line)}
.rb{padding:2px 8px;border-radius:6px;font-weight:800;font-size:10px}
.rw{background:#173120;color:var(--w)}.rl{background:#3a1717;color:var(--l)}.rd{background:#242734;color:var(--d)}
.dim{color:var(--dim);font-style:normal}
.lnk{color:var(--g2);text-decoration:none;font-weight:800}
.club{display:inline-flex;gap:6px;align-items:center;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:7px 12px;margin:0 6px 6px 0;font-size:12px;color:var(--tx);text-decoration:none;font-weight:600}
.club:hover{border-color:var(--g)}
.small{font-size:11px}
.ft{margin-top:16px;text-align:center;font-size:10px;color:var(--dim);letter-spacing:1px}
</style></head>
<body><div class="c">
  <div class="hdr">
    <img class="avatar" src="${esc(avatar)}" alt="" onerror="this.style.display='none'">
    <div style="flex:1;min-width:200px">
      <div class="nm">${esc(profile.name || u)}${profile.title ? `<span class="tt">${esc(profile.title)}</span>` : ''}</div>
      <div class="un">@${esc(u)}${country ? ' · ' + esc(country) : ''}${profile.status ? ' · ' + esc(profile.status) : ''}</div>
      <div class="mt">
        <span>PENGIRIM <b>${fmtNum(profile.followers)}</b></span>
        <span>LIGA <b>${esc(profile.league || '—')}</b></span>
        <span>GABUNG <b>${esc(fmtDate(profile.joined))}</b></span>
        <span>AKTIF <b>${esc(fmtAgo(profile.last_online))}</b></span>
      </div>
    </div>
  </div>

  <div class="sec"><div class="s-t"><span class="sym">♞</span> RATINGS</div>
    <div class="grid">
      ${statCard(symBullet, 'BULLET', 'bullet', stats.chess_bullet)}
      ${statCard(symBlitz, 'BLITZ', 'blitz', stats.chess_blitz)}
      ${statCard(symRapid, 'RAPID', 'rapid', stats.chess_rapid)}
      ${statCard(symDaily, 'DAILY', 'daily', stats.chess_daily)}
      ${stats.tactics?.highest?.rating ? `<div class="st"><div class="st-h"><span class="st-sym">✦</span>PUZZLE</div><div class="st-big">${fmtNum(stats.tactics.highest.rating)}</div><div class="st-row"><span>TERENDAH</span><b>${fmtNum(stats.tactics.lowest?.rating)}</b></div></div>` : ''}
      ${stats.fide ? `<div class="st"><div class="st-h"><span class="st-sym">▣</span>FIDE</div><div class="st-big">${fmtNum(stats.fide)}</div></div>` : ''}
    </div>
  </div>

  <div class="sec"><div class="s-t"><span class="sym">⚑</span> FORM ${wld(recent, u)}</div>
    <div>${formDots || '<i class="dim small">Belum ada game terbaru.</i>'}</div>
    ${a.wr != null ? `<div class="mt" style="margin-top:8px"><span>▲ ${a.w}</span><span>▼ ${a.l}</span><span>─ ${a.d}</span><span><b>WIN RATE ${a.wr}%</b></span><span><b>STREAK ${a.longestW}W</b></span></div>` : ''}
  </div>

  ${spark ? `<div class="sec"><div class="s-t"><span class="sym">◈</span> KURVA RATING</div><div class="charts">${spark}</div></div>` : ''}

  <div class="sec"><div class="s-t"><span class="sym">☰</span> ${Math.min(10, recent.length)} GAME TERAKHIR</div>
    <div class="charts" style="padding:0 6px"><table>
      <thead><tr><th>HD</th><th>LAWAN</th><th>KU</th><th>TIPE</th><th>WKT</th><th></th></tr></thead>
      <tbody>${gamesRows || '<tr><td colspan="6" style="color:var(--dim)">Tidak ada data game.</td></tr>'}</tbody>
    </table></div>
  </div>

  ${clubs.length ? `<div class="sec"><div class="s-t"><span class="sym">⌘</span> KLUB</div><div>${clubsHtml}</div></div>` : ''}
  ${trophies.length ? `<div class="sec"><div class="s-t"><span class="sym">♛</span> TROFI</div><div>${trophies.slice(0, 8).map(t => `<span class="club">★ ${esc(t.type || 'trophy')}</span>`).join('')}</div></div>` : ''}

  <div class="ft">CHESS.COM PUBLIC DATA · <a class="lnk" href="${esc(profile.url)}" target="_blank" rel="noopener">${esc(profile.url)}</a></div>
</div></body></html>`;
}

function wld(recent, u) {
  const a = analyze(recent, u);
  return `— ${a.w + a.l + a.d} GAME`;
}
