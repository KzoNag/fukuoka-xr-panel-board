#!/usr/bin/env node
// 福岡XR部ミートアップ パネルディスカッション進行ボード — サーバー
// 依存なし (Node 18+)。状態はメモリ上に持ち、data/data.json に保存する。
// ページ:  /              参加者(投稿・投票)
//          /board?key=…   ボード + 進行役の操作(画面共有で投影する)。key 無しなら表示のみ
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const DEFAULT_MINUTES = 7;
const MAX_TITLE = 100;
const MAX_AUTHOR = 24;
const MAX_TOPICS = 300;
const MAX_BODY = 16 * 1024;

// 初回起動時に入る運営トピック。admin から編集・削除できる。
const SEED_TOPICS = [
  '2026年後半、いちばん期待してる（or がっかりした）XRデバイス',
  'スマートグラス、ぶっちゃけ普段使いしてる？',
  'XR×生成AI、実際に制作・開発フローに入ってきたもの',
  'XR開発で最近ハマった／詰んだ話',
  '福岡でXRやってる意味、コミュニティに欲しいもの',
  '「これ誰にも理解されないけど熱い」XR妄想',
];

// ---------- state ----------
const newId = () => crypto.randomBytes(6).toString('base64url');

function freshState() {
  const now = Date.now();
  return {
    adminKey: process.env.ADMIN_KEY || crypto.randomBytes(9).toString('base64url'),
    eventTitle: '福岡XR部ミートアップ 2026.09',
    publicUrl: process.env.PUBLIC_URL || null,
    defaultMinutes: DEFAULT_MINUTES,
    currentId: null,
    timer: { running: false, endsAt: null, remainingMs: DEFAULT_MINUTES * 60000, durationMs: DEFAULT_MINUTES * 60000 },
    topics: SEED_TOPICS.map((title, i) => ({
      id: newId(), title, author: '運営', status: 'open', createdAt: now + i, doneAt: null, votes: {},
    })),
  };
}

let state;
try {
  state = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  if (process.env.ADMIN_KEY) state.adminKey = process.env.ADMIN_KEY;
  if (process.env.PUBLIC_URL) state.publicUrl = process.env.PUBLIC_URL;
} catch {
  state = freshState();
  saveNow();
}

let saveTimer = null;
function saveNow() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DATA_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, DATA_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { saveNow(); } catch (e) { console.error('save failed', e); } }, 200);
}

function publicState() {
  return {
    version,
    eventTitle: state.eventTitle,
    publicUrl: state.publicUrl,
    defaultMinutes: state.defaultMinutes,
    currentId: state.currentId,
    timer: state.timer,
    topics: state.topics.map(t => ({
      id: t.id, title: t.title, author: t.author, status: t.status,
      createdAt: t.createdAt, doneAt: t.doneAt, voters: Object.keys(t.votes),
    })),
    serverNow: Date.now(),
  };
}

// ---------- 変更通知 (ロングポーリング) ----------
// SSE は cloudflared がバッファしてしまい届かなかったので、
// GET /api/state?since=<version> を変化があるまで(最大 LONGPOLL_MS)保留する方式にした。
// version は起動ごとに Date.now() から始めるので、再起動しても単調増加のまま。
const LONGPOLL_MS = 25000;
let version = Date.now();
const waiters = new Set();

function waitForChange(req) {
  return new Promise(resolve => {
    const w = { resolve, timer: null };
    w.timer = setTimeout(() => { waiters.delete(w); resolve(); }, LONGPOLL_MS);
    waiters.add(w);
    req.on('close', () => { clearTimeout(w.timer); waiters.delete(w); resolve(); });
  });
}
function notify() {
  version = Math.max(version + 1, Date.now());
  for (const w of waiters) { clearTimeout(w.timer); w.resolve(); }
  waiters.clear();
}

function changed() { save(); notify(); }

// ---------- timer ----------
function timerRemaining(t, now = Date.now()) {
  return t.running && t.endsAt ? t.endsAt - now : t.remainingMs;
}
// ms を渡すとその長さで仕切り直し(走っていても)。省略なら残りから再開。
function timerStart(ms) {
  const t = state.timer;
  const now = Date.now();
  let rem;
  if (ms != null) { t.durationMs = ms; rem = ms; }
  else rem = t.running ? timerRemaining(t, now) : t.remainingMs;
  t.remainingMs = rem;
  t.endsAt = now + rem;
  t.running = true;
}
function timerPause() {
  const t = state.timer;
  if (!t.running) return;
  t.remainingMs = timerRemaining(t);
  t.running = false;
  t.endsAt = null;
}
function timerReset(ms) {
  const t = state.timer;
  if (ms != null) t.durationMs = ms;
  t.running = false; t.endsAt = null; t.remainingMs = t.durationMs;
}
function timerAdd(ms) {
  const t = state.timer;
  if (t.running) t.endsAt += ms; else t.remainingMs += ms;
}

