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

async function sendPushNotification(toUserId, payload) {
  const docs = await PushSub.find({ userId: toUserId });
  if (!docs.length) return;

  for (const doc of docs) {
    try {
      await webpush.sendNotification(doc.subscription, JSON.stringify(payload));
    } catch (e) {
      console.error(`[push] sendNotification failed for user ${toUserId}: status=${e.statusCode} msg=${e.message}`);
      if (e.statusCode === 410 || e.statusCode === 404 || e.statusCode === 401) {
        await PushSub.deleteOne({ _id: doc._id });
        console.log(`[push] deleted stale subscription for user ${toUserId}`);
      }
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
          title: 'テスト通知',
          body: '通知が正常に動作しています',
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: {}
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
