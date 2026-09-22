// 3ページ共通のクライアント補助。SSE購読・API呼び出し・並び順・タイマー表示。
window.PD = (() => {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // 端末ごとの匿名ID。localStorage が使えない環境ではページ内だけで保持する。
  function clientId() {
    try {
      let id = localStorage.getItem('pd.clientId');
      if (!id) {
        id = (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
        localStorage.setItem('pd.clientId', id);
      }
      return id;
    } catch {
      if (!window.__pdCid) window.__pdCid = Math.random().toString(36).slice(2) + Date.now().toString(36);
      return window.__pdCid;
    }
  }

  async function api(path, method = 'GET', body, adminKey) {
    const headers = {};
    if (body) headers['content-type'] = 'application/json';
    if (adminKey) headers['x-admin-key'] = adminKey;
    const r = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.error || r.statusText || 'error'), { status: r.status });
    return j;
  }

  // ロングポーリングで state を購読: GET /api/state?since=<version> は変化があるまで
  // (最大25秒)待ってから返る。失敗したら少し待って再試行。
  // onState(state, now) の now() はサーバー時計に合わせた現在時刻。
  function connect(onState, onStatus) {
    let offset = 0, version = null, failures = 0;
    const now = () => Date.now() + offset;
    (async () => {
      for (;;) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 40000);
        try {
          const r = await fetch('/api/state' + (version != null ? '?since=' + version : ''), { signal: ctrl.signal, cache: 'no-store' });
          if (!r.ok) throw new Error(r.statusText);
          const s = await r.json();
          version = s.version;
          offset = s.serverNow - Date.now();
          failures = 0;
          onStatus && onStatus('live');
          onState(s, now);
        } catch {
          failures++;
          // 5回続けて失敗したら 'lost': トンネルURLが変わった可能性を画面で伝えるため
          onStatus && onStatus(failures >= 5 ? 'lost' : 'reconnecting');
          await new Promise(r => setTimeout(r, Math.min(1000 * failures, 5000)));
        } finally {
          clearTimeout(timer);
        }
      }
    })();
    return { now };
  }

  // 未完了は票数の多い順(同数なら早い順)、完了は終わった順。
  function sortTopics(topics) {
    const open = topics.filter(t => t.status !== 'done')
      .sort((a, b) => (b.voters.length - a.voters.length) || (a.createdAt - b.createdAt));
    const done = topics.filter(t => t.status === 'done')
      .sort((a, b) => (a.doneAt || 0) - (b.doneAt || 0));
    return { open, done };
  }

  function remainingMs(timer, now) {
    if (!timer) return 0;
    return timer.running && timer.endsAt ? timer.endsAt - now : (timer.remainingMs ?? timer.durationMs ?? 0);
  }

  function fmt(ms) {
    const s = Math.ceil(ms / 1000);
    const neg = s < 0, a = Math.abs(s);
    return (neg ? '-' : '') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
  }

  return { esc, clientId, api, connect, sortTopics, remainingMs, fmt };
})();
