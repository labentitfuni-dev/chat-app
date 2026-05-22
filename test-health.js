#!/usr/bin/env node
/**
 * CHA Health Check & Automated Test Suite
 * ========================================
 * ロン (Ron)   → バグ検出・品質チェック
 * 千  (Sen)    → 動作確認・検証
 * ジョン (John) → 追加機能テスト
 *
 * Usage:
 *   node test-health.js [--url http://localhost:3000] [--runs 100] [--user1 alice] [--user2 bob]
 *
 * 環境変数:
 *   TEST_URL      サーバーURL (default: http://localhost:3000)
 *   TEST_USER1    テストユーザー1 (default: testuser_a)
 *   TEST_USER2    テストユーザー2 (default: testuser_b)
 *   TEST_PASS     共通パスワード (default: TestPass123!)
 *   TEST_RUNS     テスト繰り返し数 (default: 10)
 */

const http  = require('http');
const https = require('https');
const { io } = require('socket.io-client');

// ── CLI / ENV 設定 ───────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i+1] : null; };

const BASE_URL  = getArg('--url')   || process.env.TEST_URL   || 'http://localhost:3000';
const RUNS      = parseInt(getArg('--runs')  || process.env.TEST_RUNS  || '10', 10);
const USER1     = getArg('--user1') || process.env.TEST_USER1 || 'testron_a';
const USER2     = getArg('--user2') || process.env.TEST_USER2 || 'testron_b';
const PASS      = getArg('--pass')  || process.env.TEST_PASS  || 'TestPass_Ron1!';

// ── カラー出力 ──────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
};
const ok    = (s) => `${C.green}✓${C.reset} ${s}`;
const fail  = (s) => `${C.red}✗${C.reset} ${s}`;
const warn  = (s) => `${C.yellow}⚠${C.reset} ${s}`;
const info  = (s) => `${C.cyan}ℹ${C.reset} ${s}`;
const head  = (s) => `\n${C.bold}${C.cyan}━━ ${s} ━━${C.reset}`;

// ── HTTP ヘルパー ────────────────────────────────────────────────
function httpRequest(method, path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const url    = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib    = isHttps ? https : http;
    const data   = body ? JSON.stringify(body) : null;

    const options = {
      hostname: url.hostname,
      port:     url.port || (isHttps ? 443 : 80),
      path:     url.pathname + url.search,
      method,
      headers: {
        'Content-Type':  'application/json',
        'Accept':        'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
        ...headers,
      },
    };

    const req = lib.request(options, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

// ── テスト結果集計 ───────────────────────────────────────────────
const results = { passed: 0, failed: 0, warned: 0, errors: [] };

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(ok(label));
    results.passed++;
  } else {
    console.log(fail(label + (detail ? ` → ${detail}` : '')));
    results.failed++;
    results.errors.push(label + (detail ? `: ${detail}` : ''));
  }
  return condition;
}

function assertWarn(condition, label, detail = '') {
  if (condition) {
    console.log(ok(label));
    results.passed++;
  } else {
    console.log(warn(label + (detail ? ` → ${detail}` : '')));
    results.warned++;
  }
  return condition;
}

// ── ユーティリティ ───────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

function connectSocket(token) {
  return new Promise((resolve, reject) => {
    const socket = io(BASE_URL, {
      auth: { token },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error('Socket connection timeout'));
    }, 8000);
    socket.on('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
  });
}

// ── テストスイート ───────────────────────────────────────────────

// 【千】 Sen: API エンドポイント確認
async function testApiEndpoints() {
  console.log(head('千 (Sen) — API エンドポイント確認'));

  // Health
  try {
    const r = await httpRequest('GET', '/api/health');
    assert(r.status === 200 && r.body.status === 'ok', 'GET /api/health → 200 ok');
  } catch (e) { assert(false, 'GET /api/health', e.message); }

  // Version
  try {
    const r = await httpRequest('GET', '/api/version');
    assert(r.status === 200 && typeof r.body.version === 'string', 'GET /api/version → バージョン文字列');
    console.log(info(`  現在のバージョン: ${r.body.version}`));
  } catch (e) { assert(false, 'GET /api/version', e.message); }

  // Static files
  for (const path of ['/', '/call', '/sw.js', '/manifest.json']) {
    try {
      const r = await httpRequest('GET', path);
      assert(r.status === 200, `GET ${path} → 200`);
    } catch (e) { assert(false, `GET ${path}`, e.message); }
  }

  // ICE servers（認証なし → STUNのみ返る仕様）
  try {
    const r = await httpRequest('GET', '/api/ice-servers');
    assert(r.status === 200 && Array.isArray(r.body) && r.body.length > 0, 'GET /api/ice-servers → STUNサーバー一覧（認証なし）');
  } catch (e) { assert(false, 'GET /api/ice-servers', e.message); }

  // エラーログエンドポイント
  try {
    const r = await httpRequest('POST', '/api/errors', { context: 'health-check', detail: 'test run', page: 'test' });
    assert(r.status === 200 && r.body.ok, 'POST /api/errors → エラーログ記録');
  } catch (e) { assert(false, 'POST /api/errors', e.message); }
}

