const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Message } = require('./models');
const { sendPushNotification } = require('./push');

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

    socket.on('getMessages', async ({ toUserId }) => {
      const msgs = await Message.find({
        $or: [
          { fromId: socket.userId, toId: toUserId },
          { fromId: toUserId, toId: socket.userId }
        ]
      }).sort({ createdAt: 1 }).lean();
      socket.emit('messageHistory', msgs.map(m => ({ ...m, id: m._id.toString() })));
    });

    socket.on('sendMessage', async ({ toUserId, text, file }) => {
      if ((!text && !file) || !toUserId) return;
      const msg = await Message.create({
        fromId: socket.userId, fromName: socket.username,
        toId: toUserId, text: text || '',
        file: file || null
      });
      const out = { ...msg.toObject(), id: msg._id.toString() };
      socket.emit('newMessage', out);
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) {
        io.to(toSocketId).emit('newMessage', out);
      } else {
        // 相手がオフラインならプッシュ通知を送る
        const notifText = out.file ? '📎 ファイルが届きました' : out.text;
        sendPushNotification(toUserId, {
          title: socket.username,
          body: notifText,
          icon: '/icon.svg',
          badge: '/icon.svg',
          data: { fromId: socket.userId }
        });
      }
    });

    socket.on('markRead', async ({ fromUserId }) => {
      await Message.updateMany({ fromId: fromUserId, toId: socket.userId }, { read: true });
    });

    socket.on('callUser', ({ toUserId, signal }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) io.to(toSocketId).emit('incomingCall', { fromId: socket.userId, fromName: socket.username, signal });
      else socket.emit('callFailed', { reason: '相手はオフラインです' });
    });

    socket.on('answerCall', ({ toUserId, signal }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callAccepted', { signal });
    });

    socket.on('rejectCall', ({ toUserId }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callRejected');
    });

    socket.on('endCall', ({ toUserId }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callEnded');
    });

    socket.on('iceCandidate', ({ toUserId, candidate }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('iceCandidate', { candidate });
    });

    socket.on('disconnect', () => {
      onlineUsers.delete(socket.userId);
      io.emit('userOffline', { userId: socket.userId });
    });
  });
}

module.exports = { setupSocket, onlineUsers };
