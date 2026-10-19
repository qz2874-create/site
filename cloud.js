/* 修改地图 · GitHub 同步
 * 数据放在一个私有仓库里（data.json + assets.json），网页本身放在 GitHub Pages 上。
 * 每位合作者用自己的 GitHub token 读写；多人同时修改时按"条目 + 字段"三方合并，冲突时本地修改优先。
 */
(function () {
  'use strict';
  var CFG = Object.assign({ branch: 'main', dataPath: 'data.json', assetsPath: 'assets.json', autoSyncSeconds: 15, pollSeconds: 45 },
                          window.REVMAP_CONFIG || {});
  var TOKEN_KEY = 'revmap-gh-token', LAST_KEY = 'revmap-gh-last';
  var API = 'https://api.github.com';
  var COLLS = ['reviewers', 'excerpts', 'issues', 'solutions', 'responses', 'links'];

  var st = {
    token: null, login: '', base: null, baseSha: null, assetsSha: null, remoteAssetKeys: new Set(),
    dirty: false, syncing: false, loaded: false, error: '', lastSync: null, pendingApply: null, conflicts: 0
  };
  try { st.token = localStorage.getItem(TOKEN_KEY); } catch (e) { st.token = null; }

  /* ---------- helpers ---------- */
  function hm(d) { return d ? d.toTimeString().slice(0, 5) : ''; }
  function stable(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v);
    if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
    return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + stable(v[k]); }).join(',') + '}';
  }
  function eq(a, b) { return stable(a) === stable(b); }
  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  function b64encode(str) {
    var bytes = new TextEncoder().encode(str), out = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(out);
  }
  function b64decode(b64) {
    var bin = atob(b64.replace(/\s/g, '')), bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  function editing() {
    var a = document.activeElement;
    return !!(a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable));
  }
  function app() { return window.RevmapAPI; }
  function status() { if (app()) app().refreshStatus(); renderPanel(); }

  /* ---------- GitHub contents API ---------- */
  function url(path) {
    return API + '/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo) + '/contents/' +
      path.split('/').map(encodeURIComponent).join('/');
  }
  function gh(method, u, body, accept) {
    var h = { 'Authorization': 'Bearer ' + st.token, 'Accept': accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (body) h['Content-Type'] = 'application/json';
    return fetch(u, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  }
  function getMeta(path) {   // -> {sha, content?} or null when the file does not exist
    return gh('GET', url(path) + '?ref=' + encodeURIComponent(CFG.branch) + '&t=' + Date.now()).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw httpErr(r);
      return r.json();
    });
  }
  function getText(path, meta) {   // small files come inline; large files (>1 MB) need the raw media type
    if (meta && meta.encoding === 'base64' && meta.content) return Promise.resolve(b64decode(meta.content));
    return gh('GET', url(path) + '?ref=' + encodeURIComponent(CFG.branch) + '&t=' + Date.now(), null, 'application/vnd.github.raw')
      .then(function (r) { if (!r.ok) throw httpErr(r); return r.text(); });
  }
  function putText(path, text, sha, msg) {
    var body = { message: msg, content: b64encode(text), branch: CFG.branch };
    if (sha) body.sha = sha;
    return gh('PUT', url(path), body).then(function (r) {
      if (r.status === 409 || r.status === 422) { var e = new Error('conflict'); e.conflict = true; throw e; }
      if (!r.ok) throw httpErr(r);
      return r.json();
    }).then(function (j) { return j.content.sha; });
  }
  function httpErr(r) {
    var m = r.status === 401 ? 'token 无效或已过期' : r.status === 403 ? '没有权限（token 权限不足或已达 API 次数上限）' :
            r.status === 404 ? '找不到仓库或文件（检查 config.js 和 token 权限）' : 'GitHub 返回 ' + r.status;
    var e = new Error(m); e.status = r.status; return e;
  }

  /* ---------- three-way merge ---------- */
  function mergeObj(b, l, r, path) {
    b = b || {}; l = l || {}; r = r || {};
    var out = {}, keys = {};
    [b, l, r].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var lv = l[k], rv = r[k], bv = b[k], v;
      if (eq(lv, bv)) v = rv; else if (eq(rv, bv)) v = lv; else if (eq(lv, rv)) v = lv;
      else { v = lv; st.conflicts++; }
      if (v !== undefined) out[k] = clone(v);
    });
    return out;
  }
  function mergeColl(B, L, R) {
    B = B || []; L = L || []; R = R || [];
    var bm = new Map(B.map(function (x) { return [x.id, x]; })), lm = new Map(L.map(function (x) { return [x.id, x]; }));
    var res = [];
    R.forEach(function (rx) {
      var id = rx.id, bx = bm.get(id), lx = lm.get(id);
      if (lx) res.push(mergeObj(bx, lx, rx));
      else if (bx) { if (!eq(rx, bx)) res.push(clone(rx)); }   // deleted here; keep only if someone else changed it
      else res.push(clone(rx));                                 // added by someone else
    });
    var rm = new Map(R.map(function (x) { return [x.id, x]; }));
    L.forEach(function (lx, i) {
      if (rm.has(lx.id)) return;
      var bx = bm.get(lx.id);
      if (bx && eq(lx, bx)) return;                             // deleted by someone else, untouched here
      var at = 0;
      for (var j = i - 1; j >= 0; j--) {
        var k = res.findIndex(function (x) { return x.id === L[j].id; });
        if (k >= 0) { at = k + 1; break; }
      }
      res.splice(at, 0, clone(lx));
    });
    return res;
  }
  function merge3(B, L, R) {
    st.conflicts = 0;
    function rest(x) { var o = {}; Object.keys(x || {}).forEach(function (k) { if (k !== 'meta' && COLLS.indexOf(k) < 0) o[k] = x[k]; }); return o; }
    var out = mergeObj(rest(B), rest(L), rest(R));
    out.meta = mergeObj(B.meta, L.meta, R.meta);
    COLLS.forEach(function (c) { out[c] = mergeColl(B[c], L[c], R[c]); });
    return out;
  }

  /* ---------- load / sync / poll ---------- */
  function load() {
    st.error = ''; status();
    var dmeta;
    return getMeta(CFG.dataPath).then(function (m) {
      if (!m) throw new Error('仓库里还没有 ' + CFG.dataPath + '，请先上传 data 文件夹里的文件');
      dmeta = m; return getText(CFG.dataPath, m);
    }).then(function (txt) {
      var data = JSON.parse(txt);
      return getMeta(CFG.assetsPath).then(function (am) {
        if (!am) return { data: data, assets: {}, asha: null };
        return getText(CFG.assetsPath, am).then(function (t) { return { data: data, assets: JSON.parse(t || '{}'), asha: am.sha }; });
      });
    }).then(function (x) {
      st.base = clone(x.data); st.baseSha = dmeta.sha; st.assetsSha = x.asha; st.remoteAssetKeys = new Set(Object.keys(x.assets));
      st.loaded = true; st.dirty = false; st.lastSync = new Date();
      try { localStorage.setItem(LAST_KEY, JSON.stringify({ owner: CFG.owner, repo: CFG.repo, id: x.data.meta && x.data.meta.id })); } catch (e) { /* ignore */ }
      app().setData(x.data, x.assets);
      hideCover(); status();
    }).catch(function (e) { st.error = e.message || String(e); status(); showCover(); });
  }

  function refreshAssetsIfNeeded() {
    return getMeta(CFG.assetsPath).then(function (am) {
      if (!am || am.sha === st.assetsSha) return null;
      return getText(CFG.assetsPath, am).then(function (t) { var a = JSON.parse(t || '{}'); st.assetsSha = am.sha; st.remoteAssetKeys = new Set(Object.keys(a)); return a; });
    });
  }

  function syncAssets(merged) {
    var ref = app().referencedAssets(merged), need = Object.keys(ref).filter(function (k) { return !st.remoteAssetKeys.has(k); });
    if (!need.length) return Promise.resolve();
    return getMeta(CFG.assetsPath).then(function (am) {
      return (am ? getText(CFG.assetsPath, am) : Promise.resolve('{}')).then(function (t) {
        var remote = JSON.parse(t || '{}');
        need.forEach(function (k) { remote[k] = ref[k]; });
        return putText(CFG.assetsPath, JSON.stringify(remote), am && am.sha, '修改地图：' + (st.login || '合作者') + ' 添加附件')
          .then(function (sha) { st.assetsSha = sha; st.remoteAssetKeys = new Set(Object.keys(remote)); });
      });
    });
  }

  function sync(tries) {
    tries = tries || 0;
    if (!st.token || !st.loaded || st.syncing) return Promise.resolve();
    st.syncing = true; st.error = ''; status();
    var local = app().getData(), merged, remoteSha, remote = null;
    st.conflicts = 0;
    return getMeta(CFG.dataPath).then(function (m) {
      remoteSha = m && m.sha;
      if (remoteSha === st.baseSha) return local;
      return getText(CFG.dataPath, m).then(function (t) { remote = JSON.parse(t); return merge3(st.base, local, remote); });
    }).then(function (mg) {
      merged = mg;
      return syncAssets(merged);
    }).then(function () {
      if (remoteSha === st.baseSha && eq(stripSaved(merged), stripSaved(st.base))) return st.baseSha;   // nothing to write
      if (remote && eq(stripSaved(merged), stripSaved(remote))) return remoteSha;                          // remote already has everything
      merged.meta.savedAt = new Date().toISOString();
      return putText(CFG.dataPath, JSON.stringify(merged, null, 1), remoteSha, '修改地图：' + (st.login || '合作者') + ' 更新');
    }).then(function (sha) {
      var changedByOthers = !eq(stripSaved(merged), stripSaved(app().getData()));
      st.base = clone(merged); st.baseSha = sha; st.syncing = false; st.lastSync = new Date();
      st.dirty = !eq(stripSaved(app().getData()), stripSaved(local)) ? true : false;   // edits made while syncing stay pending
      if (changedByOthers && !st.dirty) applyRemote(merged, null);
      if (st.conflicts) app().toast('与他人的修改合并完成（' + st.conflicts + ' 处同一字段被同时修改，保留了你的版本）');
      status();
      if (st.dirty) scheduleSync();
    }).catch(function (e) {
      st.syncing = false;
      if (e && e.conflict && tries < 3) return sync(tries + 1);
      st.error = (e && e.message) || String(e); status();
    });
  }
  function stripSaved(d) { var c = clone(d); if (c && c.meta) { delete c.meta.savedAt; delete c.meta.view; } return c; }

  function applyRemote(data, assets) {
    if (editing()) { st.pendingApply = { data: data, assets: assets }; status(); return; }
    st.pendingApply = null;
    app().setData(data, assets || {});
  }
  document.addEventListener('focusout', function () {
    setTimeout(function () { if (st.pendingApply && !editing() && !st.dirty) applyRemote(st.pendingApply.data, st.pendingApply.assets); }, 300);
  });

  function poll() {
    if (!st.token || !st.loaded || st.syncing || document.hidden) return;
    if (st.dirty) return;   // the next sync merges whatever changed remotely
    getMeta(CFG.dataPath).then(function (m) {
      if (!m || m.sha === st.baseSha) return;
      return getText(CFG.dataPath, m).then(function (t) {
        var data = JSON.parse(t);
        return refreshAssetsIfNeeded().then(function (assets) {
          if (st.dirty) return;   // user started editing meanwhile; sync will merge
          st.base = clone(data); st.baseSha = m.sha; st.lastSync = new Date();
          applyRemote(data, assets);
          app().toast('已载入合作者的最新修改');
          status();
        });
      });
    }).catch(function () { /* transient; try again next round */ });
  }

  var syncTimer = null;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, CFG.autoSyncSeconds * 1000); }

  /* ---------- hooks into the page ---------- */
  window.__revmapOnChange = function () {
    if (!st.loaded) return;
    st.dirty = true; status(); scheduleSync();
  };
  window.__revmapCloudStatus = function () {
    if (!st.token) return { cls: 'warn', text: '未连接 GitHub：修改只保存在本浏览器' };
    if (st.error) return { cls: 'err', text: 'GitHub 同步出错：' + st.error };
    if (!st.loaded) return { cls: 'idle', text: '正在从 GitHub 载入…' };
    if (st.syncing) return { cls: 'idle', text: '正在同步到 GitHub…' };
    if (st.dirty) return { cls: 'warn', text: '有未同步的修改（' + CFG.autoSyncSeconds + ' 秒内自动同步）' };
    if (st.pendingApply) return { cls: 'warn', text: '合作者有新修改，离开输入框后载入' };
    return { cls: '', text: '已同步到 GitHub ' + hm(st.lastSync) + (st.login ? '（' + st.login + '）' : '') };
  };
  window.addEventListener('beforeunload', function (e) {
    if (st.dirty || st.syncing) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); clearTimeout(syncTimer); sync(); }
  });

  /* ---------- UI: floating panel + first-run cover ---------- */
  var css = document.createElement('style');
  css.textContent =
    '#gh-fab{position:fixed;left:14px;bottom:14px;z-index:60;display:flex;gap:6px;align-items:center;background:#fff;border:1px solid #D6DCE1;border-radius:999px;padding:5px 6px 5px 12px;box-shadow:0 4px 14px rgba(28,39,51,.12);font:12.5px/1.2 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1C2733}' +
    '#gh-fab .dot{width:8px;height:8px;border-radius:50%;background:#8B97A2}#gh-fab .dot.ok{background:#2D7A4B}#gh-fab .dot.warn{background:#B86E0A}#gh-fab .dot.err{background:#B3261E}' +
    '#gh-fab button{border:1px solid #D6DCE1;background:#F4F6F8;border-radius:999px;padding:4px 10px;cursor:pointer;font:inherit}#gh-fab button:hover{border-color:#1F5FBF;color:#1F5FBF}' +
    '#gh-cover{position:fixed;inset:0;z-index:80;background:rgba(230,234,237,.92);display:flex;align-items:center;justify-content:center;padding:16px}' +
    '#gh-cover .card{background:#fff;border:1px solid #D6DCE1;border-radius:12px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 10px 40px rgba(28,39,51,.18);font:14px/1.6 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1C2733}' +
    '#gh-cover h2{margin:0 0 6px;font-size:18px}#gh-cover p{margin:6px 0;color:#55626E}#gh-cover input{width:100%;height:36px;border:1px solid #D6DCE1;border-radius:8px;padding:0 10px;margin:8px 0;font:13px ui-monospace,Menlo,monospace}' +
    '#gh-cover .row{display:flex;gap:8px;justify-content:flex-end;margin-top:10px;flex-wrap:wrap}#gh-cover button{border:1px solid #D6DCE1;background:#fff;border-radius:8px;padding:7px 14px;cursor:pointer;font:inherit}' +
    '#gh-cover button.pri{background:#1F5FBF;color:#fff;border-color:#1F5FBF}#gh-cover .err{color:#B3261E;font-size:13px;min-height:1em}#gh-cover code{background:#F4F6F8;padding:1px 5px;border-radius:4px;font-size:12.5px}';
  document.head.appendChild(css);

  var fab = document.createElement('div'); fab.id = 'gh-fab';
  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(fab); renderPanel(); });
  if (document.readyState !== 'loading') { document.body.appendChild(fab); }
  function renderPanel() {
    var s = window.__revmapCloudStatus(), cls = s.cls === 'err' ? 'err' : s.cls === 'warn' ? 'warn' : s.cls === '' ? 'ok' : '';
    fab.innerHTML = '<span class="dot ' + cls + '"></span><span>GitHub</span>' +
      (st.token ? '<button data-g="sync" title="Ctrl/⌘ + Shift + S">立即同步</button><button data-g="out">退出</button>' : '<button data-g="in">连接</button>');
  }
  fab.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    if (b.dataset.g === 'sync') { clearTimeout(syncTimer); sync(); }
    if (b.dataset.g === 'in') showCover();
    if (b.dataset.g === 'out') {
      if (st.dirty && !confirm('还有未同步的修改，确定退出？')) return;
      try { localStorage.removeItem(TOKEN_KEY); } catch (er) { /* ignore */ }
      st.token = null; st.loaded = false; status();
    }
  });

  var cover = null;
  function showCover() {
    if (!cover) {
      cover = document.createElement('div'); cover.id = 'gh-cover';
      cover.innerHTML = '<div class="card"><h2>连接 GitHub</h2>' +
        '<p>这张修改地图的数据保存在私有仓库 <code>' + (CFG.owner || '?') + '/' + (CFG.repo || '?') + '</code>。请粘贴你自己的 GitHub token（需要对该仓库有读写权限）。token 只保存在这台电脑的浏览器里。</p>' +
        '<input id="gh-tok" type="password" placeholder="ghp_… 或 github_pat_…" autocomplete="off">' +
        '<div class="err" id="gh-err"></div>' +
        '<div class="row"><button data-c="skip">先只在本机浏览</button><button class="pri" data-c="go">连接并载入</button></div></div>';
      document.body.appendChild(cover);
      cover.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.dataset.c === 'skip') hideCover();
        if (b.dataset.c === 'go') connect($('#gh-tok', cover).value.trim());
      });
      cover.addEventListener('keydown', function (e) { if (e.key === 'Enter') connect($('#gh-tok', cover).value.trim()); });
    }
    $('#gh-err', cover).textContent = st.error || '';
    cover.hidden = false;
    setTimeout(function () { var i = $('#gh-tok', cover); if (i) i.focus(); }, 50);
  }
  function hideCover() { if (cover) cover.hidden = true; }
  function $(s, el) { return (el || document).querySelector(s); }

  function connect(tok) {
    if (!tok) { $('#gh-err', cover).textContent = '请先粘贴 token'; return; }
    st.token = tok; st.error = '';
    fetch(API + '/user', { headers: { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw httpErr(r); return r.json(); })
      .then(function (u) {
        st.login = u.login || '';
        try { localStorage.setItem(TOKEN_KEY, tok); } catch (e) { /* ignore */ }
        return load();
      })
      .catch(function (e) { st.token = null; st.error = e.message; if (cover) $('#gh-err', cover).textContent = e.message; status(); });
  }

  function start() {
    if (!CFG.owner || !CFG.repo || CFG.owner === 'YOUR_GITHUB_NAME') {
      st.error = 'config.js 还没有填写数据仓库'; renderPanel(); showCover(); return;
    }
    if (!st.token) { showCover(); renderPanel(); return; }
    fetch(API + '/user', { headers: { 'Authorization': 'Bearer ' + st.token, 'Accept': 'application/vnd.github+json' }, cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : {}; }).then(function (u) { st.login = u.login || ''; renderPanel(); })
      .catch(function () { /* offline */ });
    load();
  }
  setInterval(poll, CFG.pollSeconds * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 0); }); else setTimeout(start, 0);

  window.RevmapCloud = { sync: sync, load: load, merge3: merge3, state: st };   // for debugging / tests
})();
