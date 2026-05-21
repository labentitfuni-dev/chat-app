const express = require('express');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'chat-app-secret-key-change-in-production';

const uploadDir = path.join(__dirname, '..', 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, uuidv4() + ext);
  }
});

// 許可する拡張子（実行ファイル等をブロック）
const BLOCKED_EXT = new Set([
  '.exe', '.bat', '.cmd', '.com', '.msi', '.ps1', '.vbs', '.js', '.jse',
  '.sh', '.bash', '.zsh', '.fish', '.py', '.rb', '.pl', '.php',
  '.jar', '.class', '.war', '.ear', '.apk', '.ipa',
  '.scr', '.pif', '.cpl', '.reg', '.inf', '.lnk', '.hta'
]);

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20MB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (BLOCKED_EXT.has(ext)) {
      return cb(new Error('このファイル形式はアップロードできません'));
    }
    cb(null, true);
  }
});

router.post('/', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: '認証が必要です' });
  try {
    jwt.verify(token, JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'トークンが無効です' });
  }

  upload.single('file')(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'ファイルサイズは20MB以下にしてください' });
      if (err.message === 'このファイル形式はアップロードできません') return res.status(400).json({ error: err.message });
      return res.status(400).json({ error: 'アップロードに失敗しました' });
    }
    if (!req.file) return res.status(400).json({ error: 'ファイルがありません' });

    const isImage = req.file.mimetype.startsWith('image/');
    const isVideo = req.file.mimetype.startsWith('video/');

    res.json({
      url: `/uploads/${req.file.filename}`,
      originalName: req.file.originalname,
      mimeType: req.file.mimetype,
      size: req.file.size,
      type: isImage ? 'image' : isVideo ? 'video' : 'file'
    });
  });
});

module.exports = router;
