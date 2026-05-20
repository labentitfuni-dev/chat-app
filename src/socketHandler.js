const jwt = require('jsonwebtoken');
const { Message, User } = require('./models');
const { sendPushNotification } = require('./push');

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const onlineUsers = new Map();
const callRooms = new Map(); // roomId -> [{ userId, socketId, displayName }]

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
          { fromId: socket.userId, toId: toUserId, deletedBySender: { $ne: true } },
          { fromId: toUserId, toId: socket.userId }
        ]
      }).sort({ createdAt: 1 }).lean();
      socket.emit('messageHistory', msgs.map(m => ({ ...m, id: m._id.toString() })));
    });

    socket.on('deleteMessage', async ({ messageId }) => {
      try {
        await Message.findOneAndUpdate(
          { _id: messageId, fromId: socket.userId },
          { deletedBySender: true }
        );
        socket.emit('messageDeleted', { messageId });
      } catch {}
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
      }
      // オンライン・バックグラウンド問わず常にpushを送る（SWがフォアグラウンド時は表示を抑制）
      const recipient = await User.findById(toUserId).lean();
      const hideContent = recipient?.hideNotifContent;
      sendPushNotification(toUserId, {
        title: socket.username,
        body: hideContent ? '新しいメッセージがあります' : (out.file ? '📎 ファイルが届きました' : out.text),
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { fromId: socket.userId }
      });
    });

    socket.on('markRead', async ({ fromUserId }) => {
      await Message.updateMany({ fromId: fromUserId, toId: socket.userId }, { read: true });
      // 送信者に既読を通知
      const fromSocketId = onlineUsers.get(fromUserId);
      if (fromSocketId) {
        io.to(fromSocketId).emit('messagesRead', { byUserId: socket.userId });
      }
    });

    // ========== チャット画面の通話シグナリング ==========
    socket.on('callUser', ({ toUserId, signal }) => {
      const toSocketId = onlineUsers.get(toUserId);
      if (toSocketId) {
        // アプリ起動中ならsocketで着信通知
        io.to(toSocketId).emit('incomingCall', { fromId: socket.userId, fromName: socket.username, signal });
      }
      // バックグラウンド・オフラインに関わらず常にプッシュ通知を送る
      // （callFailed は送らない — call.html 側がタイムアウトで処理する）
      const callUrl = signal?.jitsiUrl || signal?.fallbackUrl;
      sendPushNotification(toUserId, {
        title: '📞 ' + socket.username,
        body: '着信中... タップして応答してください',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { type: 'call', fromId: socket.userId, fromName: socket.username, callUrl }
      });
    });

    socket.on('answerCall', ({ toUserId, signal }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callAccepted', { signal });
    });

    socket.on('rejectCall', ({ toUserId }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callRejected');
    });

    // ========== /call ページの WebRTC シグナリング ==========
    socket.on('joinCallRoom', ({ roomId, displayName }) => {
      socket.join('call-' + roomId);
      socket.currentCallRoom = roomId;

      if (!callRooms.has(roomId)) callRooms.set(roomId, []);
      const room = callRooms.get(roomId);

      if (!room.find(u => u.userId === socket.userId)) {
        room.push({ userId: socket.userId, socketId: socket.id, displayName: displayName || socket.username });
      }

      if (room.length >= 2) {
        io.to('call-' + roomId).emit('callRoomReady', {
          users: room.map(u => ({ userId: u.userId, displayName: u.displayName }))
        });
      } else {
        socket.emit('callRoomWaiting');
      }
    });

    socket.on('callOffer', ({ roomId, offer }) => {
      socket.to('call-' + roomId).emit('callOffer', { offer });
    });

    socket.on('callAnswer', ({ roomId, answer }) => {
      socket.to('call-' + roomId).emit('callAnswer', { answer });
    });

    socket.on('callIceCandidate', ({ roomId, candidate }) => {
      socket.to('call-' + roomId).emit('callIceCandidate', { candidate });
    });

    socket.on('callHangup', ({ roomId }) => {
      socket.to('call-' + roomId).emit('callHangup');
      callRooms.delete(roomId);
    });

    socket.on('disconnect', () => {
      // 通話中なら相手に通知
      if (socket.currentCallRoom) {
        socket.to('call-' + socket.currentCallRoom).emit('callHangup');
        callRooms.delete(socket.currentCallRoom);
      }
      onlineUsers.delete(socket.userId);
      io.emit('userOffline', { userId: socket.userId });
    });
  });
}

module.exports = { setupSocket, onlineUsers };