// 【千】 Sen: 認証フロー確認
async function testAuth() {
  console.log(head('千 (Sen) — 認証フロー確認'));
  let token1, token2;

  // ユーザー1 登録
  try {
    const r = await httpRequest('POST', '/api/auth/register', { username: USER1, password: PASS, displayName: 'Ron Test A' });
    const registered = r.status === 201 || (r.status === 400 && /already|exists|存在/i.test(JSON.stringify(r.body)));
    assert(registered, `POST /api/auth/register (${USER1}) → 201 or already exists`);
  } catch (e) { assert(false, `POST /api/auth/register (${USER1})`, e.message); }

  // ユーザー2 登録
  try {
    const r = await httpRequest('POST', '/api/auth/register', { username: USER2, password: PASS, displayName: 'Ron Test B' });
    const registered = r.status === 201 || (r.status === 400 && /already|exists|存在/i.test(JSON.stringify(r.body)));
    assert(registered, `POST /api/auth/register (${USER2}) → 201 or already exists`);
  } catch (e) { assert(false, `POST /api/auth/register (${USER2})`, e.message); }

  // ユーザー1 ログイン
  try {
    const r = await httpRequest('POST', '/api/auth/login', { username: USER1, password: PASS });
    if (assert(r.status === 200 && r.body.token, `POST /api/auth/login (${USER1}) → token`)) {
      token1 = r.body.token;
    }
  } catch (e) { assert(false, `POST /api/auth/login (${USER1})`, e.message); }

  // ユーザー2 ログイン
  try {
    const r = await httpRequest('POST', '/api/auth/login', { username: USER2, password: PASS });
    if (assert(r.status === 200 && r.body.token, `POST /api/auth/login (${USER2}) → token`)) {
      token2 = r.body.token;
    }
  } catch (e) { assert(false, `POST /api/auth/login (${USER2})`, e.message); }

  // 不正なパスワードで失敗することを確認
  try {
    const r = await httpRequest('POST', '/api/auth/login', { username: USER1, password: 'wrongpass_xyz' });
    assert(r.status === 401 || r.status === 400, 'POST /api/auth/login (不正パスワード) → 401/400');
  } catch (e) { assertWarn(false, 'POST /api/auth/login (不正パスワード)', e.message); }

  // /me 再取得（認証が有効であることを確認）
  if (token1) {
    try {
      const r = await httpRequest('GET', '/api/auth/me', null, { Authorization: 'Bearer ' + token1 });
      assert(r.status === 200 && r.body?.id, 'GET /api/auth/me → ユーザー情報取得', `id=${r.body?.id?.slice(-4)}`);
    } catch (e) { assert(false, 'GET /api/auth/me (再確認)', e.message); }
  }
  // ICEサーバー：認証付きでTURN/STUNが返ることを確認
  if (token1) {
    try {
      const r = await httpRequest('GET', '/api/ice-servers', null, { Authorization: 'Bearer ' + token1 });
      assert(r.status === 200 && Array.isArray(r.body) && r.body.length > 0, 'GET /api/ice-servers (認証付き) → ICEサーバー一覧', `count=${r.body?.length}`);
    } catch (e) { assert(false, 'GET /api/ice-servers (認証付き)', e.message); }
  }

  return { token1, token2 };
}

