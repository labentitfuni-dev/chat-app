const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

function verifyToken(req) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new Error('認証が必要です');
  return jwt.verify(token, JWT_SECRET);
}

function generateFriendCode() {
  // 6桁のユニークなID
  let code;
  do {
    code = String(Math.floor(100000 + Math.random() * 900000));
  } while (db.findUser({ friendCode: code }));
  return code;
}

router.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });
  if (db.findUser({ username })) return res.status(409).json({ error: 'このユーザー名は既に使われています' });

  const user = {
    id: uuidv4(),
    username,
    displayName: displayName || username,
    password: await bcrypt.hash(password, 10),
    friendCode: generateFriendCode(),
    friends: [],
    createdAt: new Date().toISOString()
  };
  db.addUser(user);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, friendCode: user.friendCode, friends: [] } });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.findUser({ username });
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName, friendCode: user.friendCode, friends: user.friends } });
});

router.get('/me', (req, res) => {
  try {
    const { id } = verifyToken(req);
    const user = db.findUser({ id });
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, friendCode: user.friendCode, friends: user.friends });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

// 友達検索（6桁IDで検索）
router.get('/search/:friendCode', (req, res) => {
  try {
    verifyToken(req);
    const user = db.findUser({ friendCode: req.params.friendCode });
    if (!user) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    res.json({ id: user.id, username: user.username, displayName: user.displayName, friendCode: user.friendCode });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

// 友達追加
router.post('/add-friend', (req, res) => {
  try {
    const { id } = verifyToken(req);
    const { friendCode } = req.body;

    if (!friendCode) return res.status(400).json({ error: 'IDを入力してください' });

    const me = db.findUser({ id });
    if (!me) return res.status(404).json({ error: 'ログインし直してください' });

    const friend = db.findUser({ friendCode });
    if (!friend) return res.status(404).json({ error: 'そのIDのユーザーは見つかりません' });
    if (friend.id === id) return res.status(400).json({ error: '自分自身は追加できません' });

    const myFriends = me.friends || [];
    const friendFriends = friend.friends || [];

    if (myFriends.includes(friend.id)) return res.status(400).json({ error: 'すでに友達です' });

    // お互いに友達追加
    db.updateUser(id, { friends: [...myFriends, friend.id] });
    db.updateUser(friend.id, { friends: [...friendFriends, id] });

    res.json({ success: true, friend: { id: friend.id, username: friend.username, displayName: friend.displayName, friendCode: friend.friendCode } });
  } catch (e) {
    console.error('add-friend error:', e.message);
    res.status(500).json({ error: 'エラーが発生しました: ' + e.message });
  }
});

// 友達一覧取得
router.get('/friends', (req, res) => {
  try {
    const { id } = verifyToken(req);
    const me = db.findUser({ id });
    const friends = (me.friends || []).map(fid => {
      const u = db.findUser({ id: fid });
      return u ? { id: u.id, username: u.username, displayName: u.displayName, friendCode: u.friendCode } : null;
    }).filter(Boolean);
    res.json(friends);
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

module.exports = router;