// ---------- helpers ----------
// 制御文字を落として空白を畳む
const CONTROL_CHARS = /[\x00-\x1f\x7f]/g;
const clean = (s, max) => String(s ?? '').replace(CONTROL_CHARS, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}
function isAdmin(req, url) {
  const given = req.headers['x-admin-key'] || url.searchParams.get('key') || '';
  const a = Buffer.from(String(given)), b = Buffer.from(state.adminKey);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const findTopic = id => state.topics.find(t => t.id === id);

// 参加者の書き込み(投稿・投票)のレート制限: IPごと1分あたり。
// 会場Wi-FiのNATで全員が同じIPになり得るので、スクリプト連打だけを弾く緩い上限にしている。
const WRITE_LIMIT_PER_MIN = 200;
const writeCounts = new Map(); // ip -> { minute, count }
function overWriteLimit(req) {
  const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress || '?');
  const minute = Math.floor(Date.now() / 60000);
  let e = writeCounts.get(ip);
  if (!e || e.minute !== minute) { e = { minute, count: 0 }; writeCounts.set(ip, e); }
  e.count++;
  if (writeCounts.size > 5000) writeCounts.clear();
  return e.count > WRITE_LIMIT_PER_MIN;
}

// ---------- API ----------
async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const m = req.method;

  if (m !== 'GET' && parts[1] !== 'admin' && overWriteLimit(req)) {
    return json(res, 429, { error: '操作が多すぎます。少し待ってください' });
  }

  // since を付けると、その version から変化があるまで待ってから返す(ロングポーリング)
  if (m === 'GET' && url.pathname === '/api/state') {
    const since = Number(url.searchParams.get('since'));
    if (Number.isFinite(since) && since >= version) {
      await waitForChange(req);
      if (req.destroyed || res.destroyed) return;
    }
    return json(res, 200, publicState());
  }

  // 参加者: トピック投稿
  if (m === 'POST' && url.pathname === '/api/topics') {
    const body = await readBody(req);
    const title = clean(body.title, MAX_TITLE);
    const author = clean(body.author, MAX_AUTHOR);
    if (!title) return json(res, 400, { error: 'トピックを入力してください' });
    if (state.topics.length >= MAX_TOPICS) return json(res, 409, { error: 'トピックが上限に達しました' });
    const t = { id: newId(), title, author, status: 'open', createdAt: Date.now(), doneAt: null, votes: {} };
    const cid = clean(body.clientId, 64);
    if (cid) t.votes[cid] = true; // 自分の投稿には自動で1票
    state.topics.push(t);
    changed();
    return json(res, 201, { id: t.id });
  }

  // 参加者: 投票トグル
  if (m === 'POST' && parts.length === 4 && parts[1] === 'topics' && parts[3] === 'vote') {
    const t = findTopic(parts[2]);
    if (!t) return json(res, 404, { error: 'not found' });
    if (t.status === 'done') return json(res, 409, { error: 'このトピックは終了しています' });
    const body = await readBody(req);
    const cid = clean(body.clientId, 64);
    if (!cid) return json(res, 400, { error: 'clientId required' });
    if (t.votes[cid]) delete t.votes[cid]; else t.votes[cid] = true;
    changed();
    return json(res, 200, { voted: !!t.votes[cid], count: Object.keys(t.votes).length });
  }

  // ---- admin ----
  if (parts[1] === 'admin') {
    if (!isAdmin(req, url)) return json(res, 401, { error: '進行役キーが違います' });
    const body = m === 'GET' ? {} : await readBody(req);

    if (m === 'GET' && url.pathname === '/api/admin/ping') return json(res, 200, { ok: true });

    // 今のトピックを設定 (id: null で外す)。選んだらタイマーをリセットして自動スタート。
    if (m === 'POST' && url.pathname === '/api/admin/current') {
      if (body.id == null) { state.currentId = null; timerPause(); }
      else {
        const t = findTopic(body.id);
        if (!t) return json(res, 404, { error: 'not found' });
        if (t.status === 'done') { t.status = 'open'; t.doneAt = null; }
        state.currentId = t.id;
        timerReset(state.defaultMinutes * 60000);
        if (body.autostart !== false) timerStart();
      }
      changed();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && url.pathname === '/api/admin/topics') {
      const title = clean(body.title, MAX_TITLE);
      if (!title) return json(res, 400, { error: 'トピックを入力してください' });
      const t = { id: newId(), title, author: clean(body.author, MAX_AUTHOR) || '運営', status: 'open', createdAt: Date.now(), doneAt: null, votes: {} };
      state.topics.push(t);
      changed();
      return json(res, 201, { id: t.id });
    }

    if ((m === 'PATCH' || m === 'DELETE') && parts.length === 4 && parts[2] === 'topics') {
      const t = findTopic(parts[3]);
      if (!t) return json(res, 404, { error: 'not found' });
      if (m === 'DELETE') {
        state.topics = state.topics.filter(x => x !== t);
        if (state.currentId === t.id) { state.currentId = null; timerPause(); }
      } else {
        if (body.title != null) { const title = clean(body.title, MAX_TITLE); if (title) t.title = title; }
        if (body.author != null) t.author = clean(body.author, MAX_AUTHOR);
        if (body.status === 'done') {
          t.status = 'done'; t.doneAt = Date.now();
          if (state.currentId === t.id) { state.currentId = null; timerPause(); }
        } else if (body.status === 'open') { t.status = 'open'; t.doneAt = null; }
      }
      changed();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && url.pathname === '/api/admin/timer') {
      const sec = Number(body.seconds);
      const ms = body.seconds != null && Number.isFinite(sec) ? Math.round(sec * 1000) : null;
      switch (body.action) {
        case 'start': timerStart(ms); break;
        case 'pause': timerPause(); break;
        case 'reset': timerReset(ms ?? state.defaultMinutes * 60000); break;
        case 'add': if (ms == null) return json(res, 400, { error: 'seconds required' }); timerAdd(ms); break;
        default: return json(res, 400, { error: 'unknown action' });
      }
      changed();
      return json(res, 200, state.timer);
    }

    // 先に全部検証してから反映する(無効値は黙って捨てずに 400 で返す)
    if (m === 'POST' && url.pathname === '/api/admin/settings') {
      const next = {};
      if (body.publicUrl !== undefined) {
        const u = clean(body.publicUrl, 300);
        if (u && !/^https?:\/\/\S+$/.test(u)) return json(res, 400, { error: 'URLは http(s):// から始めてください' });
        next.publicUrl = u || null;
      }
      if (body.defaultMinutes !== undefined) {
        const n = Number(body.defaultMinutes);
        if (!Number.isFinite(n) || n < 1 || n > 60) return json(res, 400, { error: '1トピックの分数は1〜60で指定してください' });
        next.defaultMinutes = n;
      }
      if (body.eventTitle !== undefined) {
        const s = clean(body.eventTitle, 60);
        if (!s) return json(res, 400, { error: 'イベント名が空です' });
        next.eventTitle = s;
      }
      Object.assign(state, next);
      changed();
      return json(res, 200, { ok: true });
    }

    if (m === 'POST' && url.pathname === '/api/admin/reset') {
      if (body.what === 'votes') for (const t of state.topics) t.votes = {};
      else if (body.what === 'done') for (const t of state.topics) { t.status = 'open'; t.doneAt = null; }
      else if (body.what === 'all') { state.topics = []; state.currentId = null; timerReset(state.defaultMinutes * 60000); }
      else return json(res, 400, { error: 'unknown reset' });
      changed();
      return json(res, 200, { ok: true });
    }
  }

  return json(res, 404, { error: 'not found' });
}

