const express = require('express');
const webpush = require('web-push');
const jwt = require('jsonwebtoken');
const { PushSub } = require('./models');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

const VAPID_PUBLIC  = process.env.VAPID_PUBLIC  || 'BFgVoCicvPFBp2zeu0Es_LgMnqdIOXLdmJIvpcoIvKY88DdBErxdhVUqUt9GPKWUvEvE_qQXGmffESdovwS9XYk';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE || 'AyY3ZgNeGc5UomOk0Zcrb2BBPWchnRiIkE-f_TE_bvw';

webpush.setVapidDetails('mailto:admin@chatapp.com', VAPID_PUBLIC, VAPID_PRIVATE);

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: VAPID_PUBLIC });
});

router.post('/unsubscribe', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    await PushSub.deleteMany({ userId: id });
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.post('/subscribe', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const subscription = req.body;
    // ★ subscriptionオブジェクト構造を検証（Web Push仕様: endpoint + keys.p256dh + keys.auth が必須）
    if (!subscription || typeof subscription !== 'object' || Array.isArray(subscription)) {
      return res.status(400).json({ error: 'subscription が不正です' });
    }
    if (typeof subscription.endpoint !== 'string' || !subscription.endpoint.startsWith('https://') || subscription.endpoint.length > 2048) {
      return res.status(400).json({ error: 'endpoint が不正です' });
    }
    if (!subscription.keys || typeof subscription.keys !== 'object' ||
        typeof subscription.keys.p256dh !== 'string' || typeof subscription.keys.auth !== 'string') {
      return res.status(400).json({ error: 'subscription.keys が不正です' });
    }
    // 同じendpointがあれば上書き、なければ新規作成
    await PushSub.findOneAndUpdate(
      { userId: id, endpoint: subscription.endpoint },
      { userId: id, endpoint: subscription.endpoint, subscription },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(401).json({ error: 'トークンが無効です' });
  }
});

async function sendPushNotification(toUserId, payload, opts = {}) {
  const docs = await PushSub.find({ userId: toUserId });
  if (!docs.length) return;

  // urgency: 'high' → バッテリー節約モードでも即時配信（着信通知に必須）
  // TTL: 有効期限（秒）。0だと端末オフライン時に破棄される
  const pushOptions = {
    urgency: opts.urgency || 'normal',
    TTL:     opts.TTL !== undefined ? opts.TTL : 86400,
  };

  for (const doc of docs) {
    try {
      await webpush.sendNotification(doc.subscription, JSON.stringify(payload), pushOptions);
    } catch (e) {
      const code = e.statusCode;
      console.error(`[push] sendNotification failed for user ${toUserId}: status=${code} urgency=${pushOptions.urgency} msg=${e.message}`);
      if (code === 410 || code === 404 || code === 401) {
        // 購読が無効化された → DBから削除
        await PushSub.deleteOne({ _id: doc._id });
        console.log(`[push] deleted stale subscription for user ${toUserId}`);
      } else if (code === 429) {
        // レートリミット → 削除しない（一時的なもの）
        console.warn(`[push] rate limited for user ${toUserId}, skipping`);
      } else if (code === 400) {
        // リクエスト不正 → subscriptionデータが壊れている可能性
        console.error(`[push] bad request for user ${toUserId}, payload may be malformed`);
      }
      // その他の一時的エラー（5xx等）はretry不要（次の送信機会に自然に再試行）
    }
  }
}

router.post('/test', async (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const docs = await PushSub.find({ userId: id });
    if (!docs.length) return res.status(404).json({ error: 'no_subscription' });
    let sent = 0;
    const errors = [];
    for (const doc of docs) {
      try {
        await webpush.sendNotification(doc.subscription, JSON.stringify({
          title: '✅ CHA テスト通知',
          body: 'プッシュ通知が正常に動作しています！',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: { type: 'test' }
        }));
        sent++;
      } catch (e) {
        console.error(`[push/test] error: status=${e.statusCode} msg=${e.message}`);
        errors.push(String(e.statusCode || e.message));
        if (e.statusCode === 410 || e.statusCode === 404 || e.statusCode === 401) {
          await PushSub.deleteOne({ _id: doc._id });
        }
      }
    }
    res.json({ sent, errors, total: docs.length });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

module.exports = { router, sendPushNotification };
