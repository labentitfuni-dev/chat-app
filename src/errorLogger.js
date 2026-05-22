/**
 * エラーログ収集モジュール
 * フロントエンドからのエラーをサーバーサイドで記録する
 * 商用環境では Sentry / Datadog に置き換え可能
 */
const fs = require('fs');
const path = require('path');
const express = require('express');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const LOG_DIR  = path.join(__dirname, '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'errors.jsonl');
const MAX_LOG_BYTES = 10 * 1024 * 1024; // 10MB でローテート

// ログディレクトリ作成
if (!fs.existsSync(LOG_DIR)) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch {}
}

/**
 * ログを1行JSONで書き込む（JSONL形式）
 */
function writeLog(entry) {
  try {
    // ファイルサイズ超過時はローテート
    try {
      const stat = fs.statSync(LOG_FILE);
      if (stat.size > MAX_LOG_BYTES) {
        fs.renameSync(LOG_FILE, LOG_FILE + '.bak');
      }
    } catch {}
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
  } catch {}
}

/**
 * バックエンド側のエラーをコンソール＋ファイルに記録
 */
function logServerError(context, error, extra = {}) {
  const entry = {
    ts:      new Date().toISOString(),
    level:   'error',
    source:  'server',
    context,
    message: error?.message || String(error),
    stack:   error?.stack?.split('\n').slice(0, 5).join(' | '),
    ...extra
  };
  console.error(`[ERROR] ${context}:`, error?.message || error);
  writeLog(entry);
}

/**
 * Express ルーター: POST /api/errors
 */
const router = express.Router();

// IP別レートリミット（ログフラッディング防止: 1分に20件まで）
const _logRates = new Map();
function isLogAllowed(ip) {
  const now = Date.now();
  const entry = _logRates.get(ip);
  if (!entry || now > entry.resetAt) {
    _logRates.set(ip, { count: 1, resetAt: now + 60000 });
    return true;
  }
  if (entry.count >= 20) return false;
  entry.count++;
  return true;
}
// 古いエントリを5分ごとにクリーンアップ（メモリリーク防止）
setInterval(() => {
  const now = Date.now();
  _logRates.forEach((v, k) => { if (now > v.resetAt + 60000) _logRates.delete(k); });
}, 5 * 60 * 1000);

router.post('/', (req, res) => {
  // レートリミット確認
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  if (!isLogAllowed(ip)) {
    return res.status(429).json({ error: 'rate limit' });
  }
  try {
    // 認証チェック（任意 — 未認証でも記録する設計も可）
    let userId = 'anonymous';
    try {
      const tok = req.headers.authorization?.split(' ')[1];
      if (tok) {
        const payload = jwt.verify(tok, JWT_SECRET);
        userId = payload.id;
      }
    } catch {}

    const { context, detail, page, ua, ts } = req.body || {};
    if (!context) return res.status(400).json({ error: 'context required' });

    const entry = {
      ts:      new Date().toISOString(),
      level:   'error',
      source:  'client',
      userId,
      page:    page || 'unknown',
      context: String(context).slice(0, 200),
      detail:  String(detail || '').slice(0, 500),
      ua:      String(ua || '').slice(0, 200),
      // ★ clientTs は数値のみ許可（不正な型をログに混入させない）
      clientTs: typeof ts === 'number' && ts > 0 ? ts : null
    };

    console.warn(`[CLIENT-ERROR] ${entry.page}/${entry.context}: ${entry.detail}`);
    writeLog(entry);

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'log failed' });
  }
});

/**
 * 最新エラー50件を返す（デバッグ用 — 認証必須）
 */
router.get('/', (req, res) => {
  try {
    const tok = req.headers.authorization?.split(' ')[1];
    if (!tok) return res.status(401).json({ error: 'unauthorized' });
    jwt.verify(tok, JWT_SECRET); // 認証確認だけ

    if (!fs.existsSync(LOG_FILE)) return res.json([]);
    const lines = fs.readFileSync(LOG_FILE, 'utf8')
      .split('\n')
      .filter(Boolean)
      .slice(-50)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .reverse();
    res.json(lines);
  } catch {
    res.status(401).json({ error: 'unauthorized' });
  }
});

module.exports = { router, logServerError };
