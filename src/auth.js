const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

router.post('/register', async (req, res) => {
  const { username, password, displayName } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'ユーザー名とパスワードは必須です' });

  if (db.findUser({ username })) return res.status(409).json({ error: 'このユーザー名は既に使われています' });

  const user = {
    id: uuidv4(),
    username,
    displayName: displayName || username,
    password: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString()
  };
  db.addUser(user);

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName } });
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const user = db.findUser({ username });
  if (!user || !(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ error: 'ユーザー名またはパスワードが違います' });

  const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' });
  res.json({ token, user: { id: user.id, username: user.username, displayName: user.displayName } });
});

router.get('/me', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    const { id } = jwt.verify(token, JWT_SECRET);
    const user = db.findUser({ id });
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    res.json({ id: user.id, username: user.username, displayName: user.displayName });
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

router.get('/users', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    jwt.verify(token, JWT_SECRET);
    res.json(db.getUsers().map(u => ({ id: u.id, username: u.username, displayName: u.displayName })));
  } catch { res.status(401).json({ error: 'トークンが無効です' }); }
});

module.exports = router;
