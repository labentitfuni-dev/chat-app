const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_VERSION = 2; // bump to force regeneration

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function makePNG(size) {
  const W = size, H = size;
  const cx = W / 2, cy = H / 2;

  // グラデーション: 左上 #18e070 → 右下 #04a040
  const topR = 0x07, topG = 0xd4, topB = 0x5a;
  const botR = 0x04, botG = 0x97, botB = 0x3c;

  const buf = Buffer.alloc(W * H * 4);

  // Step1: グラデーション背景
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x + y) / (W + H - 2); // 左上→右下グラデーション
      const i = (y * W + x) * 4;
      buf[i]     = lerp(topR, botR, t);
      buf[i + 1] = lerp(topG, botG, t);
      buf[i + 2] = lerp(topB, botB, t);
      buf[i + 3] = 255;
    }
  }

  // Step2: 白い光沢ハイライト (左上1/3付近に薄い白円)
  const glowCX = W * 0.35, glowCY = H * 0.28, glowR = W * 0.55;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - glowCX, dy = y - glowCY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < glowR) {
        const alpha = (1 - dist / glowR) * 0.13; // 最大13%の白みがけ
        const i = (y * W + x) * 4;
        buf[i]     = Math.min(255, buf[i]     + Math.round(255 * alpha));
        buf[i + 1] = Math.min(255, buf[i + 1] + Math.round(255 * alpha));
        buf[i + 2] = Math.min(255, buf[i + 2] + Math.round(255 * alpha));
      }
    }
  }

  // Step3: メインチャットバブル（大、右寄り気味）
  const bw = W * 0.58, bh = H * 0.44;
  const bx = cx - bw * 0.45, by = cy - bh * 0.60;
  const br = bh * 0.28;
  drawRoundRect(buf, W, H, bx, by, bw, bh, br, 255, 255, 255, 255);

  // バブルの尻尾（右下）
  const tx1 = bx + bw * 0.65, ty1 = by + bh;
  const tx2 = bx + bw * 0.88, ty2 = by + bh;
  const tx3 = bx + bw * 0.78, ty3 = by + bh + H * 0.10;
  drawTriangle(buf, W, H, tx1, ty1, tx2, ty2, tx3, ty3, 255, 255, 255, 255);

  // Step4: サブチャットバブル（小、左下）
  const sw = W * 0.40, sh = H * 0.28;
  const sx = cx - bw * 0.45 - sw * 0.1, sy = by + bh + H * 0.06;
  const sr = sh * 0.3;
  // サブバブルは半透明白 (255,255,255,200)
  drawRoundRect(buf, W, H, sx, sy, sw, sh, sr, 255, 255, 255, 200);

  // サブバブルの尻尾（左下）
  const stx1 = sx + sw * 0.10, sty1 = sy + sh;
  const stx2 = sx + sw * 0.30, sty2 = sy + sh;
  const stx3 = sx + sw * 0.12, sty3 = sy + sh + H * 0.07;
  drawTriangle(buf, W, H, stx1, sty1, stx2, sty2, stx3, sty3, 255, 255, 255, 200);

  // Step5: メインバブル内に3つのドット
  const dotY = by + bh * 0.50;
  const dotR = W * 0.038;
  const dotSpacing = W * 0.11;
  const dotStartX = bx + bw * 0.28;
  const dotColor = [0x06, 0xC7, 0x55, 255]; // グリーンドット
  for (let d = 0; d < 3; d++) {
    const dotCX = dotStartX + d * dotSpacing;
    drawCircle(buf, W, H, dotCX, dotY, dotR, dotColor[0], dotColor[1], dotColor[2], dotColor[3]);
  }

  return encodePNG(buf, W, H);
}

function setPixel(buf, W, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W) return;
  const i = (y * W + x) * 4;
  if (a === 255) {
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  } else {
    // アルファブレンド
    const sa = a / 255;
    buf[i]   = Math.round(buf[i]   * (1 - sa) + r * sa);
    buf[i+1] = Math.round(buf[i+1] * (1 - sa) + g * sa);
    buf[i+2] = Math.round(buf[i+2] * (1 - sa) + b * sa);
    buf[i+3] = 255;
  }
}

function drawRoundRect(buf, W, H, x, y, w, h, r, pr, pg, pb, pa) {
  for (let py = Math.floor(y); py <= Math.ceil(y + h); py++) {
    for (let px = Math.floor(x); px <= Math.ceil(x + w); px++) {
      if (py < 0 || py >= H) continue;
      if (insideRoundRect(px, py, x, y, w, h, r)) {
        setPixel(buf, W, px, py, pr, pg, pb, pa);
      }
    }
  }
}

function drawTriangle(buf, W, H, x1, y1, x2, y2, x3, y3, pr, pg, pb, pa) {
  const minX = Math.floor(Math.min(x1, x2, x3));
  const maxX = Math.ceil(Math.max(x1, x2, x3));
  const minY = Math.floor(Math.min(y1, y2, y3));
  const maxY = Math.ceil(Math.max(y1, y2, y3));
  for (let py = minY; py <= maxY; py++) {
    for (let px = minX; px <= maxX; px++) {
      if (py < 0 || py >= H) continue;
      if (insideTriangle(px, py, x1, y1, x2, y2, x3, y3)) {
        setPixel(buf, W, px, py, pr, pg, pb, pa);
      }
    }
  }
}

function drawCircle(buf, W, H, cx, cy, r, pr, pg, pb, pa) {
  const x0 = Math.floor(cx - r), x1 = Math.ceil(cx + r);
  const y0 = Math.floor(cy - r), y1 = Math.ceil(cy + r);
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      if (py < 0 || py >= H) continue;
      const dx = px - cx, dy = py - cy;
      if (dx * dx + dy * dy <= r * r) {
        setPixel(buf, W, px, py, pr, pg, pb, pa);
      }
    }
  }
}

function encodePNG(buf, W, H) {
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
  const vFile = path.join(pub, '.icon-version');

  // バージョンが変わったら再生成
  const currentVer = fs.existsSync(vFile) ? fs.readFileSync(vFile, 'utf8').trim() : '0';
  const needsRegen = currentVer !== String(ICON_VERSION);

  if (needsRegen || !fs.existsSync(p192)) {
    fs.writeFileSync(p192, makePNG(192));
    console.log('icon-192.png 生成完了');
  }
  if (needsRegen || !fs.existsSync(p512)) {
    fs.writeFileSync(p512, makePNG(512));
    console.log('icon-512.png 生成完了');
  }
  if (needsRegen) {
    fs.writeFileSync(vFile, String(ICON_VERSION));
  }
}

module.exports = { generate };
