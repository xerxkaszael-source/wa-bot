// Board → PNG renderer with no external dependencies (raw RGBA canvas + Node zlib).
// Universal realtime board image for WhatsApp clients that cannot render GenAI HTML
// mini-apps (e.g. WhatsApp Business on iOS). Pieces are drawn as real silhouettes
// (pawn/rook/knight/bishop/queen/king), not letters.
import zlib from 'node:zlib';

const FILES = 'abcdefgh';
const SIZE = 60;
const MARGIN = 26;
const W = SIZE * 8 + MARGIN * 2;
const H = W;
const LIGHT = [235, 236, 208];
const DARK = [119, 149, 86];
const HIGHLIGHT = [246, 233, 120];
const WHITE_PIECE = [248, 250, 252];
const BLACK_PIECE = [28, 32, 30];
const OUTLINE_W = [70, 74, 66];    // outline for white pieces
const OUTLINE_B = [225, 228, 216]; // outline for black pieces
const LABEL = [235, 240, 232];

// 5x7 pixel glyphs for coordinate labels (a-h, 1-8)
const FONT = {
  a: ['00000', '00000', '01110', '00001', '01111', '10001', '01111'],
  b: ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
  c: ['00000', '00000', '01110', '10000', '10000', '10001', '01110'],
  d: ['00001', '00001', '01111', '10001', '10001', '10001', '01111'],
  e: ['00000', '00000', '01110', '10001', '11111', '10000', '01110'],
  f: ['00110', '01000', '11110', '01000', '01000', '01000', '01000'],
  g: ['00000', '01111', '10001', '10001', '01111', '00001', '01110'],
  h: ['10000', '10000', '11110', '10001', '10001', '10001', '11110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11110', '00001', '00001', '01110', '00001', '00001', '11110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110']
};

// --- tiny PNG writer (RGBA 8-bit) ---
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = ~0;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function encodePNG(pixels, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// --- pixel canvas ---
function makeCanvas(pixels) {
  const put = (x, y, rgba) => {
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const i = (y * W + x) * 4;
    pixels[i] = rgba[0]; pixels[i + 1] = rgba[1]; pixels[i + 2] = rgba[2]; pixels[i + 3] = 255;
  };
  return put;
}

// helpers drawn on `put`; every shape() takes a color — outline is produced by
// stamping the shape in the outline colour shifted by +/-3 px, then the fill on top
function withOutline(put, outline, draw) {
  for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]])
    draw((color) => color, dx, dy, outline);
  draw((color) => color, 0, 0, outline); // seam fill
  draw(() => null, 0, 0); // NO-OP placeholder (replaced below)
}
// simpler explicit variant: pusher(dx,dy) draws primitive shifted
function stampOutlined(put, outline, fill, stamp) {
  if (outline) for (const [dx, dy] of [[3, 0], [-3, 0], [0, 3], [0, -3], [2, 2], [-2, 2], [2, -2], [-2, -2]])
    stamp(outline, dx, dy);
  stamp(fill, 0, 0);
}

function rect(put, cx, cy, w, h, color, dx = 0, dy = 0) {
  const x0 = Math.round(cx + dx - w / 2), y0 = Math.round(cy + dy - h / 2);
  for (let y = y0; y < y0 + Math.round(h); y++)
    for (let x = x0; x < x0 + Math.round(w); x++) put(x, y, color);
}
function circle(put, cx, cy, r, color, dx = 0, dy = 0) {
  for (let y = Math.round(cy + dy - r); y <= Math.round(cy + dy + r); y++) {
    const dyy = y - (cy + dy);
    const dxx = Math.sqrt(Math.max(0, r * r - dyy * dyy));
    for (let x = Math.round(cx + dx - dxx); x <= Math.round(cx + dx + dxx); x++) put(x, y, color);
  }
}
// trapezoid: top width tw at yTop, bottom width bw at yBot
function trap(put, cx, yTop, yBot, tw, bw, color, dx = 0, dy = 0) {
  const rows = Math.max(1, Math.round(yBot - yTop));
  for (let i = 0; i <= rows; i++) {
    const y = Math.round(yTop + dy) + i;
    const w = tw + (bw - tw) * Math.min(1, i / rows);
    for (let x = Math.round(cx + dx - w / 2); x <= Math.round(cx + dx + w / 2); x++) put(x, y, color);
  }
}

