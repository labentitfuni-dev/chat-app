const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const onlineUsers = new Map();

function setupSocket(io) {
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) return next(new Error('認証が必要です'));
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      socket.userId = payload.id;
      socket.username = payload.username;
      next();
    } catch { next(new Error('トークンが無効です')); }
  });

  io.on('connection', (socket) => {
    console.log(`接続: ${socket.username}`);
    onlineUsers.set(socket.userId, socket.id);
    io.emit('userOnline', { userId: socket.userId });

    socket.on('getMessages', ({ toUserId }) => {
      socket.emit('messageHistory', db.getMessages(socket.userId, toUserId));
    });

    socket.on('sendMessage', ({ toUserId, text, file }) => {
      if ((!text && !file) || !toUserId) return;
      const message = {
        id: uuidv4(), fromId: socket.userId, fromName: socket.username,
        toId: toUserId, text: text || '',
        file: file || null, // { url, originalName, mimeType, type }
        createdAt: new Date().toISOString(), read: false
      };
      db.addMessage(message);
      socket.emit('newMessage', message);
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('newMessage', message);
    });

    socket.on('markRead', ({ fromUserId }) => db.markRead(fromUserId, socket.userId));

    socket.on('callUser', ({ toUserId, signal }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('incomingCall', { fromId: socket.userId, fromName: socket.username, signal });
      else socket.emit('callFailed', { reason: '相手はオフラインです' });
    });

    socket.on('answerCall', ({ toUserId, signal }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('callAccepted', { signal });
    });

    socket.on('rejectCall', ({ toUserId }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('callRejected');
    });

    socket.on('endCall', ({ toUserId }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('callEnded');
    });

    socket.on('iceCandidate', ({ toUserId, candidate }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('iceCandidate', { candidate });
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(socket.userId);
      io.emit('userOffline', { userId: socket.userId });
    });
  });
}

module.exports = { setupSocket, onlineUsers };
