const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICON_VERSION = 6; // bump to force regeneration

function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

function makePNG(size) {
  const W = size, H = size;
  const cx = W / 2, cy = H / 2;
  const buf = Buffer.alloc(W * H * 4);

  // ── 背景: 明るめの親しみやすいグリーン (#3a7d54 → #1e4d32) ──
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const t = (x + y) / (W + H - 2);
      const i = (y * W + x) * 4;
      buf[i]   = lerp(0x2a, 0x16, t);
      buf[i+1] = lerp(0x6a, 0x40, t);
      buf[i+2] = lerp(0x44, 0x28, t);
      buf[i+3] = 255;
    }
  }

  // ── 中央グロー (明るく温かい光) ──
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const dx = x - cx, dy = y - cy;
      const dist = Math.sqrt(dx*dx + dy*dy);
      const glowR = W * 0.60;
      if (dist < glowR) {
        const a = Math.pow(1 - dist/glowR, 1.6) * 0.30;
        const i = (y*W+x)*4;
        buf[i]   = Math.min(255, buf[i]   + Math.round(0x80 * a));
        buf[i+1] = Math.min(255, buf[i+1] + Math.round(0xff * a));
        buf[i+2] = Math.min(255, buf[i+2] + Math.round(0xa0 * a));
      }
    }
  }

  // ── メインチャットバブル (白・大きめ・丸くて親しみやすい) ──
  // バブルは中央やや上に配置
  const bW = W * 0.64, bH = H * 0.50;
  const bX = cx - bW * 0.50, bY = cy - bH * 0.62;
  const bR = bH * 0.42; // 大きな丸みで親しみやすく
  drawRoundRect(buf, W, H, bX, bY, bW, bH, bR, 255, 255, 255, 255);

  // バブルの尻尾 (左下・自然な形)
  const tailTip = { x: bX + bW*0.18, y: bY + bH + H*0.095 };
  const tailL   = { x: bX + bW*0.08, y: bY + bH - 2 };
  const tailR   = { x: bX + bW*0.34, y: bY + bH - 2 };
  drawTriangle(buf, W, H, tailL.x, tailL.y, tailR.x, tailR.y, tailTip.x, tailTip.y, 255, 255, 255, 255);
  // 尻尾の付け根を丸くなじませる
  drawCircle(buf, W, H, bX + bW*0.21, bY + bH - 1, bH*0.06, 255, 255, 255, 255);

  // ── バブル内に3つのドット (アプリグリーン #3D9A6A) ──
  const dotY    = bY + bH * 0.52;
  const dotR    = W * 0.048;
  const dotGap  = W * 0.125;
  const dotStartX = cx - dotGap;
  for (let d = 0; d < 3; d++) {
    const dx = dotStartX + d * dotGap;
    // ドット本体
    drawCircle(buf, W, H, dx, dotY, dotR, 0x3d, 0x9a, 0x6a, 255);
    // ドット内の白ハイライト (立体感)
    drawCircle(buf, W, H, dx - dotR*0.28, dotY - dotR*0.28, dotR*0.35, 255, 255, 255, 160);
  }

  // ── 小さいサブバブル (右下・会話感を演出) ──
  const sW = W * 0.30, sH = H * 0.20;
  const sX = bX + bW * 0.58, sY = bY + bH + H*0.04;
  const sR = sH * 0.45;
  drawRoundRect(buf, W, H, sX, sY, sW, sH, sR, 0x3d, 0x9a, 0x6a, 230);
  // サブバブルの尻尾 (右上)
  const stx1 = sX + sW*0.55, sty1 = sY + 2;
  const stx2 = sX + sW*0.80, sty2 = sY + 2;
  const stx3 = sX + sW*0.72, sty3 = sY - H*0.055;
  drawTriangle(buf, W, H, stx1, sty1, stx2, sty2, stx3, sty3, 0x3d, 0x9a, 0x6a, 230);
  // サブバブル内に小ドット (白)
  const sdotY = sY + sH*0.52;
  const sdotR = W * 0.028;
  const sdotGap = sW * 0.28;
  for (let d = 0; d < 3; d++) {
    drawCircle(buf, W, H, sX + sW*0.20 + d*sdotGap, sdotY, sdotR, 255, 255, 255, 210);
  }

  return encodePNG(buf, W, H);
}

// ──── ユーティリティ ────

function setPixel(buf, W, x, y, r, g, b, a) {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= W) return;
  const i = (yi * W + xi) * 4;
  if (i < 0 || i + 3 >= buf.length) return;
  if (a === 255) {
    buf[i]=r; buf[i+1]=g; buf[i+2]=b; buf[i+3]=255;
  } else {
    const sa = a/255;
    buf[i]   = Math.round(buf[i]   * (1-sa) + r*sa);
    buf[i+1] = Math.round(buf[i+1] * (1-sa) + g*sa);
    buf[i+2] = Math.round(buf[i+2] * (1-sa) + b*sa);
    buf[i+3] = 255;
  }
}

