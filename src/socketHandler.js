const jwt = require('jsonwebtoken');
const { Message, User } = require('./models');
const { sendPushNotification } = require('./push');

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
const onlineUsers = new Map();
const callRooms = new Map(); // roomId -> [{ userId, socketId, displayName }]
const pendingCallIntervals = new Map(); // `${callerId}:${calleeId}` -> intervalId

function clearPendingCall(callKey) {
  const id = pendingCallIntervals.get(callKey);
  if (id) { clearInterval(id); pendingCallIntervals.delete(callKey); }
}

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
          { fromId: toUserId, toId: socket.userId, deletedBySender: { $ne: true } }
        ]
      }).sort({ createdAt: 1 }).lean();
      socket.emit('messageHistory', msgs.map(m => ({ ...m, id: m._id.toString() })));
    });

    socket.on('deleteMessage', async ({ messageId }) => {
      try {
        const msg = await Message.findOneAndUpdate(
          { _id: messageId, fromId: socket.userId },
          { deletedBySender: true }
        );
        if (!msg) return;
        socket.emit('messageDeleted', { messageId });
        // 受信者がオンラインなら相手側にも削除を通知
        const toSocketId = onlineUsers.get(msg.toId);
        if (toSocketId) io.to(toSocketId).emit('messageDeleted', { messageId });
      } catch {}
    });

    socket.on('deleteChatHistory', async ({ withUserId }) => {
      try {
        await Message.deleteMany({
          $or: [
            { fromId: socket.userId, toId: withUserId },
            { fromId: withUserId, toId: socket.userId }
          ]
        });
        socket.emit('chatHistoryDeleted', { withUserId });
        // 相手がオンラインなら相手側にも通知
        const toSocketId = onlineUsers.get(withUserId);
        if (toSocketId) {
          io.to(toSocketId).emit('chatHistoryDeleted', { withUserId: socket.userId });
        }
      } catch (e) {
        console.error('[deleteChatHistory] error:', e.message);
      }
    });

    socket.on('sendMessage', async ({ toUserId, text, file }) => {
      if ((!text && !file) || !toUserId) return;
      try {
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
      } catch (e) {
        console.error('[sendMessage] error:', e.message);
        socket.emit('sendError', { error: 'メッセージの送信に失敗しました' });
      }
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
      const callUrl = signal?.jitsiUrl || signal?.fallbackUrl;
      const callKey = `${socket.userId}:${toUserId}`;
      const pushPayload = {
        title: '📞 ' + socket.username,
        body: '着信中... タップして応答してください',
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { type: 'call', fromId: socket.userId, fromName: socket.username, callUrl }
      };

      // 既存のリトライがあればクリア
      clearPendingCall(callKey);

      // 1回目（即時）
      sendPushNotification(toUserId, pushPayload, { urgency: 'high', TTL: 120 });

      // 15秒ごとに最大5回リトライ（合計6回）→ 90秒間カバー
      let retryCount = 0;
      const intervalId = setInterval(() => {
        retryCount++;
        if (retryCount >= 6 || !pendingCallIntervals.has(callKey)) {
          clearPendingCall(callKey);
          return;
        }
        const remainTTL = Math.max(120 - retryCount * 15, 15);
        sendPushNotification(toUserId, pushPayload, { urgency: 'high', TTL: remainTTL });
      }, 15000);

      pendingCallIntervals.set(callKey, intervalId);
      socket.pendingCallKey = callKey;
    });

    socket.on('answerCall', ({ toUserId, signal }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callAccepted', { signal });
      // 応答されたのでリトライを停止
      const callKey = `${toUserId}:${socket.userId}`;
      clearPendingCall(callKey);
    });

    // reason:'timeout' = 発信者がタイムアウトで諦めた → 不在着信メッセージを保存
    // reason:'rejected' または未指定 = 受信者が手動で拒否
    socket.on('rejectCall', async ({ toUserId, reason }) => {
      const s = onlineUsers.get(toUserId);
      if (s) io.to(s).emit('callRejected', { reason });
      // 拒否・タイムアウトでリトライを停止（発信者側のpendingCallKey）
      if (socket.pendingCallKey) { clearPendingCall(socket.pendingCallKey); socket.pendingCallKey = null; }
      // 受信者側が拒否した場合は発信者のキーを推測してクリア
      clearPendingCall(`${toUserId}:${socket.userId}`);

      if (reason === 'timeout') {
        try {
          const msg = await Message.create({
            fromId: socket.userId,
            fromName: socket.username,
            toId: toUserId,
            text: '📵 不在着信',
            isMissedCall: true,
          });
          const out = { ...msg.toObject(), id: msg._id.toString() };
          // 相手がオンラインならチャットにリアルタイム反映
          if (s) io.to(s).emit('newMessage', out);
          // 不在着信プッシュ通知（urgency:normal、TTL:24h — 後から届いてもOK）
          sendPushNotification(toUserId, {
            title: socket.username,
            body: '📵 不在着信',
            icon: '/icon-192.png',
            badge: '/icon-192.png',
            data: { fromId: socket.userId, type: 'missedCall' }
          }, { urgency: 'normal', TTL: 86400 });
        } catch (e) {
          console.error('[rejectCall/timeout] missed call save error:', e.message);
        }
      }
    });

    // ========== /call ページの WebRTC シグナリング ==========
    socket.on('joinCallRoom', ({ roomId, displayName, avatar }) => {
      socket.join('call-' + roomId);
      socket.currentCallRoom = roomId;

      if (!callRooms.has(roomId)) callRooms.set(roomId, []);
      const room = callRooms.get(roomId);

      if (!room.find(u => u.userId === socket.userId)) {
        room.push({ userId: socket.userId, socketId: socket.id, displayName: displayName || socket.username, avatar: avatar || '' });
      }

      if (room.length >= 2) {
        io.to('call-' + roomId).emit('callRoomReady', {
          users: room.map(u => ({ userId: u.userId, displayName: u.displayName, avatar: u.avatar || '' }))
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
      // 発信中のリトライがあればクリア
      if (socket.pendingCallKey) { clearPendingCall(socket.pendingCallKey); socket.pendingCallKey = null; }
      onlineUsers.delete(socket.userId);
      io.emit('userOffline', { userId: socket.userId });
    });
  });
}

module.exports = { setupSocket, onlineUsers };
