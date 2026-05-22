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
  let attempts = 0;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
    attempts++;
    if (attempts > 50) throw new Error('フレンドコードの生成に失敗しました（試行上限超過）');
  } while (await User.findOne({ friendCode: code }));
  return code;
}

router.post('/register', async (req, res) => {
  try {
    const { username, password, displayName } = req.body;
    // ★ 型チェック（NoSQLインジェクション対策: { $gt: '' } 等のオブジェクト渡し防止）
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: '入力値が不正です' });
    }
    const uname = username.trim();
    const dname = (typeof displayName === 'string' ? displayName : '').trim();
    // 長さ・文字種バリデーション
    if (!uname || !password) return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
    if (uname.length < 3 || uname.length > 32) return res.status(400).json({ error: 'ユーザー名は3〜32文字にしてください' });
    if (password.length < 6 || password.length > 128) return res.status(400).json({ error: 'パスワードは6〜128文字にしてください' });
    if (!/^[a-zA-Z0-9_.@-]+$/.test(uname)) return res.status(400).json({ error: 'ユーザー名は半角英数字・記号(._@-)のみ使用できます' });
    if (dname.length > 50) return res.status(400).json({ error: '表示名は50文字以内にしてください' });
    if (await User.findOne({ username: uname })) return res.status(409).json({ error: 'このユーザー名は既に使われています' });

    const user = await User.create({
      username: uname,
      displayName: dname || uname,
      password: await bcrypt.hash(password, 10),
      friendCode: await generateFriendCode(),
      friends: []
    });

    const token = jwt.sign({ id: user._id.toString(), username: user.username }, JWT_SECRET, { expiresIn: '30d' });
    res.status(201).json({ token, user: safeUser(user) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    // ★ 型チェック（NoSQLインジェクション対策）
    if (typeof username !== 'string' || typeof password !== 'string') {
      return res.status(400).json({ error: '入力値が不正です' });
    }
    const user = await User.findOne({ username: username.trim() });
    if (!user || !user.password || !(await bcrypt.compare(password, user.password)))
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
    // ★ フレンドコードは6桁数字のみ許可（不正な検索クエリ防止）
    const fc = req.params.friendCode;
    if (!/^\d{6}$/.test(fc)) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    const user = await User.findOne({ friendCode: fc });
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
    if (!friendCode || typeof friendCode !== 'string') return res.status(400).json({ error: 'IDを入力してください' });
    // ★ フレンドコードは6桁数字のみ
    if (!/^\d{6}$/.test(friendCode)) return res.status(400).json({ error: 'フレンドコードは6桁の数字です' });

    const me = await User.findById(id);
    if (!me) return res.status(404).json({ error: 'ログインし直してください' });

    const friend = await User.findOne({ friendCode });
    if (!friend) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    if (friend._id.toString() === id) return res.status(400).json({ error: '自分自身は追加できません' });
    if (me.friends.includes(friend._id.toString())) return res.status(400).json({ error: 'すでに友達です' });

    // ★ $addToSet: 重複追加を防止（$pushだとエッジケースで友達リストに重複が生じる）
    await User.findByIdAndUpdate(id, { $addToSet: { friends: friend._id.toString() } });
    await User.findByIdAndUpdate(friend._id, { $addToSet: { friends: id } });

    res.json({ success: true, friend: { id: friend._id.toString(), username: friend.username, displayName: friend.displayName, friendCode: friend.friendCode, avatar: friend.avatar || '' } });
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
    if (!friendId || typeof friendId !== 'string') return res.status(400).json({ error: 'friendIdが必要です' });
    // ★ ObjectId形式チェック（MongoDBのCastErrorを事前に防ぐ）
    if (!/^[0-9a-fA-F]{24}$/.test(friendId)) return res.status(400).json({ error: 'friendIdが不正です' });
    await User.findByIdAndUpdate(id,       { $pull: { friends: friendId } });
    await User.findByIdAndUpdate(friendId, { $pull: { friends: id } });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/notif-setting', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { hideNotifContent } = req.body;
    // 型チェック: booleanのみ許可
    const safeHide = hideNotifContent === true || hideNotifContent === false ? hideNotifContent : Boolean(hideNotifContent);
    await User.findByIdAndUpdate(id, { hideNotifContent: safeHide });
    res.json({ success: true });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.post('/avatar', async (req, res) => {
  try {
    const { id } = verifyToken(req);
    let { avatar } = req.body;
    // ★ XSS対策: avatarはbase64 data:URLまたはhttps://URLのみ許可
    if (avatar && typeof avatar === 'string') {
      const isDataUrl  = /^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]{10,}$/.test(avatar);
      const isHttpsUrl = /^https:\/\/[^\s"'<>]+$/.test(avatar) && avatar.length < 2000;
      if (!isDataUrl && !isHttpsUrl) {
        return res.status(400).json({ error: '無効なアバター形式です' });
      }
    }
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
    // ★ 型チェック + 長さ制限（不正なペイロードをGoogle APIに送らない）
    if (!credential || typeof credential !== 'string' || credential.length > 4096) {
      return res.status(400).json({ error: 'credentialが不正です' });
    }

    // Google tokeninfo エンドポイントでトークンを検証
    const resp = await fetch(`https://oauth2.googleapis.com/tokeninfo?id_token=${credential}`);
    if (!resp.ok) return res.status(401).json({ error: 'Googleトークンが無効です' });
    const payload = await resp.json();

    if (!payload.sub) return res.status(401).json({ error: 'Googleトークンが無効です' });

    const googleId = payload.sub;
    const email = payload.email || '';
    const googleName = payload.name || email.split('@')[0] || 'User';
    // ★ picture は https:// URLのみ許可（それ以外は空にしてXSS防止）
    const rawPicture = payload.picture || '';
    const googleAvatar = (typeof rawPicture === 'string' && /^https:\/\/[^\s"'<>]+$/.test(rawPicture) && rawPicture.length < 2000)
      ? rawPicture : '';

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