// Real-ish piece silhouettes. (cx, baseY) = center of piece standing on its base.
function drawPiece(put, type, cx, baseY, fill, outline) {
  const s = (col, dx, dy) => {
    rect(put, cx, baseY - 3, 32, 6, col, dx, dy);
    rect(put, cx, baseY - 8, 24, 5, col, dx, dy);
  };
  stampOutlined(put, outline, fill, s);
  const body = (col, dx, dy) => {
    switch (type) {
      case 'p': { // pawn: skirt + neck + head
        trap(put, cx, baseY - 16, baseY - 10, 10, 26, col, dx, dy);
        rect(put, cx, baseY - 27, 11, 10, col, dx, dy);
        circle(put, cx, baseY - 33, 6, col, dx, dy);
        break;
      }
      case 'r': { // rook: flare + tower + crenellations
        trap(put, cx, baseY - 14, baseY - 10, 20, 30, col, dx, dy);
        rect(put, cx, baseY - 24, 23, 11, col, dx, dy);
        for (const ddx of [-8, 0, 8]) rect(put, cx + ddx, baseY - 30, 6, 7, col, 0, 0);
        break;
      }
      case 'n': { // knight: flare + neck + head + muzzle
        trap(put, cx, baseY - 12, baseY - 10, 16, 30, col, dx, dy);
        rect(put, cx + 4, baseY - 21, 25, 11, col, dx, dy);      // muzzle
        trap(put, cx + 6, baseY - 35, baseY - 17, 9, 24, col);   // neck (no outline offset)
        circle(put, cx - 9, baseY - 33, 5.5, col, dx, dy);       // brow/mane
        rect(put, cx - 7, baseY - 39, 4, 8, col, 0, 0);          // ear
        break;
      }
      case 'b': { // bishop: flare + mitre + slit + top ball
        trap(put, cx, baseY - 17, baseY - 10, 11, 28, col, dx, dy);
        circle(put, cx, baseY - 24, 9.5, col, dx, dy);
        rect(put, cx, baseY - 25, 3.5, 13, col, 0, 0);           // mitre slit
        circle(put, cx, baseY - 37, 5, col, dx, dy);             // top ball
        break;
      }
      case 'q': { // queen: flare + head/dress + crown points
        trap(put, cx, baseY - 17, baseY - 10, 13, 31, col, dx, dy);
        circle(put, cx, baseY - 25, 9.5, col, dx, dy);
        for (const [ddx, ddy] of [[-10, -3], [0, -7], [10, -3]]) circle(put, cx + ddx, baseY - 32 + ddy, 3.5, col, 0, 0);
        break;
      }
      case 'k': { // king: flare + crown + cross
        trap(put, cx, baseY - 17, baseY - 10, 13, 31, col, dx, dy);
        rect(put, cx, baseY - 25, 21, 10, col, dx, dy);
        rect(put, cx, baseY - 39, 4.5, 13, col, 0, 0);           // cross vertical
        rect(put, cx, baseY - 35, 13, 4.5, col, 0, 0);           // cross horizontal
        break;
      }
    }
  };
  stampOutlined(put, outline, fill, body);
}

function drawGlyph(put, ch, cx, cy, scale, color) {
  const rows = FONT[ch];
  if (!rows) return;
  const x0 = Math.round(cx - 2.5 * scale), y0 = Math.round(cy - 3.5 * scale);
  for (let gy = 0; gy < 7; gy++) for (let gx = 0; gx < 5; gx++) {
    if (rows[gy][gx] === '1')
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) put(x0 + gx * scale + sx, y0 + gy * scale + sy, color);
  }
}

export function boardPNG(chess, last = null) {
  const pixels = Buffer.alloc(W * H * 4, 0);
  const put = makeCanvas(pixels);
  for (let i = 0; i < pixels.length; i += 4) { pixels[i] = 20; pixels[i + 1] = 24; pixels[i + 2] = 22; pixels[i + 3] = 255; } // bg
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const file = FILES[c], rank = 8 - r;
    let col = (r + c) % 2 === 0 ? LIGHT : DARK;
    if (last && (last.from === file + rank || last.to === file + rank)) col = HIGHLIGHT;
    rect(put, MARGIN + c * SIZE + SIZE / 2, MARGIN + r * SIZE + SIZE / 2, SIZE, SIZE, col);
  }
  for (let c = 0; c < 8; c++) drawGlyph(put, FILES[c], MARGIN + c * SIZE + SIZE / 2, MARGIN / 2 + 2, 2, LABEL);
  for (let r = 0; r < 8; r++) drawGlyph(put, String(8 - r), MARGIN / 2, MARGIN + r * SIZE + SIZE / 2, 2, LABEL);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const piece = chess.get(FILES[c] + (8 - r));
    if (!piece) continue;
    const dark = piece.color !== 'w';
    drawPiece(put, piece.type, MARGIN + c * SIZE + SIZE / 2, MARGIN + r * SIZE + SIZE - 6,
      dark ? BLACK_PIECE : WHITE_PIECE, dark ? OUTLINE_B : OUTLINE_W);
  }
  return encodePNG(pixels, W, H);
}
