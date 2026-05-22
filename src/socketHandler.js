const jwt = require('jsonwebtoken');
const { Message, User } = require('./models');
const { sendPushNotification } = require('./push');

const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';
// onlineUsers: userId -> Set<socketId>（複数デバイス対応）
const onlineUsers = new Map();
const callRooms = new Map(); // roomId -> [{ userId, socketId, displayName }]
const pendingCallIntervals = new Map(); // `${callerId}:${calleeId}` -> intervalId

function clearPendingCall(callKey) {
  const id = pendingCallIntervals.get(callKey);
  if (id) { clearInterval(id); pendingCallIntervals.delete(callKey); }
}

// 最初にアクティブなsocketIdを返す（call/signaling用）
function getSocketId(userId) {
  const set = onlineUsers.get(userId);
  if (!set || set.size === 0) return null;
  return set.values().next().value;
}

// 全デバイスにイベントを送信（メッセージ配信用・複数デバイス対応）
function emitToUser(io, userId, event, data) {
  const set = onlineUsers.get(userId);
  if (!set || set.size === 0) return;
  set.forEach(socketId => io.to(socketId).emit(event, data));
}

function addOnlineUser(userId, socketId) {
  if (!onlineUsers.has(userId)) onlineUsers.set(userId, new Set());
  onlineUsers.get(userId).add(socketId);
}

function removeOnlineUser(userId, socketId) {
  const set = onlineUsers.get(userId);
  if (!set) return;
  set.delete(socketId);
  if (set.size === 0) onlineUsers.delete(userId);
}

// レート制限ユーティリティ（イベントスパム防止）
function makeRateLimiter(maxPerWindow, windowMs) {
  const counts = new Map(); // socketId -> { count, resetAt }
  // メモリリーク防止: 期限切れエントリを定期削除（切断済みsocketのカウントが残るのを防ぐ）
  setInterval(() => {
    const now = Date.now();
    counts.forEach((v, k) => { if (now > v.resetAt + windowMs) counts.delete(k); });
  }, Math.max(windowMs * 2, 30000));
  return function isAllowed(socketId) {
    const now = Date.now();
    const entry = counts.get(socketId);
    if (!entry || now > entry.resetAt) {
      counts.set(socketId, { count: 1, resetAt: now + windowMs });
      return true;
    }
    if (entry.count >= maxPerWindow) return false;
    entry.count++;
    return true;
  };
}

