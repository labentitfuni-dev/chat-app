const mongoose = require('mongoose');

const MONGODB_URI = process.env.MONGODB_URI || '';

async function connectDB() {
  if (!MONGODB_URI) {
    console.warn('⚠️  MONGODB_URI が未設定です。メモリDBで起動します（再起動でデータ消去）');
    return false;
  }
  try {
    await mongoose.connect(MONGODB_URI, {
      serverSelectionTimeoutMS: 10000, // 10秒以内に接続できなければエラー
      socketTimeoutMS: 45000,           // 45秒でソケットタイムアウト
    });
    console.log('✅ MongoDB接続成功');

    // 接続切断/エラーを自動で再接続（Mongooseはデフォルトでリトライするが明示的に監視）
    mongoose.connection.on('disconnected', () => {
      console.warn('⚠️  MongoDB切断。再接続を試みます...');
    });
    mongoose.connection.on('reconnected', () => {
      console.log('✅ MongoDB再接続成功');
    });
    mongoose.connection.on('error', (err) => {
      console.error('❌ MongoDB接続エラー:', err.message);
    });

    return true;
  } catch (e) {
    console.error('❌ MongoDB接続失敗:', e.message);
    return false;
  }
}

module.exports = { connectDB };
