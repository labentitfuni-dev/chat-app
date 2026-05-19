require('dotenv').config();
require('./generate-icons').generate();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const path = require('path');
const { connectDB } = require('./db');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());

// index.html / call.html は常に最新版を返す（スマホのキャッシュ対策）
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.get('/call', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, '..', 'public', 'call.html'));
});

app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./auth'));
app.use('/api/upload', require('./upload'));
app.use('/api/push', require('./push').router);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

app.get('/api/ice-servers', async (req, res) => {
  try {
    const url = `https://${process.env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${process.env.METERED_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) throw new Error('Metered API error');
    const iceServers = await response.json();
    res.json(iceServers);
  } catch (e) {
    // フォールバック: Googleの公開STUNサーバー
    res.json([
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' }
    ]);
  }
});

const { setupSocket } = require('./socketHandler');
setupSocket(io);

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`サーバー起動中: http://localhost:${PORT}`);
  });
});