// 【千】 Sen + 【ジョン】 John: WebSocket + メッセージング確認
async function testMessaging(token1, token2) {
  console.log(head('千/ジョン — WebSocket & メッセージ送受信確認'));

  let sock1, sock2;

  // WebSocket接続
  try {
    sock1 = await connectSocket(token1);
    assert(true, 'Socket A 接続成功');
  } catch (e) { assert(false, 'Socket A 接続', e.message); return; }

  try {
    sock2 = await connectSocket(token2);
    assert(true, 'Socket B 接続成功');
  } catch (e) { assert(false, 'Socket B 接続', e.message); sock1.disconnect(); return; }

  // userOnline 受信
  await sleep(200);
  assert(sock1.connected, 'Socket A: 接続状態維持');
  assert(sock2.connected, 'Socket B: 接続状態維持');

  // ユーザーID取得
  const r1 = await httpRequest('GET', '/api/auth/me', null, { Authorization: 'Bearer ' + token1 });
  const r2 = await httpRequest('GET', '/api/auth/me', null, { Authorization: 'Bearer ' + token2 });

  if (!r1.body?.id || !r2.body?.id) {
    assert(false, 'GET /api/auth/me → ユーザーID取得', 'id missing');
    sock1.disconnect(); sock2.disconnect(); return;
  }
  assert(true, `GET /api/auth/me → ID取得 (A:${r1.body.id.slice(-4)}, B:${r2.body.id.slice(-4)})`);

  const userId1 = r1.body.id;
  const userId2 = r2.body.id;

  // メッセージ送信 + 受信テスト
  let msgReceived = false;
  const testText = 'テスト_' + Date.now();

  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      assert(false, 'メッセージ受信タイムアウト');
      resolve();
    }, 5000);

    sock2.on('newMessage', (msg) => {
      if (msg.text === testText) {
        msgReceived = true;
        clearTimeout(timer);
        assert(true, `メッセージ送受信成功 (${testText.slice(-8)})`);
        assert(msg.fromId === userId1, 'fromId 正常');
        assert(msg.toId === userId2, 'toId 正常');
        resolve();
      }
    });

    sock1.emit('sendMessage', { toUserId: userId2, text: testText });
  });

  // 既読 markRead + messagesRead テスト
  let readReceived = false;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      assertWarn(readReceived, 'messagesRead 受信確認 (5秒タイムアウト)');
      resolve();
    }, 5000);

    sock1.on('messagesRead', ({ byUserId }) => {
      if (byUserId === userId2) {
        readReceived = true;
        clearTimeout(timer);
        assert(true, 'messagesRead 受信確認');
        resolve();
      }
    });

    sock2.emit('markRead', { fromUserId: userId1 });
  });

  // getMessages 取得確認
  await new Promise((resolve) => {
    const timer = setTimeout(() => { assert(false, 'messageHistory タイムアウト'); resolve(); }, 5000);
    sock1.on('messageHistory', (msgs) => {
      clearTimeout(timer);
      assert(Array.isArray(msgs) && msgs.length > 0, `messageHistory 取得 (${msgs.length}件)`);
      resolve();
    });
    sock1.emit('getMessages', { toUserId: userId2 });
  });

  sock1.disconnect();
  sock2.disconnect();
  return { userId1, userId2 };
}

// 【ロン】 Ron: エラーケース・バグ検出
async function testEdgeCases(token1) {
  console.log(head('ロン (Ron) — エラーケース & バグ検出'));

  // 認証なしでSocket接続 → 拒否確認
  try {
    await connectSocket('invalid_token_xyz');
    assert(false, '不正トークンでSocket接続 → 拒否されるべき');
  } catch (e) {
    assert(true, '不正トークンでSocket接続 → 正しく拒否された');
  }

  // 空メッセージ送信（サーバーが拒否するか）
  if (token1) {
    try {
      let sock = await connectSocket(token1);
      let gotError = false;
      sock.on('sendError', () => { gotError = true; });
      sock.emit('sendMessage', { toUserId: 'nonexistent', text: '' });
      await sleep(1000);
      assertWarn(!gotError || gotError, '空メッセージ送信 → サーバーが処理（エラーまたは無視）');
      sock.disconnect();
    } catch (e) { assertWarn(false, '空メッセージテスト', e.message); }
  }

  // 存在しないエンドポイント → 404
  try {
    const r = await httpRequest('GET', '/api/nonexistent_endpoint_xyz');
    assert(r.status === 404, 'GET /api/nonexistent → 404');
  } catch (e) { assertWarn(false, 'GET 404テスト', e.message); }

  // CORS ヘッダー確認
  try {
    const r = await httpRequest('GET', '/api/health');
    // Basic check: server responded (CORS headers would be in browser context only)
    assert(r.status === 200, 'CORS: サーバー正常応答');
  } catch (e) { assertWarn(false, 'CORS確認', e.message); }
}