function drawRoundRect(buf, W, H, x, y, w, h, r, pr, pg, pb, pa) {
  for (let py = Math.floor(y); py <= Math.ceil(y+h); py++) {
    for (let px = Math.floor(x); px <= Math.ceil(x+w); px++) {
      if (py < 0 || py >= H) continue;
      if (insideRoundRect(px, py, x, y, w, h, r)) setPixel(buf, W, px, py, pr, pg, pb, pa);
    }
  }
}

function drawTriangle(buf, W, H, x1, y1, x2, y2, x3, y3, pr, pg, pb, pa) {
  const minX=Math.floor(Math.min(x1,x2,x3)), maxX=Math.ceil(Math.max(x1,x2,x3));
  const minY=Math.floor(Math.min(y1,y2,y3)), maxY=Math.ceil(Math.max(y1,y2,y3));
  for (let py=minY; py<=maxY; py++) {
    for (let px=minX; px<=maxX; px++) {
      if (py<0||py>=H) continue;
      if (insideTriangle(px,py,x1,y1,x2,y2,x3,y3)) setPixel(buf,W,px,py,pr,pg,pb,pa);
    }
  }
}

function drawCircle(buf, W, H, cx, cy, r, pr, pg, pb, pa) {
  const x0=Math.floor(cx-r), x1=Math.ceil(cx+r);
  const y0=Math.floor(cy-r), y1=Math.ceil(cy+r);
  for (let py=y0; py<=y1; py++) {
    for (let px=x0; px<=x1; px++) {
      if (py<0||py>=H) continue;
      const dx=px-cx, dy=py-cy;
      if (dx*dx+dy*dy<=r*r) setPixel(buf,W,px,py,pr,pg,pb,pa);
    }
  }
}

function encodePNG(buf, W, H) {
  const raw = Buffer.alloc(H * (1 + W*4));
  for (let y=0; y<H; y++) {
    raw[y*(W*4+1)] = 0;
    buf.copy(raw, y*(W*4+1)+1, y*W*4, (y+1)*W*4);
  }
  const compressed = zlib.deflateSync(raw);
  const sig  = Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]);
  const ihdr = chunk('IHDR', (() => {
    const b=Buffer.alloc(13);
    b.writeUInt32BE(W,0); b.writeUInt32BE(H,4);
    b[8]=8; b[9]=6; b[10]=0; b[11]=0; b[12]=0; return b;
  })());
  return Buffer.concat([sig, ihdr, chunk('IDAT',compressed), chunk('IEND',Buffer.alloc(0))]);
}

function chunk(type, data) {
  const len=Buffer.alloc(4); len.writeUInt32BE(data.length,0);
  const t=Buffer.from(type,'ascii');
  const crc=crc32(Buffer.concat([t,data]));
  const c=Buffer.alloc(4); c.writeUInt32BE(crc>>>0,0);
  return Buffer.concat([len,t,data,c]);
}

function crc32(buf) {
  let crc=0xFFFFFFFF;
  for (const b of buf) { crc^=b; for (let i=0;i<8;i++) crc=(crc&1)?(crc>>>1)^0xEDB88320:crc>>>1; }
  return (crc^0xFFFFFFFF)>>>0;
}

function insideRoundRect(px, py, x, y, w, h, r) {
  if (px<x||px>x+w||py<y||py>y+h) return false;
  if (px>x+r&&px<x+w-r) return true;
  if (py>y+r&&py<y+h-r) return true;
  const corners=[[x+r,y+r],[x+w-r,y+r],[x+r,y+h-r],[x+w-r,y+h-r]];
  return corners.some(([cx,cy])=>(px-cx)**2+(py-cy)**2<=r*r);
}

function insideTriangle(px,py,x1,y1,x2,y2,x3,y3) {
  const d1=sign(px,py,x1,y1,x2,y2), d2=sign(px,py,x2,y2,x3,y3), d3=sign(px,py,x3,y3,x1,y1);
  return !((d1<0||d2<0||d3<0)&&(d1>0||d2>0||d3>0));
}
function sign(px,py,x1,y1,x2,y2){return(px-x2)*(y1-y2)-(x1-x2)*(py-y2);}

function generate() {
  const pub   = path.join(__dirname,'..','public');
  const p192  = path.join(pub,'icon-192.png');
  const p512  = path.join(pub,'icon-512.png');
  const vFile = path.join(pub,'.icon-version');

  const currentVer = fs.existsSync(vFile) ? fs.readFileSync(vFile,'utf8').trim() : '0';
  if (currentVer !== String(ICON_VERSION) || !fs.existsSync(p192)) {
    fs.writeFileSync(p192, makePNG(192));
    console.log('icon-192.png 生成完了 (v'+ICON_VERSION+')');
  }
  if (currentVer !== String(ICON_VERSION) || !fs.existsSync(p512)) {
    fs.writeFileSync(p512, makePNG(512));
    console.log('icon-512.png 生成完了 (v'+ICON_VERSION+')');
  }
  if (currentVer !== String(ICON_VERSION)) fs.writeFileSync(vFile, String(ICON_VERSION));
}

module.exports = { generate };
