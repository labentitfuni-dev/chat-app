require('dotenv').config();
require('./generate-icons').generate();
const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const jwt = require('jsonwebtoken');
const { connectDB } = require('./db');
const { router: errorRouter, logServerError } = require('./errorLogger');

// ── プロセスレベルの未捕捉エラーをログへ ──────────────────────
process.on('uncaughtException', (err) => {
  logServerError('uncaughtException', err);
  // プロセスは続行（本番では PM2/Heroku が自動再起動するため）
});
process.on('unhandledRejection', (reason) => {
  logServerError('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
});

const app = express();
const server = http.createServer(app);

// 本番では ALLOWED_ORIGIN 環境変数でオリジンを制限（例: https://cha.example.com）
// 未設定の場合は開発用に全許可
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const io = new Server(server, {
  cors: { origin: ALLOWED_ORIGIN, methods: ['GET', 'POST'] },
  // ★ 画像base64の上限(7MB)に合わせてバッファ制限を明示設定（デフォルト1MBと乖離を防ぐ）
  maxHttpBufferSize: 8 * 1024 * 1024, // 8MB
});

app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: '2mb' })); // リクエストボディサイズ制限

// ── セキュリティヘッダー（helmetなしで手動実装） ──────────────
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // ★ camera/microphone は通話機能で必要なので self を許可
  res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self), geolocation=()');
  // ★ HTTPS環境ではHSTSを有効化（MITM攻撃防止）
  if (ALLOWED_ORIGIN.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  // CSP: スクリプト・スタイルは同一オリジン + Google(OAuth) + socket.ioのみ許可
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://accounts.google.com https://apis.google.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https:; " +
    "connect-src 'self' wss: ws: https:; " +
    "media-src 'self' blob:; " +
    "worker-src 'self' blob:; " +
    "frame-src https://accounts.google.com;"
  );
  next();
});

// ── REST API レートリミット（パッケージ不要の軽量実装） ────────
// ★ 各インスタンスが独立したMapを持つ（共有すると二重カウントになるバグを防止）
function makeApiRateLimit(maxPerMin, windowMs = 60000) {
  const rates = new Map(); // ip -> { count, resetAt }
  // 古いエントリを定期クリーンアップ（メモリリーク防止）
  setInterval(() => {
    const now = Date.now();
    rates.forEach((v, k) => { if (now > v.resetAt + windowMs) rates.delete(k); });
  }, 5 * 60 * 1000);
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rates.get(ip);
    if (!entry || now > entry.resetAt) {
      rates.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    if (entry.count >= maxPerMin) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: 'リクエストが多すぎます。しばらく待ってから再試行してください' });
    }
    entry.count++;
    next();
  };
}

app.use('/api/', makeApiRateLimit(120));           // 全API: 1分120件
app.use('/api/auth/register', makeApiRateLimit(10, 60000));  // 登録: 厳しく1分10件（ブルートフォース対策）
app.use('/api/auth/login',    makeApiRateLimit(20, 60000));  // ログイン: 1分20件
app.use('/api/auth/search',   makeApiRateLimit(20, 60000));  // ★ フレンドコード検索: 1分20件（列挙攻撃対策）

// HTML / SW は常に最新版を返す（スマホ・PWAのキャッシュ対策）
const NO_CACHE = { 'Cache-Control': 'no-cache, no-store, must-revalidate', 'Pragma': 'no-cache', 'Expires': '0' };
app.get('/', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/call', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, '..', 'public', 'call.html'));
});

app.get('/google-callback', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, '..', 'public', 'google-callback.html'));
});

app.get('/sw.js', (req, res) => {
  res.set(NO_CACHE);
  res.sendFile(path.join(__dirname, '..', 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth',   require('./auth'));
app.use('/api/upload', makeApiRateLimit(20, 60000), require('./upload')); // ★ アップロードは1分20件まで
app.use('/api/push',   require('./push').router);
app.use('/api/errors', errorRouter);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));
app.get('/api/version', (req, res) => res.json({ version: 'v43' }));

// ── TURN HMAC認証クレデンシャル生成（coturn use-auth-secret 方式） ──────
// RFC 5766 時限クレデンシャル: username=有効期限タイムスタンプ, credential=HMAC-SHA1
function generateTurnCredentials(secret, ttlSeconds = 86400) {
  const expiry   = Math.floor(Date.now() / 1000) + ttlSeconds;
  const username = String(expiry);
  const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
  return { username, credential };
}

// ── ICEサーバー取得（JWT認証必須 → TURNクレデンシャルの漏洩防止） ──────
// 優先度: ①自己ホストcoturn(HMAC) > ②Metered API > ③STUNフォールバック
app.get('/api/ice-servers', makeApiRateLimit(30, 60000), async (req, res) => {
  // ★ JWT認証確認（未認証ユーザーにTURNクレデンシャルを渡さない）
  // トークンなし or 無効 → STUNのみ返して終了（通話自体はSTUNで試みる）
  try {
    const tok = req.headers.authorization?.split(' ')[1];
    if (!tok) throw new Error('no token');
    jwt.verify(tok, JWT_SECRET);
  } catch {
    return res.json([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ]);
  }

  // ① 自己ホスト TURN（coturn）: TURN_SECRET + TURN_URLS が設定されている場合
  //    coturn設定例: use-auth-secret=true / static-auth-secret=<TURN_SECRET>
  if (process.env.TURN_SECRET && process.env.TURN_URLS) {
    try {
      const { username, credential } = generateTurnCredentials(process.env.TURN_SECRET);
      const turnUrls = process.env.TURN_URLS.split(',')
        .map(u => u.trim()).filter(u => /^turns?:/.test(u));
      if (turnUrls.length > 0) {
        const iceServers = [
          { urls: 'stun:stun.l.google.com:19302' },
          ...turnUrls.map(urls => ({ urls, username, credential })),
        ];
        console.log('[ICE] 自己ホストTURNを返却:', turnUrls.length + '件');
        return res.json(iceServers);
      }
    } catch (e) {
      console.warn('[ICE] TURN HMAC生成失敗:', e.message);
    }
  }

  // ② Metered TURN API
  if (process.env.METERED_DOMAIN && process.env.METERED_API_KEY) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 5000);
      const url = `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(tid);
      if (!response.ok) throw new Error('Metered API error: ' + response.status);
      const iceServers = await response.json();
      if (Array.isArray(iceServers) && iceServers.length > 0) {
        console.log('[ICE] Metered TURNを返却');
        return res.json(iceServers);
      }
    } catch (e) {
      console.warn('[ICE] Metered取得失敗、フォールバックSTUNを使用:', e.message);
    }
  }

  // ③ フォールバック: 複数パブリックSTUN（冗長化）
  console.log('[ICE] STUNフォールバックを返却（TURN未設定）');
  res.json([
    { urls: 'stun:stun.l.google.com:19302'  },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
    { urls: 'stun:stun3.l.google.com:19302' },
    { urls: 'stun:openrelay.metered.ca:80'  },
  ]);
});

const { setupSocket } = require('./socketHandler');
setupSocket(io);

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`サーバー起動中: http://localhost:${PORT}`);
  });
});