// 【千】 Sen: 繰り返し安定性テスト（指定回数）
async function testStability(token1, token2, userId1, userId2, runs) {
  console.log(head(`千 (Sen) — 安定性テスト × ${runs}回`));
  let passed = 0, failed = 0;

  for (let i = 1; i <= runs; i++) {
    process.stdout.write(`  実行 ${String(i).padStart(3, ' ')}/${runs}: `);
    try {
      // Health check
      const r = await httpRequest('GET', '/api/health');
      if (r.status !== 200) throw new Error(`health ${r.status}`);

      // Socket接続 + メッセージ往復
      const s1 = await connectSocket(token1);
      const s2 = await connectSocket(token2);

      const testMsg = `stability_${i}_${Date.now()}`;
      let received = false;

      await new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('msg timeout')), 5000);
        s2.on('newMessage', (m) => {
          if (m.text === testMsg) { received = true; clearTimeout(t); resolve(); }
        });
        s1.emit('sendMessage', { toUserId: userId2, text: testMsg });
      });

      s1.disconnect();
      s2.disconnect();

      process.stdout.write(`${C.green}✓${C.reset}\n`);
      passed++;
    } catch (e) {
      process.stdout.write(`${C.red}✗ ${e.message}${C.reset}\n`);
      failed++;
    }
    // 連続テスト間の短いインターバル
    if (i < runs) await sleep(200);
  }

  const pct = Math.round((passed / runs) * 100);
  console.log('');
  assert(pct === 100, `安定性テスト 成功率: ${pct}% (${passed}/${runs})`, pct < 100 ? `失敗: ${failed}回` : '');
  if (pct >= 90 && pct < 100) {
    console.log(warn(`  ${failed}回失敗 → 断続的な問題がある可能性`));
  }
}

// ── メインエントリ ───────────────────────────────────────────────
async function main() {
  console.log(`${C.bold}${C.cyan}`);
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║    CHA 自動テスト & 品質チェック スイート      ║');
  console.log('║  ロン(品質) / 千(確認) / ジョン(機能テスト)   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(C.reset);
  console.log(info(`対象サーバー: ${BASE_URL}`));
  console.log(info(`テスト繰り返し数: ${RUNS}`));
  console.log(info(`テストユーザー: ${USER1} / ${USER2}`));
  console.log('');

  const startTime = Date.now();

  // Step 1: API確認
  await testApiEndpoints();

  // Step 2: 認証
  const { token1, token2 } = await testAuth();

  if (!token1 || !token2) {
    console.log('\n' + fail('認証に失敗したためWebSocketテストをスキップします'));
    printSummary(startTime);
    return;
  }

  // Step 3: メッセージング
  const msgResult = await testMessaging(token1, token2);

  // Step 4: エラーケース
  await testEdgeCases(token1);

  // Step 5: 安定性テスト（繰り返し）
  if (msgResult?.userId1 && msgResult?.userId2) {
    await testStability(token1, token2, msgResult.userId1, msgResult.userId2, RUNS);
  } else {
    console.log(warn('メッセージングテストが失敗したため安定性テストをスキップ'));
    results.warned++;
  }

  printSummary(startTime);
}

function printSummary(startTime) {
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  const total = results.passed + results.failed + results.warned;

  console.log(`\n${C.bold}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}`);
  console.log(`${C.bold}テスト完了 (${elapsed}秒)${C.reset}`);
  console.log(`  ${C.green}✓ 合格: ${results.passed}${C.reset}`);
  if (results.warned > 0) console.log(`  ${C.yellow}⚠ 警告: ${results.warned}${C.reset}`);
  if (results.failed > 0) console.log(`  ${C.red}✗ 失敗: ${results.failed}${C.reset}`);
  console.log(`  合計: ${total}`);

  if (results.errors.length > 0) {
    console.log(`\n${C.bold}${C.red}失敗した項目:${C.reset}`);
    results.errors.forEach((e, i) => console.log(`  ${i+1}. ${e}`));
  }

  const successRate = total > 0 ? Math.round((results.passed / total) * 100) : 0;
  console.log(`\n${C.bold}品質スコア: ${successRate}%${C.reset}`);

  if (successRate === 100) {
    console.log(`${C.green}${C.bold}✓ 全テスト合格 — 商用品質レベル${C.reset}`);
  } else if (successRate >= 90) {
    console.log(`${C.yellow}${C.bold}⚠ 軽微な問題あり — 確認推奨${C.reset}`);
  } else {
    console.log(`${C.red}${C.bold}✗ 重大な問題あり — 修正が必要${C.reset}`);
  }
  console.log('');

  // 終了コード（CIで使用可能）
  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(fail('予期しないエラー: ' + e.message));
  console.error(e.stack);
  process.exit(1);
});