// ---------- static ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};
// /admin は /board と同じ画面(?key= があれば進行役の操作が出る)。旧URLの互換のために残す
const PAGES = { '/': 'index.html', '/board': 'board.html', '/admin': 'board.html' };

function serveStatic(req, res, url) {
  const rel = PAGES[url.pathname] || url.pathname;
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('not found'); }
    const ext = path.extname(file);
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': ext === '.html' || ext === '.js' || ext === '.css' ? 'no-cache' : 'public, max-age=86400',
    });
    const stream = fs.createReadStream(file);
    stream.on('error', () => res.destroy()); // ヘッダ送信後なので 500 は返せない。接続を切るだけ
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    return serveStatic(req, res, url);
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 400, { error: e.message || 'error' });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`panel-board listening on http://localhost:${PORT}`);
  console.log(`  board : http://localhost:${PORT}/board?key=${state.adminKey}`);
  console.log(`  public: ${state.publicUrl || '(未設定: admin か start.sh で設定)'}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { try { saveNow(); } catch {} process.exit(0); });

// イベント中は落ちないことを優先: 想定外の例外はログに残して継続する(状態は data.json にある)
process.on('uncaughtException', e => console.error('uncaughtException', e));
process.on('unhandledRejection', e => console.error('unhandledRejection', e));
