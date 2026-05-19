const express = require('express');
const webpush = require('web-push');
const jwt = require('jsonwebtoken');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BFgVoCicvPFBp2zeu0Es_LgMnqdIOXLdmJIvpcoIvKY88DdBErxdhVUqUt9GPKWUvEvE_qQXGmffESdovwS9XYk';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'AyY3ZgNeGc5UomOk0Zcrb2BBPWchnRiIkE-f_TE_bvw';

webpush.setVapidDetails('mailto:admin@chatapp.com', VAPID_PUBLIC, VAPID_PRIVATE);

// userId → [subscription, ...] のマップ（メモリ保存）
const subscriptions = new Map();

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

router.post('/subscribe', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const subscription = req.body;
    if (!subscriptions.has(id)) subscriptions.set(id, []);
    // 重複を避ける
    const list = subscriptions.get(id);
    const exists = list.some(s => s.endpoint === subscription.endpoint);
    if (!exists) list.push(subscription);
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

async function sendPushNotification(toUserId, payload) {
  const list = subscriptions.get(toUserId);
  if (!list || list.length === 0) return;

  const dead = [];
  for (const sub of list) {
    try {
      await webpush.sendNotification(sub, JSON.stringify(payload));
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) dead.push(sub.endpoint);
    }
  }
  // 無効なサブスクリプションを削除
  if (dead.length > 0) {
    subscriptions.set(toUserId, list.filter(s => !dead.includes(s.endpoint)));
  }
}

module.exports = { router, sendPushNotification };
