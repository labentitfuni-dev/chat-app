require('dotenv').config();
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
app.use(express.static(path.join(__dirname, '..', 'public')));

app.use('/api/auth', require('./auth'));
app.use('/api/upload', require('./upload'));
app.use('/api/push', require('./push').router);
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

const { setupSocket } = require('./socketHandler');
setupSocket(io);

const PORT = process.env.PORT || 3000;

connectDB().then(() => {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`サーバー起動中: http://localhost:${PORT}`);
  });
});
