const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_VERSION = 4; // bump to force regeneration

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function makePNG(size) {
  const W = size, H = size;
  const cx = W / 2, cy = H / 2;
  const buf = Buffer.alloc(W * H * 4);

  // ── Step1: 暗いグリーングラデーション背景 (アプリ内の色に統一) ──
  // #0d1f14 → #04100a (左上→右下)
  const topR = 0x0d, topG = 0x1f, topB = 0x14;
  const botR = 0x04, botG = 0x10, botB = 0x0a;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x + y) / (W + H - 2);
      const i = (y * W + x) * 4;
      buf[i]     = lerp(topR, botR, t);
      buf[i + 1] = lerp(topG, botG, t);
      buf[i + 2] = lerp(topB, botB, t);
      buf[i + 3] = 255;
    }
  }

  // ── Step2: 中央ラジアルグロー (#3D9A6A) ──
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const glowR = W * 0.56;
      if (dist < glowR) {
        const alpha = Math.pow(1 - dist / glowR, 1.6) * 0.28;
        const i = (y * W + x) * 4;
        buf[i]     = Math.min(255, buf[i]     + Math.round(0x3d * alpha));
        buf[i + 1] = Math.min(255, buf[i + 1] + Math.round(0x9a * alpha));
        buf[i + 2] = Math.min(255, buf[i + 2] + Math.round(0x6a * alpha));
      }
    }
  }

  // ── Step3: 太い「C」アーク（白・中央より少し上） ──
  // C の開口部は右側。上下にキャップ付きで「CHA」の C を表現
  const cCX = cx + W * 0.03;
  const cCY = cy - H * 0.04;
  const outerR = W * 0.305;
  const innerR = W * 0.175;
  const openAngle = Math.PI * 0.37; // 右側開口の角度

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const dx = px - cCX, dy = py - cCY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist >= innerR && dist <= outerR) {
        const angle = Math.atan2(dy, dx);
        if (angle < -openAngle || angle > openAngle) {
          setPixel(buf, W, px, py, 255, 255, 255, 255);
        }
      }
    }
  }
  // C の上下キャップ（丸いエンド）
  const capR   = (outerR - innerR) / 2;
  const capMid = (outerR + innerR) / 2;
  drawCircle(buf, W, H,
    cCX + Math.cos(-openAngle) * capMid,
    cCY + Math.sin(-openAngle) * capMid,
    capR, 255, 255, 255, 255);
  drawCircle(buf, W, H,
    cCX + Math.cos(openAngle) * capMid,
    cCY + Math.sin(openAngle) * capMid,
    capR, 255, 255, 255, 255);

  // ── Step4: Cの開口内にアクセントドット (#3D9A6A) ──
  // 通知・アクティブを表す小さな緑の光る点
  const dotX = cCX + (innerR + outerR) / 2 * Math.cos(0) + W * 0.03;
  const dotY = cCY;
  const dotR = W * 0.065;
  // ドット本体
  drawCircle(buf, W, H, dotX, dotY, dotR, 0x3d, 0x9a, 0x6a, 255);
  // ドット内ハイライト（白い輝き）
  drawCircle(buf, W, H, dotX - dotR * 0.28, dotY - dotR * 0.28, dotR * 0.38, 255, 255, 255, 180);

  // ── Step5: C 下部にアクセントライン2本（チャットを示す） ──
  const lineBaseY = cCY + outerR + H * 0.055;
  const lh = Math.max(2, Math.round(H * 0.022));
  const lr = lh / 2;
  const lw1 = W * 0.34, lw2 = W * 0.22;
  // 1本目（長い）
  drawRoundRect(buf, W, H, cx - lw1 / 2, lineBaseY,        lw1, lh, lr, 0x3d, 0x9a, 0x6a, 190);
  // 2本目（短い）
  drawRoundRect(buf, W, H, cx - lw2 / 2, lineBaseY + lh * 1.8, lw2, lh, lr, 0x3d, 0x9a, 0x6a, 130);

  return encodePNG(buf, W, H);
}

// ──── ピクセル描画ユーティリティ ────

function setPixel(buf, W, x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W) return;
  const i = (y * W + x) * 4;
  if (buf[i + 3] === 0 || a === 255) {
    buf[i] = r; buf[i+1] = g; buf[i+2] = b; buf[i+3] = 255;
  } else {
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
  const sig  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = chunk('IHDR', (() => {
    const b = Buffer.alloc(13);
    b.writeUInt32BE(W,0); b.writeUInt32BE(H,4);
    b[8]=8; b[9]=6; b[10]=0; b[11]=0; b[12]=0; return b;
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
  return corners.some(([cx,cy]) => (px-cx)**2+(py-cy)**2 <= r*r);
}

function generate() {
  const pub   = path.join(__dirname, '..', 'public');
  const p192  = path.join(pub, 'icon-192.png');
  const p512  = path.join(pub, 'icon-512.png');
  const vFile = path.join(pub, '.icon-version');

  const currentVer = fs.existsSync(vFile) ? fs.readFileSync(vFile, 'utf8').trim() : '0';
  const needsRegen = currentVer !== String(ICON_VERSION);

  if (needsRegen || !fs.existsSync(p192)) {
    fs.writeFileSync(p192, makePNG(192));
    console.log('icon-192.png 生成完了 (v' + ICON_VERSION + ')');
  }
  if (needsRegen || !fs.existsSync(p512)) {
    fs.writeFileSync(p512, makePNG(512));
    console.log('icon-512.png 生成完了 (v' + ICON_VERSION + ')');
  }
  if (needsRegen) {
    fs.writeFileSync(vFile, String(ICON_VERSION));
  }
}

module.exports = { generate };
