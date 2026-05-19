const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

function makePNG(size) {
  const W = size, H = size;
  const cx = W / 2, cy = H / 2;

  // ピクセルバッファ（RGBA）
  const buf = Buffer.alloc(W * H * 4);

  // 背景: #06C755
  for (let i = 0; i < W * H; i++) {
    buf[i * 4]     = 6;
    buf[i * 4 + 1] = 199;
    buf[i * 4 + 2] = 85;
    buf[i * 4 + 3] = 255;
  }

  // 角丸の背景をアルファで丸くする（アイコン全体を丸くしない、iOSが自動で丸める）
  // チャットバブルを描く
  const bw = W * 0.62, bh = H * 0.48;
  const bx = cx - bw / 2, by = cy - bh / 2 - H * 0.03;
  const r  = bh * 0.3;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const inBubble = insideRoundRect(x, y, bx, by, bw, bh, r);
      // 吹き出しの尻尾（左下の三角）
      const tailX1 = bx + bw * 0.12, tailY1 = by + bh;
      const tailX2 = bx + bw * 0.38, tailY2 = by + bh;
      const tailX3 = bx + bw * 0.18, tailY3 = by + bh + H * 0.12;
      const inTail  = insideTriangle(x, y, tailX1, tailY1, tailX2, tailY2, tailX3, tailY3);

      if (inBubble || inTail) {
        buf[(y * W + x) * 4]     = 255;
        buf[(y * W + x) * 4 + 1] = 255;
        buf[(y * W + x) * 4 + 2] = 255;
        buf[(y * W + x) * 4 + 3] = 255;
      }
    }
  }

  // フィルタなし（各スキャンラインの先頭に 0x00 を付加）
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (W * 4 + 1)] = 0;
    buf.copy(raw, y * (W * 4 + 1) + 1, y * W * 4, (y + 1) * W * 4);
  }

  const compressed = zlib.deflateSync(raw);

  const sig  = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = chunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(W, 0); b.writeUInt32BE(H, 4);
    b[8] = 8; b[9] = 6; b[10] = 0; b[11] = 0; b[12] = 0;
    return b;
  })());
  const idat = chunk('IDAT', compressed);
  const iend = chunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdr, idat, iend]);
}

function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t   = Buffer.from(type, 'ascii');
  const crc = crc32(Buffer.concat([t, data]));
  const c   = Buffer.alloc(4); c.writeUInt32BE(crc >>> 0, 0);
  return Buffer.concat([len, t, data, c]);
}

function crc32(buf) {
  let crc = 0xFFFFFFFF;
  for (const b of buf) {
    crc ^= b;
    for (let i = 0; i < 8; i++) crc = (crc & 1) ? (crc >>> 1) ^ 0xEDB88320 : crc >>> 1;
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px < x || px > x + w || py < y || py > y + h) return false;
  if (px > x + r && px < x + w - r) return true;
  if (py > y + r && py < y + h - r) return true;
  const corners = [[x+r,y+r],[x+w-r,y+r],[x+r,y+h-r],[x+w-r,y+h-r]];
  return corners.some(([cx,cy]) => (px-cx)**2 + (py-cy)**2 <= r*r);
}

function insideTriangle(px, py, x1, y1, x2, y2, x3, y3) {
  const d1 = sign(px,py,x1,y1,x2,y2), d2 = sign(px,py,x2,y2,x3,y3), d3 = sign(px,py,x3,y3,x1,y1);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0, hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}
function sign(px,py,x1,y1,x2,y2) { return (px-x2)*(y1-y2) - (x1-x2)*(py-y2); }

function generate() {
  const pub = path.join(__dirname, '..', 'public');
  const p192 = path.join(pub, 'icon-192.png');
  const p512 = path.join(pub, 'icon-512.png');
  if (!fs.existsSync(p192)) { fs.writeFileSync(p192, makePNG(192)); console.log('icon-192.png 生成完了'); }
  if (!fs.existsSync(p512)) { fs.writeFileSync(p512, makePNG(512)); console.log('icon-512.png 生成完了'); }
}

module.exports = { generate };
