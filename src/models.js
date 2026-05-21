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
  isMissedCall:    { type: Boolean, default: false },
}, { timestamps: true });

const pushSubSchema = new mongoose.Schema({
  userId:       { type: String, required: true, index: true },
  endpoint:     { type: String, required: true },
  subscription: { type: Object, required: true },
}, { timestamps: true });

const User    = mongoose.model('User', userSchema);
const Message = mongoose.model('Message', messageSchema);
const PushSub = mongoose.model('PushSub', pushSubSchema);

module.exports = { User, Message, PushSub };
