const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || '';

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI が未設定です。メモリDBで起動します（再起動でデータ消去）');
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI);
    console.log('✅ MongoDB接続成功');
    return true;
  } catch (e) {
    console.error('❌ MongoDB接続失敗:', e.message);
    return false;
  }
}

module.exports = { connectDB };
