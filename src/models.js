const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  username:    { type: String, required: true, unique: true },
  displayName: { type: String, required: true },
  password:    { type: String, default: null },
  googleId:    { type: String, default: '' },
  friendCode:  { type: String, required: true, unique: true },
  friends:     [{ type: String }],
  avatar:         { type: String, default: '' },
  hideNotifContent: { type: Boolean, default: false },
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  fromId:   { type: String, required: true },
  fromName: { type: String, required: true },
  toId:     { type: String, required: true },
  text:     { type: String, default: '' },
  file:     { type: Object, default: null },
  read:            { type: Boolean, default: false },
  deletedBySender: { type: Boolean, default: false },
  deletedFor:      [{ type: String }],   // 自分だけ削除（相手には残る）
  isMissedCall:    { type: Boolean, default: false },
}, { timestamps: true });

// パフォーマンス最適化: メッセージ取得クエリで使うフィールドにインデックス
// getMessages: { fromId, toId } の組み合わせで検索 → 複合インデックス
messageSchema.index({ fromId: 1, toId: 1, createdAt: 1 });
messageSchema.index({ toId: 1, fromId: 1, createdAt: 1 });

const pushSubSchema = new mongoose.Schema({
  userId:       { type: String, required: true },
  endpoint:     { type: String, required: true },
  subscription: { type: Object, required: true },
}, { timestamps: true });

// ★ 複合インデックス: subscribe の upsert クエリ { userId, endpoint } を高速化
pushSubSchema.index({ userId: 1, endpoint: 1 }, { unique: true });

const User    = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const PushSub = mongoose.model('PushSub', pushSubSchema);

module.exports = { User, Message, PushSub };