const msgRateLimit    = makeRateLimiter(30, 10000);  // 10秒に30件まで
const getMsgLimit     = makeRateLimiter(20, 10000);  // 10秒に20件まで（getMessagesスパム対策）
const deleteRateLimit = makeRateLimiter(10, 10000);  // 10秒に10件まで
const markReadLimit   = makeRateLimiter(20, 5000);   // 5秒に20件まで
const callRateLimit   = makeRateLimiter(3,  60000);  // 1分に3件まで（call spam対策）

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
    addOnlineUser(socket.userId, socket.id);
    io.emit('userOnline', { userId: socket.userId });

    socket.on('getMessages', async ({ toUserId }) => {
      if (typeof toUserId !== 'string' || !toUserId.trim()) return; // ★ 型チェック（NoSQLインジェクション対策）
      if (!/^[0-9a-fA-F]{24}$/.test(toUserId)) return; // ★ ObjectId形式チェック（無効IDでのDB負荷防止）
      if (!getMsgLimit(socket.id)) return; // ★ レートリミット（getMessagesスパムでのDB過負荷防止）
      try {
        // 最新200件を取得（降順で取りreverse → 昇順で返す）
        const msgs = await Message.find({
          $or: [
            { fromId: socket.userId, toId: toUserId, deletedBySender: { $ne: true } },
            { fromId: toUserId, toId: socket.userId, deletedBySender: { $ne: true } }
          ],
          deletedFor: { $ne: socket.userId }
        }).sort({ createdAt: -1 }).limit(200).lean();
        msgs.reverse(); // 時系列順に戻す
        socket.emit('messageHistory', msgs.map(m => ({ ...m, id: m._id.toString() })));
      } catch (e) {
        console.error('[getMessages] error:', e.message);
      }
    });

    socket.on('deleteMessage', async ({ messageId }) => {
      if (typeof messageId !== 'string' || !messageId.trim()) return; // 型チェック
      // ★ MongoDBのObjectId形式チェック（24文字16進数）— CastErrorを事前に防ぐ
      if (!/^[0-9a-fA-F]{24}$/.test(messageId)) return;
      if (!deleteRateLimit(socket.id)) return; // スパム防止
      try {
        const msg = await Message.findOneAndUpdate(
          { _id: messageId, fromId: socket.userId },
          { deletedBySender: true }
        );
        if (!msg) return;
        socket.emit('messageDeleted', { messageId });
        // 受信者の全デバイスに削除を通知
        emitToUser(io, msg.toId, 'messageDeleted', { messageId });
      } catch {}
    });

    socket.on('deleteChatHistory', async ({ withUserId }) => {
      if (typeof withUserId !== 'string' || !withUserId.trim()) return; // 型チェック
      if (!/^[0-9a-fA-F]{24}$/.test(withUserId)) return; // ★ ObjectId形式チェック
      try {
        // 自分だけのソフトデリート: deletedFor に自分のIDを追加
        // 相手のメッセージ履歴はそのまま残る
        await Message.updateMany(
          {
            $or: [
              { fromId: socket.userId, toId: withUserId },
              { fromId: withUserId, toId: socket.userId }
            ]
          },
          { $addToSet: { deletedFor: socket.userId } }
        );
        socket.emit('chatHistoryDeleted', { withUserId });
        // 相手には通知しない（こちら側だけの削除）
      } catch (e) {
        console.error('[deleteChatHistory] error:', e.message);
      }
    });

    socket.on('sendMessage', async ({ toUserId, text, file }) => {
      // 入力バリデーション
      if (typeof toUserId !== 'string' || !toUserId.trim()) return;
      if ((!text && !file) || !toUserId) return;
      // ★ ObjectId形式チェック（無効IDでのMessage.create + findById CastError防止）
      if (!/^[0-9a-fA-F]{24}$/.test(toUserId)) return;
      // メッセージ長制限（10,000文字超はブロック）
      if (text && (typeof text !== 'string' || text.length > 10000)) {
        return socket.emit('sendError', { error: 'メッセージが長すぎます（最大10,000文字）' });
      }
      // ★ fileオブジェクト検証（不正な構造・サイズ超過・危険なURLを防止）
      let safeFile = null;
      if (file) {
        if (typeof file !== 'object' || Array.isArray(file)) {
          return socket.emit('sendError', { error: '不正なファイルデータです' });
        }
        const url  = typeof file.url  === 'string' ? file.url  : '';
        const name = typeof file.originalName === 'string' ? file.originalName.slice(0, 255) : '';
        const mime = typeof file.mimeType === 'string' ? file.mimeType.slice(0, 100) : '';
        const size = typeof file.size === 'number' ? file.size : 0;
        const type = ['image','video','file'].includes(file.type) ? file.type : 'file';
        // URL長制限（base64画像は5MB≒6.7MB base64: ソケットで送る場合の上限）
        if (url.length > 7 * 1024 * 1024) {
          return socket.emit('sendError', { error: 'ファイルが大きすぎます' });
        }
        safeFile = { url, originalName: name, mimeType: mime, size, type };
      }
      // レートリミット（スパム防止）
      if (!msgRateLimit(socket.id)) {
        return socket.emit('sendError', { error: '送信が速すぎます。少し待ってから再送してください' });
      }
      try {
        const msg = await Message.create({
          fromId: socket.userId, fromName: socket.username,
          toId: toUserId, text: text || '',
          file: safeFile
        });
        const out = { ...msg.toObject(), id: msg._id.toString() };
        socket.emit('newMessage', out);
        // 全デバイスに配信（複数デバイス対応）
        emitToUser(io, toUserId, 'newMessage', out);
        // オンライン・バックグラウンド問わず常にpushを送る（SWがフォアグラウンド時は表示を抑制）
        const recipient = await User.findById(toUserId).lean();
        const hideContent = recipient?.hideNotifContent;
        // ★ push body は200文字で切り捨て（Web Push の ~4KB ペイロード上限超えを防止）
        const rawBody = hideContent ? '新しいメッセージがあります' : (out.file ? '📎 ファイルが届きました' : out.text);
        const pushBody = typeof rawBody === 'string' && rawBody.length > 200
          ? rawBody.slice(0, 200) + '…' : (rawBody || '');
        sendPushNotification(toUserId, {
          title: socket.username,
          body: pushBody,
          icon: '/icon-192.png',
          badge: '/icon-192.png',
          data: { fromId: socket.userId }
        }, { urgency: 'high', TTL: 86400 }); // Androidでの即時配信を保証
      } catch (e) {
        console.error('[sendMessage] error:', e.message);
        socket.emit('sendError', { error: 'メッセージの送信に失敗しました' });
      }
    });

    socket.on('markRead', async ({ fromUserId }) => {
      if (typeof fromUserId !== 'string' || !fromUserId.trim()) return; // 型チェック
      if (!/^[0-9a-fA-F]{24}$/.test(fromUserId)) return; // ★ ObjectId形式チェック
      if (!markReadLimit(socket.id)) return; // スパム防止
      try {
        await Message.updateMany({ fromId: fromUserId, toId: socket.userId }, { read: true });
        // 送信者の全デバイスに既読を通知
        emitToUser(io, fromUserId, 'messagesRead', { byUserId: socket.userId });
      } catch (e) {
        console.error('[markRead] error:', e.message);
      }
    });

    // ========== チャット画面の通話シグナリング ==========
    socket.on('callUser', ({ toUserId, signal }) => {
      if (typeof toUserId !== 'string' || !toUserId.trim()) return; // 型チェック
      if (!callRateLimit(socket.id)) return; // ★ call spam防止（1分3件制限）
      const toSocketId = getSocketId(toUserId);
      if (toSocketId) {
        // アプリ起動中ならsocketで着信通知
        io.to(toSocketId).emit('incomingCall', { fromId: socket.userId, fromName: socket.username, signal });
      }
      // ★ callUrl: 自サービスの /call? パスのみ許可（外部URL・フィッシング防止）
      // signal.jitsiUrl = '/call?room=...' 形式の相対パスのみ有効とみなす
      const rawCallUrl = signal?.jitsiUrl || signal?.fallbackUrl;
      const callUrl = (typeof rawCallUrl === 'string' && /^\/call\?/.test(rawCallUrl))
        ? rawCallUrl.slice(0, 500) : null;
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

      // 10秒ごとに最大8回リトライ（合計9回）→ 90秒間カバー（着信ラグ削減）
      let retryCount = 0;
      const intervalId = setInterval(() => {
        retryCount++;
        if (retryCount >= 9 || !pendingCallIntervals.has(callKey)) {
          clearPendingCall(callKey);
          return;
        }
        const remainTTL = Math.max(120 - retryCount * 10, 15);
        sendPushNotification(toUserId, pushPayload, { urgency: 'high', TTL: remainTTL });
      }, 10000);

      pendingCallIntervals.set(callKey, intervalId);
      socket.pendingCallKey = callKey;
    });

    socket.on('answerCall', ({ toUserId, signal }) => {
      if (typeof toUserId !== 'string' || !toUserId.trim()) return; // 型チェック
      if (!/^[0-9a-fA-F]{24}$/.test(toUserId)) return; // ★ ObjectId形式チェック
      const s = getSocketId(toUserId);
      if (s) io.to(s).emit('callAccepted', { signal });
      // 応答されたのでリトライを停止
      const callKey = `${toUserId}:${socket.userId}`;
      clearPendingCall(callKey);
    });

    // reason:'timeout' = 発信者がタイムアウトで諦めた → 不在着信メッセージを保存
    // reason:'rejected' または未指定 = 受信者が手動で拒否
    socket.on('rejectCall', async ({ toUserId, reason }) => {
      if (typeof toUserId !== 'string' || !toUserId.trim()) return; // 型チェック
      if (!/^[0-9a-fA-F]{24}$/.test(toUserId)) return; // ★ ObjectId形式チェック（不在着信メッセージのtoId汚染防止）
      const s = getSocketId(toUserId);
      if (s) io.to(s).emit('callRejected', { reason });
      // 拒否・タイムアウトでリトライを停止（発信者側のpendingCallKey）
      if (socket.pendingCallKey) { clearPendingCall(socket.pendingCallKey); socket.pendingCallKey = null; }
      // 受信者側が拒否した場合は発信者のキーを推測してクリア
      clearPendingCall(`${toUserId}:${socket.userId}`);

      // ★ reason は必ず文字列に正規化（型インジェクション防止）
      const safeReason = typeof reason === 'string' ? reason : '';
      if (safeReason === 'timeout') {
        try {
          const msg = await Message.create({
            fromId: socket.userId,
            fromName: socket.username,
            toId: toUserId,
            text: '📵 不在着信',
            isMissedCall: true,
          });
          const out = { ...msg.toObject(), id: msg._id.toString() };
          // 相手の全デバイスにリアルタイム反映
          emitToUser(io, toUserId, 'newMessage', out);
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
      if (typeof roomId !== 'string' || !roomId.trim() || roomId.length > 128) return; // 型チェック
      // ★ displayName/avatar の型チェック（配列・オブジェクト等が来ても安全に処理）
      const safeDisplayName = (typeof displayName === 'string' ? displayName : '').slice(0, 50) || socket.username;
      const safeAvatar      = (typeof avatar      === 'string' ? avatar      : '').slice(0, 2000);
      socket.join('call-' + roomId);
      socket.currentCallRoom = roomId;

      if (!callRooms.has(roomId)) callRooms.set(roomId, []);
      const room = callRooms.get(roomId);

      if (!room.find(u => u.userId === socket.userId)) {
        // ★ 1対1通話: 3人目以上は拒否（部屋の定員オーバー防止）
        if (room.length >= 2) {
          socket.emit('callRoomFull');
          return;
        }
        room.push({ userId: socket.userId, socketId: socket.id, displayName: safeDisplayName, avatar: safeAvatar });
      }

      if (room.length >= 2) {
        io.to('call-' + roomId).emit('callRoomReady', {
          users: room.map(u => ({ userId: u.userId, displayName: u.displayName, avatar: u.avatar || '' }))
        });
      } else {
        socket.emit('callRoomWaiting');
      }
    });

    socket.on('callOffer', ({ roomId, offer, relayMode }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      // ★ offer はWebRTC SDPオブジェクト（通常1〜10KB）—オブジェクトのみ許可
      if (!offer || typeof offer !== 'object' || Array.isArray(offer)) return;
      socket.to('call-' + roomId).emit('callOffer', { offer, relayMode: !!relayMode });
    });

    socket.on('callAnswer', ({ roomId, answer }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      // ★ answer はWebRTC SDPオブジェクト—オブジェクトのみ許可
      if (!answer || typeof answer !== 'object' || Array.isArray(answer)) return;
      socket.to('call-' + roomId).emit('callAnswer', { answer });
    });

    socket.on('callIceCandidate', ({ roomId, candidate }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      // ★ candidate はnullまたはオブジェクト（ICE gathering完了時はnull）
      if (candidate !== null && (typeof candidate !== 'object' || Array.isArray(candidate))) return;
      socket.to('call-' + roomId).emit('callIceCandidate', { candidate });
    });

    // ★ callee → initiator: ICE失敗時にrestartを要求（calleeはofferを作れないため）
    socket.on('callNeedRestart', ({ roomId }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      socket.to('call-' + roomId).emit('callNeedRestart');
    });

    // ★ initiator → callee: relay-onlyモードへの切替通知
    socket.on('callRelayMode', ({ roomId }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      socket.to('call-' + roomId).emit('callRelayMode');
    });

    socket.on('callHangup', ({ roomId }) => {
      if (typeof roomId !== 'string' || !roomId.trim()) return;
      socket.to('call-' + roomId).emit('callHangup');
      callRooms.delete(roomId);
      // ★ currentCallRoom をリセット → disconnect時に二重hangupを防止
      if (socket.currentCallRoom === roomId) socket.currentCallRoom = null;
    });

    socket.on('disconnect', () => {
      // 通話中なら相手に通知
      if (socket.currentCallRoom) {
        socket.to('call-' + socket.currentCallRoom).emit('callHangup');
        callRooms.delete(socket.currentCallRoom);
      }
      // 発信中のリトライがあればクリア
      if (socket.pendingCallKey) { clearPendingCall(socket.pendingCallKey); socket.pendingCallKey = null; }
      // 複数デバイス対応: このsocket分だけ削除し、他のデバイスが残っているなら userOffline は出さない
      removeOnlineUser(socket.userId, socket.id);
      if (!onlineUsers.has(socket.userId)) {
        // 最後のデバイスが切断 → オフライン通知
        io.emit('userOffline', { userId: socket.userId });
      }
    });
  });
}

module.exports = { setupSocket, onlineUsers, getSocketId, emitToUser };
