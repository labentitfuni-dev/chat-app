const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('./models');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

function verifyToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('認証が必要です');
  return jwt.verify(token, JWT_SECRET);
}

function safeUser(u) {
  return { id: u._id.toString(), username: u.username, displayName: u.displayName, friendCode: u.friendCode, friends: u.friends || [], avatar: u.avatar || '' };
}

async function generateFriendCode() {
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (await User.findOne({ friendCode: code }));
  return code;
}

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
    if (await User.findOne({ username })) return res.status(409).json({ error: 'このユーザー名は既に使われています' });

    const user = await User.create({
      username,
      displayName: displayName || username,
      password: await bcrypt.hash(password, 10),
      friendCode: await generateFriendCode(),
      friends: []
    });

    const token = jwt.sign({ id: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await User.findOne({ username });
    if (!user || !(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });

    const token = jwt.sign({ id: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/me', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    res.json(safeUser(user));
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.get('/search/:friendCode', async (req, res) => {
  try {
    verifyToken(req);
  } catch {
    return res.status(401).json({ error: 'TOKEN_INVALID' });
  }
  try {
    const user = await User.findOne({ friendCode: req.params.friendCode });
    if (!user) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    res.json({ id: user._id.toString(), username: user.username, displayName: user.displayName, friendCode: user.friendCode });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー: ' + e.message });
  }
});

router.post('/add-friend', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { friendCode } = req.body;
    if (!friendCode) return res.status(400).json({ error: 'IDを入力してください' });

    const me = await User.findById(id);
    if (!me) return res.status(404).json({ error: 'ログインし直してください' });

    const friend = await User.findOne({ friendCode });
    if (!friend) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    if (friend._id.toString() === id) return res.status(400).json({ error: '自分自身は追加できません' });
    if (me.friends.includes(friend._id.toString())) return res.status(400).json({ error: 'すでに友達です' });

    await User.findByIdAndUpdate(id, { $push: { friends: friend._id.toString() } });
    await User.findByIdAndUpdate(friend._id, { $push: { friends: id } });

    res.json({ success: true, friend: { id: friend._id.toString(), username: friend.username, displayName: friend.displayName, friendCode: friend.friendCode } });
  } catch (e) {
    console.error('add-friend error:', e.message);
    res.status(500).json({ error: 'エラーが発生しました' });
  }
});

router.get('/friends', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const me = await User.findById(id);
    if (!me) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    const friendList = await User.find({ _id: { $in: me.friends } });
    res.json(friendList.map(u => ({ id: u._id.toString(), username: u.username, displayName: u.displayName, friendCode: u.friendCode, avatar: u.avatar || '' })));
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.post('/remove-friend', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { friendId } = req.body;
    if (!friendId) return res.status(400).json({ error: 'friendIdが必要です' });
    await User.findByIdAndUpdate(id,       { $pull: { friends: friendId } });
    await User.findByIdAndUpdate(friendId, { $pull: { friends: id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/notif-setting', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { hideNotifContent } = req.body;
    await User.findByIdAndUpdate(id, { hideNotifContent });
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.post('/avatar', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { avatar } = req.body;
    await User.findByIdAndUpdate(id, { avatar });
    res.json({ success: true, avatar });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.get('/config', (req, res) => {
  res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

router.post('/google', async (req, res) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'credentialが必要です' });

    // Google tokeninfo エンドポイントでトークンを検証
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!resp.ok) return res.status(401).json({ error: 'Googleトークンが無効です' });
    const payload = await resp.json();

    if (!payload.sub) return res.status(401).json({ error: 'Googleトークンが無効です' });

    const googleId = payload.sub;
    const email = payload.email || '';
    const googleName = payload.name || email.split('@')[0] || 'User';
    const googleAvatar = payload.picture || '';

    // 既存ユーザーを googleId で検索
    let user = await User.findOne({ googleId });

    if (!user) {
      // メールアドレスで既存ユーザーを検索して紐づけ
      if (email) user = await User.findOne({ username: email });
    }

    if (user) {
      // googleId を紐づけ（まだなければ）
      if (!user.googleId) {
        await User.findByIdAndUpdate(user._id, { googleId });
        user.googleId = googleId;
      }
    } else {
      // 新規ユーザー作成
      let baseUsername = email ? email.split('@')[0] : googleName.replace(/\s+/g, '').toLowerCase();
      let username = baseUsername;
      let suffix = 1;
      while (await User.findOne({ username })) {
        username = baseUsername + suffix++;
      }
      user = await User.create({
        username,
        displayName: googleName,
        password: null,
        googleId,
        avatar: googleAvatar,
        friendCode: await generateFriendCode(),
        friends: []
      });
    }

    const token = jwt.sign({ id: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ token, user: safeUser(user) });
  } catch (e) {
    console.error('google auth error:', e.message);
    res.status(500).json({ error: 'エラーが発生しました' });
  }
});

module.exports = router;
