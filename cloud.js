/* 修改地图 · 在线协作（GitHub 私有仓库同步 + 署名评论）
 * 数据放在私有仓库里：data.json（地图）、assets.json（图片和附件）、comments.json（评论，第一次评论时自动创建）。
 * 打开分享链接（#key=…）的人填一个名字就能修改和评论，不需要 GitHub 账号。
 * 多人同时修改时按"条目 + 字段"三方合并；评论按条目合并，互不覆盖。
 */
(function () {
  'use strict';
  var CFG = Object.assign({ branch: 'main', dataPath: 'data.json', assetsPath: 'assets.json', commentsPath: 'comments.json', autoSyncSeconds: 15, pollSeconds: 20 },
                          window.REVMAP_CONFIG || {});
  var TOKEN_KEY = 'revmap-gh-token', LAST_KEY = 'revmap-gh-last', NAME_KEY = 'revmap-name', SEEN_KEY = 'revmap-cm-seen', CLIENT_KEY = 'revmap-client';
  var API = 'https://api.github.com';
  var COLLS = ['reviewers', 'excerpts', 'issues', 'solutions', 'responses', 'links'];

  var st = {
    token: null, login: '', name: '', base: null, baseSha: null, assetsSha: null, remoteAssetKeys: new Set(),
    dirty: false, syncing: false, loaded: false, error: '', keyError: false, lastSync: null, pendingApply: null, conflicts: 0,
    headSha: null, headEtag: null
  };
  var cm = { list: [], base: [], sha: null, loaded: false, dirty: false, syncing: false, again: false, error: '', acts: [], timer: 0 };
  var ui = { pop: null, popTarget: null, drawer: null, tab: 'cm', filter: 'open', reply: null, edit: null, drafts: {},
             hist: null, histErr: '', histLoading: false, seen: '' };

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) { /* private mode */ } }

  st.token = lsGet(TOKEN_KEY);
  // A share link carries the edit key in the URL fragment (#key=...). The fragment is never sent to any server.
  (function () {
    var m = /(?:^#|&)key=([^&]+)/.exec(location.hash || '');
    if (!m) return;
    st.token = decodeURIComponent(m[1]); st.fromLink = true;
    lsSet(TOKEN_KEY, st.token);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* ignore */ }
  })();
  st.name = lsGet(NAME_KEY) || '';
  ui.seen = lsGet(SEEN_KEY) || '';
  var CLIENT = lsGet(CLIENT_KEY);
  if (!CLIENT) { CLIENT = 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); lsSet(CLIENT_KEY, CLIENT); }
  function who() { return st.name || '匿名'; }

  /* ---------- helpers ---------- */
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function hm(d) { return d ? pad(d.getHours()) + ':' + pad(d.getMinutes()) : ''; }
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
  function esc(t) { return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function cssq(s) { return window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'); }
  function $(s, el) { return (el || document).querySelector(s); }
  function cut(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) + '…' : s; }
  function modKey() { return /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl'; }
  function fmtTime(iso) {
    var d = new Date(iso); if (isNaN(d)) return '';
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return '刚刚';
    if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
    var now = new Date(), y = new Date(now.getTime() - 864e5), t = hm(d);
    if (d.toDateString() === now.toDateString()) return '今天 ' + t;
    if (d.toDateString() === y.toDateString()) return '昨天 ' + t;
    return (d.getFullYear() === now.getFullYear() ? '' : d.getFullYear() + '-') + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + t;
  }
  function fullTime(iso) { var d = new Date(iso); return isNaN(d) ? '' : d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + hm(d); }
  // Typing in the map (not in the comment boxes) holds back remote updates until the field is left.
  function editing() {
    var a = document.activeElement;
    if (!a || !(a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.tagName === 'SELECT' || a.isContentEditable)) return false;
    return !(a.closest && a.closest('#cm-pop,#cm-drawer,#cm-name,#gh-cover'));
  }
  function app() { return window.RevmapAPI; }
  function toast(m, label, fn) { if (app()) app().toast(m, label, fn); }
  function status() { if (app()) app().refreshStatus(); renderPanel(); }

  /* ---------- GitHub API ---------- */
  function repoBase() { return API + '/repos/' + encodeURIComponent(CFG.owner) + '/' + encodeURIComponent(CFG.repo); }
  function url(path) { return repoBase() + '/contents/' + path.split('/').map(encodeURIComponent).join('/'); }
  // Only headers that GitHub's CORS policy allows from a browser (Authorization, Accept, Content-Type, If-None-Match).
  function headers(accept) { return { 'Authorization': 'Bearer ' + st.token, 'Accept': accept || 'application/vnd.github+json' }; }
  function gh(method, u, body, accept) {
    var h = headers(accept);
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
    var m;
    if (r.status === 401) m = st.fromLink ? '这个链接的钥匙已失效（被删除或已过期），请向作者要一个新链接' : 'token 无效或已过期';
    else if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
      var reset = +r.headers.get('x-ratelimit-reset') || 0, mins = reset ? Math.max(1, Math.ceil((reset * 1000 - Date.now()) / 60000)) : 0;
      m = 'GitHub 接口次数暂时用完' + (mins ? '，约 ' + mins + ' 分钟后恢复' : '');
    } else if (r.status === 403) m = '没有权限（token 没有授权这个仓库的读写）';
    else if (r.status === 404) m = '找不到仓库或文件（检查 config.js 里的 owner、repo，以及 token 是否授权了这个仓库）';
    else m = 'GitHub 返回 ' + r.status;
    var e = new Error(m); e.status = r.status; return e;
  }
  // One cheap request tells whether anything in the repository changed; unchanged answers (304) do not count against the API limit.
  function headChanged() {
    var h = headers();
    if (st.headEtag) h['If-None-Match'] = st.headEtag;
    return fetch(repoBase() + '/git/ref/heads/' + encodeURIComponent(CFG.branch), { headers: h, cache: 'no-store' }).then(function (r) {
      if (r.status === 304) return false;
      if (!r.ok) return true;
      var et = r.headers.get('ETag'); if (et) st.headEtag = et;
      return r.json().then(function (j) {
        var sha = j && j.object && j.object.sha;
        if (sha && sha === st.headSha) return false;
        st.headSha = sha || null; return true;
      });
    }).catch(function () { return true; });
  }
  function commitsOf(path, n) {
    return gh('GET', repoBase() + '/commits?sha=' + encodeURIComponent(CFG.branch) + '&path=' + encodeURIComponent(path) + '&per_page=' + n + '&t=' + Date.now())
      .then(function (r) { if (!r.ok) throw httpErr(r); return r.json(); });
  }
  function parseMsg(m) {
    m = String(m || '').split('\n')[0];
    var x = /^\[(?:修改地图|评论)\]\s*(.+?)：(.*)$/.exec(m); if (x) return { who: x[1], what: x[2] };
    x = /^修改地图：(.+?)\s+(更新|添加附件)$/.exec(m); if (x) return { who: x[1], what: x[2] === '更新' ? '更新了地图' : '添加了附件' };
    return { who: '', what: m };
  }

  /* ---------- three-way merge ---------- */
  var MC = { n: 0 };
  function mergeObj(b, l, r) {
    b = b || {}; l = l || {}; r = r || {};
    var out = {}, keys = {};
    [b, l, r].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = 1; }); });
    Object.keys(keys).forEach(function (k) {
      var lv = l[k], rv = r[k], bv = b[k], v;
      if (eq(lv, bv)) v = rv; else if (eq(rv, bv)) v = lv; else if (eq(lv, rv)) v = lv;
      else { v = lv; MC.n++; }
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
    MC.n = 0;
    function rest(x) { var o = {}; Object.keys(x || {}).forEach(function (k) { if (k !== 'meta' && COLLS.indexOf(k) < 0) o[k] = x[k]; }); return o; }
    var out = mergeObj(rest(B), rest(L), rest(R));
    out.meta = mergeObj(B.meta, L.meta, R.meta);
    COLLS.forEach(function (c) { out[c] = mergeColl(B[c], L[c], R[c]); });
    st.conflicts = MC.n;
    return out;
  }

  /* ---------- who changed what (goes into each commit message) ---------- */
  var FIELD = { title: '标题', subtitle: '副标题', summary: '审稿人要点', next: '理由与下一步', code: '编号', pri: '优先级', category: '归类', loc: '论文位置',
    who: '来源', text: '内容', note: '备注', kind: '类型', reviewer: '审稿人', detail: '做法说明', steps: '步骤', status: '状态', owner: '负责人',
    where: '论文改动位置', resolved: '解决了什么', result: '目前的结果', progress: '进度', figures: '结果图', files: '附件', quote: '引文', order: '顺序',
    bullet: '格式', short: '简称', name: '全称', color: '颜色' };
  function nameOf(c, o) {
    if (c === 'issues') return '问题 ' + (o.kind === 'ok' ? '无需修改' : (o.code || '「' + cut(o.title, 14) + '」'));
    if (c === 'solutions') return '做法「' + cut(o.title, 16) + '」';
    if (c === 'responses') return cut(o.text, 14) ? '回复「' + cut(o.text, 14) + '」' : '回复（空白）';
    if (c === 'excerpts') return '原文「' + cut(o.text, 12) + '」';
    if (c === 'reviewers') return '审稿人 ' + (o.short || '');
    return c;
  }
  function describe(B, L) {
    if (!B || !L) return '';
    var parts = [], reorder = 0;
    ['title', 'subtitle'].forEach(function (k) { if (B.meta && L.meta && (B.meta[k] || '') !== (L.meta[k] || '')) parts.push('修改地图' + FIELD[k]); });
    COLLS.forEach(function (c) {
      var bm = new Map((B[c] || []).map(function (x) { return [x.id, x]; })), lm = new Map((L[c] || []).map(function (x) { return [x.id, x]; }));
      if (c === 'links') {
        var add = 0, del = 0, mod = 0;
        lm.forEach(function (x, id) { if (!bm.has(id)) add++; else if (!eq(x, bm.get(id))) mod++; });
        bm.forEach(function (x, id) { if (!lm.has(id)) del++; });
        if (add) parts.push('新增连接 ' + add + ' 条');
        if (del) parts.push('删除连接 ' + del + ' 条');
        if (mod) parts.push('修改引文 ' + mod + ' 处');
        return;
      }
      lm.forEach(function (x, id) {
        var b = bm.get(id);
        if (!b) { parts.push('新增' + nameOf(c, x)); return; }
        if (eq(x, b)) return;
        var fs = [];
        Object.keys(Object.assign({}, b, x)).forEach(function (k) { if (!eq(x[k], b[k])) { var f = FIELD[k] || k; if (fs.indexOf(f) < 0) fs.push(f); } });
        if (fs.length === 1 && fs[0] === '顺序') { reorder++; return; }
        fs = fs.filter(function (f) { return f !== '顺序'; });
        if (c === 'solutions' && fs.indexOf('进度') >= 0 && fs.indexOf('状态') >= 0) fs.splice(fs.indexOf('状态'), 1);
        parts.push('修改' + nameOf(c, x) + '（' + fs.join('、') + '）');
      });
      bm.forEach(function (x, id) { if (!lm.has(id)) parts.push('删除' + nameOf(c, x)); });
    });
    if (reorder) parts.push('调整顺序');
    if (parts.length > 6) return parts.slice(0, 5).join('；') + '；等共 ' + parts.length + ' 处';
    return parts.join('；');
  }

  /* ---------- load / sync / poll: the map ---------- */
  function load() {
    st.error = ''; st.keyError = false; showLoading(true); status();
    var dmeta;
    return getMeta(CFG.dataPath).then(function (m) {
      if (!m) throw new Error('仓库里还没有 ' + CFG.dataPath + '：请先把 revmap-data 文件夹里的文件上传到 ' + CFG.owner + '/' + CFG.repo);
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
      lsSet(LAST_KEY, JSON.stringify({ owner: CFG.owner, repo: CFG.repo, id: x.data.meta && x.data.meta.id }));
      app().setData(x.data, x.assets);
      hideCover(); showLoading(false); status();
      return loadComments();
    }).catch(function (e) {
      st.error = e.message || String(e); st.keyError = e.status === 401; showLoading(false); status(); showCover();
    });
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
        return putText(CFG.assetsPath, JSON.stringify(remote), am && am.sha, '[修改地图] ' + who() + '：添加附件或图片 ' + need.length + ' 个')
          .then(function (sha) { st.assetsSha = sha; st.remoteAssetKeys = new Set(Object.keys(remote)); });
      });
    });
  }

  function sync(tries) {
    tries = tries || 0;
    if (!st.token || !st.loaded || st.syncing) return Promise.resolve();
    st.syncing = true; st.error = ''; status();
    var local = app().getData(), merged, remoteSha, remote = null, desc = describe(st.base, local);
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
      return putText(CFG.dataPath, JSON.stringify(merged, null, 1), remoteSha, '[修改地图] ' + who() + '：' + (desc || '更新'));
    }).then(function (sha) {
      var changedByOthers = !eq(stripSaved(merged), stripSaved(app().getData()));
      st.base = clone(merged); st.baseSha = sha; st.syncing = false; st.lastSync = new Date();
      st.dirty = !eq(stripSaved(app().getData()), stripSaved(local));   // edits made while syncing stay pending
      if (changedByOthers && !st.dirty) applyRemote(merged, null);
      if (st.conflicts) toast('与他人的修改合并完成（' + st.conflicts + ' 处同一字段被同时修改，保留了你的版本）');
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

  function pollData() {
    if (st.syncing || st.dirty) { st.headSha = null; return Promise.resolve(); }   // the next sync merges whatever changed remotely
    return getMeta(CFG.dataPath).then(function (m) {
      if (!m || m.sha === st.baseSha) return;
      return getText(CFG.dataPath, m).then(function (t) {
        var data = JSON.parse(t);
        return refreshAssetsIfNeeded().then(function (assets) {
          if (st.dirty || st.syncing) { st.headSha = null; return; }   // user started editing meanwhile; sync will merge
          st.base = clone(data); st.baseSha = m.sha; st.lastSync = new Date();
          applyRemote(data, assets);
          status();
          commitsOf(CFG.dataPath, 1).then(function (a) {
            var p = a && a[0] ? parseMsg(a[0].commit.message) : null;
            toast(p && p.who ? '已载入 ' + p.who + ' 的修改：' + cut(p.what, 48) : '已载入合作者的最新修改');
          }).catch(function () { toast('已载入合作者的最新修改'); });
          if (ui.hist) loadHistory(true);
        });
      });
    }).catch(function () { st.headSha = null; });
  }

  function poll() {
    if (!st.token || !st.loaded || document.hidden) return;
    headChanged().then(function (changed) {
      if (!changed) return;
      pollData(); pollComments();
    });
  }

  var syncTimer = null;
  function scheduleSync() { clearTimeout(syncTimer); syncTimer = setTimeout(sync, CFG.autoSyncSeconds * 1000); }

  /* ---------- comments: storage and sync ---------- */
  function parseComments(t) {
    try { var j = JSON.parse(t || '{}'); return Array.isArray(j) ? j : (Array.isArray(j.comments) ? j.comments : []); } catch (e) { return []; }
  }
  function loadComments() {
    return getMeta(CFG.commentsPath).then(function (m) {
      if (!m) return { list: [], sha: null };
      return getText(CFG.commentsPath, m).then(function (t) { return { list: parseComments(t), sha: m.sha }; });
    }).then(function (x) {
      cm.list = x.list; cm.base = clone(x.list); cm.sha = x.sha; cm.loaded = true; cm.error = '';
      renderAll(false); status();
    }).catch(function (e) { cm.error = e.message || String(e); renderAll(false); status(); });
  }
  function syncComments(tries) {
    tries = tries || 0;
    if (!st.token || !cm.loaded) return Promise.resolve();
    if (cm.syncing) { cm.again = true; return Promise.resolve(); }
    cm.syncing = true; cm.error = '';
    var start = clone(cm.list), acts = cm.acts.slice(), remote = null, rsha = null, merged;
    return getMeta(CFG.commentsPath).then(function (m) {
      rsha = m ? m.sha : null;
      if (m && rsha !== cm.sha) return getText(CFG.commentsPath, m).then(function (t) { remote = parseComments(t); return mergeColl(cm.base, start, remote); });
      if (!m && cm.sha) { remote = []; return mergeColl(cm.base, start, []); }
      return start;
    }).then(function (mg) {
      merged = mg;
      var remoteList = remote !== null ? remote : cm.base;
      if (!rsha && !merged.length) return null;                 // nothing to store yet
      if (rsha && eq(merged, remoteList)) return rsha;            // remote already has everything
      var msg = '[评论] ' + who() + '：' + (acts.length ? summarizeActs(acts) : '更新评论');
      return putText(CFG.commentsPath, JSON.stringify({ schema: 1, comments: merged }, null, 1), rsha, msg);
    }).then(function (sha) {
      var before = new Set(cm.list.map(function (c) { return c.id; }));
      cm.list = mergeColl(start, cm.list, merged);                // keep whatever was written while syncing
      cm.base = clone(merged); cm.sha = sha; cm.syncing = false;
      cm.acts = cm.acts.slice(acts.length);
      cm.dirty = !eq(cm.list, cm.base);
      noticeNew(cm.list.filter(function (c) { return !before.has(c.id); }));
      renderAll(false); status();
      if (cm.dirty || cm.again) { cm.again = false; setTimeout(syncComments, 300); }
    }).catch(function (e) {
      cm.syncing = false;
      if (e && e.conflict && tries < 4) return syncComments(tries + 1);
      cm.error = (e && e.message) || String(e); renderAll(false); status();
      clearTimeout(cm.timer); cm.timer = setTimeout(syncComments, 15000);
    });
  }
  function pollComments() {
    if (!st.token) return Promise.resolve();
    if (!cm.loaded) return loadComments();
    if (cm.syncing || cm.dirty) { st.headSha = null; return Promise.resolve(); }
    return getMeta(CFG.commentsPath).then(function (m) {
      var sha = m ? m.sha : null;
      if (sha === cm.sha) return;
      return (m ? getText(CFG.commentsPath, m).then(parseComments) : Promise.resolve([])).then(function (list) {
        if (cm.syncing || cm.dirty) { st.headSha = null; return; }
        var before = new Set(cm.list.map(function (c) { return c.id; }));
        cm.base = clone(list); cm.list = clone(list); cm.sha = sha; cm.error = '';
        noticeNew(list.filter(function (c) { return !before.has(c.id); }));
        renderAll(false); status();
      });
    }).catch(function () { st.headSha = null; });
  }
  function summarizeActs(a) {
    var uniq = []; a.forEach(function (x) { if (uniq.indexOf(x) < 0) uniq.push(x); });
    return uniq.length > 3 ? uniq.slice(0, 3).join('；') + '；等 ' + uniq.length + ' 项' : uniq.join('；');
  }
  function noticeNew(list) {
    var mine = list.filter(function (c) { return c.uid !== CLIENT; });
    if (!mine.length) return;
    var c = mine[mine.length - 1];
    var msg = mine.length === 1 ? (c.author || '有人') + (c.parent ? ' 回复了 ' : ' 评论了 ') + actLabel(c.target, c) : '收到 ' + mine.length + ' 条新评论';
    toast(msg, '查看', function () { openDrawer('cm'); });
  }

  /* ---------- comments: model ---------- */
  function cid() { return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function byAt(a, b) { return a.at < b.at ? -1 : a.at > b.at ? 1 : 0; }
  function byId(id) { for (var i = 0; i < cm.list.length; i++) if (cm.list[i].id === id) return cm.list[i]; return null; }
  function idSet() { return new Set(cm.list.map(function (c) { return c.id; })); }
  // Thread starters, plus replies whose starter was deleted.
  function threadRoots(target) {
    var all = idSet();
    return cm.list.filter(function (c) { return (target === undefined || c.target === target) && (!c.parent || !all.has(c.parent)); }).sort(byAt);
  }
  function repliesOf(id) { return cm.list.filter(function (c) { return c.parent === id; }).sort(byAt); }
  function stats() {
    var m = new Map(), all = idSet();
    cm.list.forEach(function (c) {
      var s = m.get(c.target); if (!s) { s = { open: 0, total: 0, last: '' }; m.set(c.target, s); }
      s.total++; if (c.at > s.last) s.last = c.at;
      if ((!c.parent || !all.has(c.parent)) && !c.resolved) s.open++;
    });
    return m;
  }
  function openTotal() { var n = 0; stats().forEach(function (s) { n += s.open; }); return n; }
  function unreadCount() { return cm.list.filter(function (c) { return c.uid !== CLIENT && c.at > ui.seen; }).length; }
  function markSeen() { ui.seen = new Date().toISOString(); lsSet(SEEN_KEY, ui.seen); }
  function sampleOf(target) { for (var i = 0; i < cm.list.length; i++) if (cm.list[i].target === target) return cm.list[i]; return null; }
  function tinfo(target, sample) {
    if (!target) return { kind: '整体', label: '整张修改地图', color: '#55626E' };
    var L = app() && app().labelOf(target);
    if (L) return L;
    return { kind: (sample && sample.kind) || '条目', label: (sample && sample.label) || target, color: '#8B97A2', gone: true };
  }
  function actLabel(target, sample) {
    if (!target) return '整张地图';
    var I = tinfo(target, sample || sampleOf(target));
    return I.kind + ' ' + cut(I.label, 18);
  }
  function mine(c) { return c.uid ? c.uid === CLIENT : c.author === who(); }

  function post(target, text, parent) {
    text = String(text || '').trim();
    if (!text) return false;
    if (!st.name) { showNameGate(false, function () { post(target, text, parent); }); return false; }
    if (!cm.loaded) { toast(cm.error ? '评论载入失败：' + cm.error : '评论还在载入，稍等几秒再发'); return false; }
    var L = target ? app().labelOf(target) : null, s = target ? sampleOf(target) : null;
    cm.list.push({
      id: cid(), target: target || '', parent: parent || '',
      kind: L ? L.kind : (target ? (s && s.kind) || '条目' : '整体'), label: L ? L.label : (target ? (s && s.label) || '' : '整张修改地图'),
      author: who(), uid: CLIENT, text: text, at: new Date().toISOString(), edited: '', resolved: false, resolvedBy: '', resolvedAt: ''
    });
    if (parent) {
      var r = byId(parent);
      if (r && r.resolved) { r.resolved = false; r.resolvedBy = ''; r.resolvedAt = ''; }   // a new reply reopens the thread
      ui.reply = null; delete ui.drafts['reply:' + parent];
    } else delete ui.drafts['new:' + (target || '')];
    cm.acts.push((parent ? '回复了 ' : '评论了 ') + actLabel(target));
    changedComments();
    return true;
  }
  function setResolved(id, v) {
    var c = byId(id); if (!c) return;
    c.resolved = v; c.resolvedBy = v ? who() : ''; c.resolvedAt = v ? new Date().toISOString() : '';
    cm.acts.push((v ? '解决了 ' : '重新打开了 ') + actLabel(c.target, c) + ' 的评论');
    changedComments();
  }
  function saveEdit(id, text) {
    var c = byId(id); text = String(text || '').trim(); if (!c || !text) return;
    c.text = text; c.edited = new Date().toISOString(); ui.edit = null; delete ui.drafts['edit:' + id];
    cm.acts.push('编辑了 ' + actLabel(c.target, c) + ' 的评论');
    changedComments();
  }
  function delComment(id) {
    var c = byId(id); if (!c) return;
    var reps = repliesOf(id);
    if (!confirm('删除这条评论？' + (reps.length ? '它下面的 ' + reps.length + ' 条回复也会一起删除。' : ''))) return;
    var gone = new Set([id].concat(reps.map(function (x) { return x.id; })));
    cm.list = cm.list.filter(function (x) { return !gone.has(x.id); });
    cm.acts.push('删除了 ' + actLabel(c.target, c) + ' 的评论');
    changedComments();
  }
  function changedComments() {
    cm.dirty = true; renderAll(true); status();
    clearTimeout(cm.timer); cm.timer = setTimeout(syncComments, 300);
  }

  /* ---------- comments: views ---------- */
  var ICON_C = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.25h10c.69 0 1.25.56 1.25 1.25v6c0 .69-.56 1.25-1.25 1.25H8.2L5.25 14v-2.25H3c-.69 0-1.25-.56-1.25-1.25v-6c0-.69.56-1.25 1.25-1.25z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>';
  var AV = ['#1F5FBF', '#2D7A4B', '#A44A1B', '#7B4BB7', '#B86E0A', '#0F7C86', '#B3261E', '#55626E'];
  function avatar(name) {
    var h = 0; name = String(name || '?');
    for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
    return '<span class="cm-av" style="background:' + AV[Math.abs(h) % AV.length] + '">' + esc(Array.from(name)[0] || '?') + '</span>';
  }
  function linkify(t) { return esc(t).replace(/https?:\/\/[^\s<>"']+/g, function (u) { return '<a href="' + u + '" target="_blank" rel="noopener noreferrer">' + u + '</a>'; }); }
  function draft(k, def) { return ui.drafts[k] != null ? ui.drafts[k] : (def || ''); }
  function kindTag(I) { return '<span class="cm-kind" style="color:' + esc(I.color || '#55626E') + '">' + esc(I.kind) + '</span>'; }
  function commentHTML(c, isRoot) {
    var own = mine(c), h = '<div class="cm-c' + (isRoot ? '' : ' reply') + '" data-cid="' + esc(c.id) + '"><div class="cm-meta">' + avatar(c.author) +
      '<b>' + esc(c.author || '匿名') + '</b><time title="' + esc(fullTime(c.at)) + '">' + esc(fmtTime(c.at)) + '</time>' +
      (c.edited ? '<span title="' + esc(fullTime(c.edited)) + '">已编辑</span>' : '') +
      (isRoot && c.resolved ? '<span class="cm-res">已解决' + (c.resolvedBy ? ' · ' + esc(c.resolvedBy) : '') + '</span>' : '') + '</div>';
    if (ui.edit === c.id) {
      var k = 'edit:' + c.id;
      h += '<div class="cm-reply flat"><textarea data-draft="' + esc(k) + '" rows="3" aria-label="编辑评论">' + esc(draft(k, c.text)) + '</textarea>' +
        '<div class="cm-crow"><span class="sp"></span><button class="cm-btn" data-cmx="edit-cancel">取消</button><button class="cm-btn pri" data-cmx="edit-save" data-id="' + esc(c.id) + '">保存</button></div></div>';
    } else h += '<div class="cm-text">' + linkify(c.text) + '</div>';
    h += '<div class="cm-acts">';
    if (isRoot) h += '<button data-cmx="reply" data-id="' + esc(c.id) + '">回复</button>' +
      (c.resolved ? '<button data-cmx="reopen" data-id="' + esc(c.id) + '">重新打开</button>' : '<button data-cmx="resolve" data-id="' + esc(c.id) + '">标为已解决</button>');
    if (own && ui.edit !== c.id) h += '<button data-cmx="edit" data-id="' + esc(c.id) + '">编辑</button><button class="danger" data-cmx="del" data-id="' + esc(c.id) + '">删除</button>';
    return h + '</div></div>';
  }
  function threadHTML(root) {
    var orphan = !!root.parent;
    var h = '<div class="cm-th' + (root.resolved ? ' resolved' : '') + '" data-root="' + esc(root.id) + '">';
    if (orphan) h += '<div class="cm-note tight">（原评论已删除）</div>';
    h += commentHTML(root, true);
    repliesOf(root.id).forEach(function (r) { h += commentHTML(r, false); });
    if (ui.reply === root.id) {
      var k = 'reply:' + root.id;
      h += '<div class="cm-reply"><textarea data-draft="' + esc(k) + '" rows="2" placeholder="回复…（' + modKey() + '+Enter 发送）" aria-label="回复">' + esc(draft(k)) + '</textarea>' +
        '<div class="cm-crow"><span class="sp"></span><button class="cm-btn" data-cmx="reply-cancel">取消</button><button class="cm-btn pri" data-cmx="reply-send" data-id="' + esc(root.id) + '">回复</button></div></div>';
    }
    return h + '</div>';
  }
  function composerHTML(t) {
    var k = 'new:' + t;
    return '<div class="cm-compose"><textarea data-draft="' + esc(k) + '" rows="3" placeholder="' + (t ? '写评论' : '对整张地图的评论') + '…（' + modKey() + '+Enter 发送）" aria-label="写评论">' + esc(draft(k)) + '</textarea>' +
      '<div class="cm-crow"><span>以 <b>' + esc(who()) + '</b> 的名字发表 · <button class="cm-link" data-cmx="rename">改名</button></span><span class="sp"></span>' +
      '<button class="cm-btn pri" data-cmx="post" data-t="' + esc(t) + '">发表</button></div></div>';
  }
  function popHTML() {
    var t = ui.popTarget, I = tinfo(t, sampleOf(t)), roots = threadRoots(t);
    return '<div class="cm-ph">' + kindTag(I) + '<b' + (I.gone ? ' class="cm-gone"' : '') + '>' + esc(I.label) + (I.gone ? '（已删除）' : '') + '</b>' +
      '<button class="cm-x" data-cmx="pop-close" aria-label="关闭" title="关闭（Esc）">×</button></div>' +
      '<div class="cm-pb">' + (roots.length ? roots.map(threadHTML).join('') : '<div class="cm-empty">还没有评论，写下第一条吧。</div>') + '</div>' + composerHTML(t);
  }
  function groupHTML(t, general) {
    var roots = threadRoots(t).filter(function (r) { return ui.filter === 'all' || !r.resolved; });
    if (!general && !roots.length) return '';
    var I = tinfo(t, sampleOf(t));
    var h = '<div class="cm-group' + (general ? ' general' : '') + '"><div class="cm-gh">' + kindTag(I) + '<b' + (I.gone ? ' class="cm-gone"' : '') + '>' + esc(I.label) + (I.gone ? '（已删除）' : '') + '</b>' +
      (!general && !I.gone ? '<button class="cm-btn sm" data-cmx="goto" data-t="' + esc(t) + '" title="在地图上找到这一条">定位</button>' : '') + '</div>';
    h += roots.map(threadHTML).join('');
    if (general) h += composerHTML('');
    return h + '</div>';
  }
  function drawerComments() {
    var all = threadRoots(), open = all.filter(function (r) { return !r.resolved; }).length, S2 = stats(), targets = [];
    var h = '<div class="cm-tools"><div class="cm-seg"><button data-cmf="open" aria-pressed="' + (ui.filter === 'open') + '">未解决 ' + open + '</button>' +
      '<button data-cmf="all" aria-pressed="' + (ui.filter === 'all') + '">全部 ' + all.length + '</button></div><span class="sp"></span>' +
      '<button class="cm-btn sm" data-cmx="export" title="把全部评论下载成 Markdown 文件">导出</button></div>';
    if (!cm.loaded) h += '<p class="cm-note">' + (cm.error ? '评论载入失败：' + esc(cm.error) : '正在载入评论…') + '</p>';
    h += '<p class="cm-note tight">在地图上点一下某一条（原文、问题、做法或回复），它旁边会出现「评论」按钮；也可以在下面写对整张地图的评论。</p>';
    S2.forEach(function (s, t) { if (t) targets.push([t, s]); });
    targets.sort(function (a, b) { return a[1].last < b[1].last ? 1 : a[1].last > b[1].last ? -1 : 0; });
    h += groupHTML('', true);
    var rest = targets.map(function (x) { return groupHTML(x[0], false); }).join('');
    h += rest || (ui.filter === 'open' && all.length ? '<p class="cm-note">条目上的评论都已解决。点「全部」可以查看。</p>' : '');
    return h;
  }
  function drawerHistory() {
    var h = '<div class="cm-tools"><b class="cm-tt">最近的修改</b><span class="sp"></span><button class="cm-btn sm" data-cmx="hist-refresh">刷新</button></div>';
    if (ui.histLoading && !ui.hist) return h + '<p class="cm-note">正在载入…</p>';
    if (ui.histErr) h += '<p class="cm-note">载入失败：' + esc(ui.histErr) + '</p>';
    (ui.hist || []).forEach(function (x) {
      h += '<div class="cm-hist"><div class="cm-meta">' + (x.who ? avatar(x.who) + '<b>' + esc(x.who) + '</b>' : '<b>GitHub</b>') +
        '<time title="' + esc(fullTime(x.at)) + '">' + esc(fmtTime(x.at)) + '</time></div><p>' + esc(x.what) + '</p></div>';
    });
    if (ui.hist && !ui.hist.length) h += '<p class="cm-note">还没有修改记录。</p>';
    return h + '<p class="cm-note">这里显示最近 50 次对地图的修改（不含评论）。仓库拥有者可以在 GitHub 上打开 <code>' + esc(CFG.dataPath) + '</code> → History，查看每一次的具体改动并找回旧版本。</p>';
  }
  function drawerHTML() {
    var n = openTotal();
    return '<div class="cm-dh"><div class="cm-tabs" role="tablist"><button data-cmt="cm" role="tab" aria-pressed="' + (ui.tab === 'cm') + '">评论' + (n ? ' ' + n : '') + '</button>' +
      '<button data-cmt="hist" role="tab" aria-pressed="' + (ui.tab === 'hist') + '">修改记录</button></div><span class="sp"></span>' +
      '<button class="cm-x" data-cmx="drawer-close" aria-label="关闭" title="关闭">×</button></div><div class="cm-db">' + (ui.tab === 'cm' ? drawerComments() : drawerHistory()) + '</div>';
  }
  function loadHistory(quiet) {
    if (!st.token) return;
    ui.histLoading = true; if (!quiet) { ui.histErr = ''; renderDrawer(true); }
    commitsOf(CFG.dataPath, 50).then(function (arr) {
      ui.hist = (arr || []).map(function (c) {
        var p = parseMsg(c.commit && c.commit.message), a = c.commit && (c.commit.author || c.commit.committer);
        return { who: p.who, what: p.what, at: a && a.date };
      });
      ui.histLoading = false; ui.histErr = ''; renderDrawer(false);
    }).catch(function (e) { ui.histLoading = false; ui.histErr = e.message || String(e); renderDrawer(false); });
  }

  // Re-rendering a box while someone types in it (Chinese IME especially) would break their input, so remote updates wait until they leave it.
  function busy(box) { var a = document.activeElement; return !!(box && a && a.tagName === 'TEXTAREA' && box.contains(a)); }
  function keepFocus(box, fn) {
    var a = document.activeElement, key = a && box && box.contains(a) && a.dataset ? a.dataset.draft : null;
    var s0 = key != null ? a.selectionStart : 0, s1 = key != null ? a.selectionEnd : 0;
    var sc = box ? Array.prototype.map.call(box.querySelectorAll('.cm-pb,.cm-db'), function (x) { return x.scrollTop; }) : [];
    fn();
    if (box) Array.prototype.forEach.call(box.querySelectorAll('.cm-pb,.cm-db'), function (x, i) { if (sc[i] != null) x.scrollTop = sc[i]; });
    if (key != null) { var n = box.querySelector('textarea[data-draft="' + cssq(key) + '"]'); if (n) { n.focus({ preventScroll: true }); try { n.setSelectionRange(s0, s1); } catch (e) { /* ignore */ } } }
  }
  function renderPop(force) {
    if (!ui.pop) return;
    if (!force && busy(ui.pop)) { ui.pop.stale = true; return; }
    ui.pop.stale = false;
    keepFocus(ui.pop, function () { ui.pop.innerHTML = popHTML(); });
  }
  function renderDrawer(force) {
    if (!ui.drawer || ui.drawer.hidden) return;
    if (!force && busy(ui.drawer)) { ui.drawer.stale = true; return; }
    ui.drawer.stale = false;
    keepFocus(ui.drawer, function () { ui.drawer.innerHTML = drawerHTML(); });
  }
  document.addEventListener('focusout', function () {
    setTimeout(function () {
      if (ui.pop && ui.pop.stale && !busy(ui.pop)) renderPop(true);
      if (ui.drawer && ui.drawer.stale && !busy(ui.drawer)) renderDrawer(true);
    }, 0);
  });
  function renderAll(force) {
    renderPop(force); renderDrawer(force);
    decorate(); if (app()) app().redrawWires();
    refreshInspBlock();
    if (ui.drawer && !ui.drawer.hidden && ui.tab === 'cm' && !document.hidden) markSeen();   // what is on screen counts as read
    renderPanel();
  }

  function openPop(target, anchor) {
    if (!cm.loaded) { toast(cm.error ? '评论载入失败：' + cm.error : '评论还在载入，稍等一下'); return; }
    closePop();
    ui.popTarget = target || ''; ui.reply = null; ui.edit = null;
    var el = document.createElement('div'); el.id = 'cm-pop'; el.className = 'cm-pop'; el.setAttribute('role', 'dialog'); el.setAttribute('aria-label', '评论');
    document.body.appendChild(el); ui.pop = el;
    el.innerHTML = popHTML();
    place(el, anchor);
    var ta = el.querySelector('.cm-compose textarea'); if (ta) ta.focus({ preventScroll: true });
  }
  function place(el, anchor) {
    var vw = window.innerWidth, vh = window.innerHeight;
    var r = anchor && anchor.getBoundingClientRect && anchor.isConnected ? anchor.getBoundingClientRect() : { left: vw / 2 - 210, top: vh * 0.2, bottom: vh * 0.2 };
    var w = el.offsetWidth, h = el.offsetHeight;
    var left = Math.min(Math.max(12, r.left - 16), vw - w - 12);
    var top = r.bottom + 8;
    if (top + h > vh - 12) top = r.top - h - 8;
    if (top < 12) top = Math.max(12, vh - h - 12);
    el.style.left = Math.max(12, left) + 'px'; el.style.top = top + 'px';
  }
  function closePop() { if (ui.pop) { ui.pop.remove(); ui.pop = null; ui.popTarget = null; ui.reply = null; ui.edit = null; } }
  function openDrawer(tab) {
    ui.tab = tab || ui.tab || 'cm';
    if (!ui.drawer) {
      ui.drawer = document.createElement('aside'); ui.drawer.id = 'cm-drawer'; ui.drawer.className = 'cm-drawer'; ui.drawer.setAttribute('aria-label', '评论和修改记录');
      document.body.appendChild(ui.drawer);
    }
    closePop();
    if (app()) app().closeInspector();
    ui.drawer.hidden = false; markSeen();
    renderDrawer(true); renderPanel();
    if (ui.tab === 'hist') loadHistory();
  }
  function closeDrawer() { if (ui.drawer) ui.drawer.hidden = true; }

  /* rows: a small comment chip on every item that has comments, and on the selected item */
  var HOST = { excerpt: '.para-text', issue: '.imeta', solution: '.t', response: '.rl' };
  function decorate() {
    var ws = document.getElementById('ws'); if (!ws) return;
    var old = ws.querySelectorAll('.cm-chip'); for (var i = 0; i < old.length; i++) old[i].remove();
    if (!st.loaded || !cm.loaded) return;
    var S2 = stats(), f = app() ? app().getFocus() : null, rows = ws.querySelectorAll('.row[data-id]');
    for (var j = 0; j < rows.length; j++) {
      var row = rows[j], id = row.dataset.id, s = S2.get(id);
      if (!s && id !== f) continue;
      var host = row.querySelector(HOST[row.dataset.type]) || row, b = document.createElement('button');
      b.type = 'button'; b.dataset.cm = id;
      if (s) {
        b.className = 'cm-chip ' + (s.open ? 'open' : 'done');
        b.dataset.n = s.open ? String(s.open) : '✓';
        b.title = s.open ? s.open + ' 条未解决的评论（共 ' + s.total + ' 条），点开查看或回复' : '评论都已解决（共 ' + s.total + ' 条）';
      } else { b.className = 'cm-chip new'; b.dataset.n = '评论'; b.title = '评论这一条'; }
      b.setAttribute('aria-label', b.title);
      b.innerHTML = ICON_C;   // the count is drawn by CSS, so it never becomes part of a text selection
      host.appendChild(b);
    }
  }
  window.__revmapDecorate = decorate;

  /* inspector: a comment summary at the top */
  function inspBlockHTML(id) {
    var s = stats().get(id);
    if (!s) return '<div class="cm-ib none">' + ICON_C + '<span>还没有评论</span><span class="sp"></span><button type="button" class="cm-btn sm" data-cmo="' + esc(id) + '">写评论</button></div>';
    return '<div class="cm-ib' + (s.open ? '' : ' none') + '">' + ICON_C + '<span>' + (s.open ? '<b>' + s.open + '</b> 条未解决的评论，' : '评论都已解决，') + '共 ' + s.total + ' 条</span><span class="sp"></span>' +
      '<button type="button" class="cm-btn sm" data-cmo="' + esc(id) + '">查看 / 回复</button></div>';
  }
  window.__revmapInspector = function (el, id) {
    // The inspector and the comment panel share the right edge; the one opened last wins.
    if (ui.drawer && !ui.drawer.hidden && el && !el.classList.contains('left')) closeDrawer();
    var body = el && el.querySelector('.insp-body'); if (!body || !id || !st.loaded || !cm.loaded) return;
    var L = app().labelOf(id); if (!L || L.type === 'reviewer') return;
    var old = body.querySelector('.cm-ib'); if (old) old.remove();
    body.insertAdjacentHTML('afterbegin', inspBlockHTML(id));
  };
  function refreshInspBlock() {
    var el = document.getElementById('insp'); if (!el) return;
    var b = el.querySelector('.cm-ib'), btn = b && b.querySelector('[data-cmo]'); if (!btn) return;
    b.outerHTML = inspBlockHTML(btn.dataset.cmo);
  }

  /* export */
  function exportMD() {
    var d = app().getData(), title = d.meta.title || '修改地图';
    var lines = ['# 评论 · ' + title, '', '导出时间：' + fullTime(new Date().toISOString()) + '　共 ' + cm.list.length + ' 条', ''];
    var targets = [''].concat(Array.from(stats().keys()).filter(Boolean));
    targets.forEach(function (t) {
      var roots = threadRoots(t); if (!roots.length) return;
      var I = tinfo(t, sampleOf(t));
      lines.push('## ' + (t ? I.kind + '：' : '') + I.label + (I.gone ? '（已删除）' : ''), '');
      roots.forEach(function (r) {
        lines.push('- **' + r.author + '**（' + fullTime(r.at) + '）' + (r.resolved ? ' ✅ 已解决' + (r.resolvedBy ? '（' + r.resolvedBy + '）' : '') : '') + '：' + r.text.replace(/\n/g, '\n  '));
        repliesOf(r.id).forEach(function (x) { lines.push('  - **' + x.author + '**（' + fullTime(x.at) + '）：' + x.text.replace(/\n/g, '\n    ')); });
      });
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown;charset=utf-8' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = title.replace(/[\\/:*?"<>|]+/g, '') + '-评论.md';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
  }

  /* events: comment chips stay out of the map's own click handling */
  window.addEventListener('pointerdown', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    if (t.closest('.cm-chip')) { e.stopPropagation(); return; }
    if (ui.pop && !t.closest('#cm-pop') && !t.closest('#cm-name') && !t.closest('[data-cmo]') && !t.closest('.toast')) closePop();
  }, true);
  ['mousedown', 'mouseup', 'dblclick'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { if (e.target && e.target.closest && e.target.closest('.cm-chip')) e.stopPropagation(); }, true);
  });
  window.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var chip = t.closest('.cm-chip,[data-cmo]'); if (!chip) return;
    e.stopPropagation(); e.preventDefault();
    var id = chip.dataset.cm != null ? chip.dataset.cm : chip.dataset.cmo;
    if (ui.pop && ui.popTarget === id && chip.classList.contains('cm-chip')) { closePop(); return; }
    openPop(id, chip);
  }, true);
  document.addEventListener('click', function (e) {
    var t = e.target; if (!t || !t.closest) return;
    var box = t.closest('#cm-pop,#cm-drawer'); if (!box) return;
    var tab = t.closest('[data-cmt]');
    if (tab) { ui.tab = tab.dataset.cmt; renderDrawer(true); if (ui.tab === 'hist') loadHistory(!!ui.hist); return; }
    var fl = t.closest('[data-cmf]'); if (fl) { ui.filter = fl.dataset.cmf; renderDrawer(true); return; }
    var b = t.closest('[data-cmx]'); if (!b) return;
    var a = b.dataset.cmx, id = b.dataset.id;
    function val(k) { var n = box.querySelector('textarea[data-draft="' + cssq(k) + '"]'); return n ? n.value : ''; }
    if (a === 'pop-close') closePop();
    else if (a === 'drawer-close') closeDrawer();
    else if (a === 'post') { var tg = b.dataset.t || ''; post(tg, val('new:' + tg), ''); }
    else if (a === 'reply') { ui.reply = id; ui.edit = null; renderAll(true); focusDraft(box, 'reply:' + id); }
    else if (a === 'reply-cancel') { ui.reply = null; renderAll(true); }
    else if (a === 'reply-send') { var r = byId(id); post(r ? r.target : '', val('reply:' + id), id); }
    else if (a === 'resolve' || a === 'reopen') setResolved(id, a === 'resolve');
    else if (a === 'edit') { ui.edit = id; ui.reply = null; delete ui.drafts['edit:' + id]; renderAll(true); focusDraft(box, 'edit:' + id); }
    else if (a === 'edit-cancel') { ui.edit = null; renderAll(true); }
    else if (a === 'edit-save') saveEdit(id, val('edit:' + id));
    else if (a === 'del') delComment(id);
    else if (a === 'goto') {
      var tg2 = b.dataset.t;
      if (window.innerWidth <= 960) closeDrawer();
      if (app().goto(tg2)) setTimeout(function () { openPop(tg2, document.querySelector('#ws .cm-chip[data-cm="' + cssq(tg2) + '"]')); }, 500);
    }
    else if (a === 'export') exportMD();
    else if (a === 'hist-refresh') loadHistory();
    else if (a === 'rename') showNameGate(true);
  });
  function focusDraft(box, k) { var n = box && box.querySelector('textarea[data-draft="' + cssq(k) + '"]'); if (n) { n.focus(); n.setSelectionRange(n.value.length, n.value.length); } }
  document.addEventListener('input', function (e) { var k = e.target && e.target.dataset && e.target.dataset.draft; if (k != null) ui.drafts[k] = e.target.value; });
  document.addEventListener('keydown', function (e) {
    var tg = e.target, k = tg && tg.dataset && tg.dataset.draft;
    if (k == null || e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.isComposing) return;
    e.preventDefault();
    var wrap = tg.closest('.cm-compose,.cm-reply'), btn = wrap && wrap.querySelector('.cm-btn.pri');
    if (btn) btn.click();
  });
  window.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var g = document.getElementById('cm-name');
    if (g && !g.hidden) { e.stopPropagation(); if (st.name) hideNameGate(); return; }
    if (ui.pop) { e.stopPropagation(); e.preventDefault(); closePop(); return; }
    if (ui.drawer && !ui.drawer.hidden && ui.drawer.contains(document.activeElement)) { e.stopPropagation(); closeDrawer(); }
  }, true);

  /* ---------- hooks into the page ---------- */
  window.__revmapOnChange = function () {
    if (!st.loaded) return;
    st.dirty = true; status(); scheduleSync();
  };
  window.__revmapCloudStatus = function () {
    if (!st.token) return { cls: 'warn', text: '未连接：请用分享链接打开' };
    if (st.error) return { cls: 'err', text: '同步出错：' + st.error };
    if (!st.loaded) return { cls: 'idle', text: '正在从 GitHub 载入…' };
    if (cm.error) return { cls: 'err', text: '评论同步出错：' + cm.error };
    if (st.syncing) return { cls: 'idle', text: '正在同步…' };
    if (st.dirty) return { cls: 'warn', text: '有未同步的修改（' + CFG.autoSyncSeconds + ' 秒内自动同步）' };
    if (st.pendingApply) return { cls: 'warn', text: '合作者有新修改，离开输入框后载入' };
    return { cls: '', text: '已同步 ' + hm(st.lastSync) + ' · ' + who() };
  };
  window.addEventListener('beforeunload', function (e) {
    if (st.dirty || st.syncing || cm.dirty || cm.syncing) { e.preventDefault(); e.returnValue = ''; }
  });
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'S' || e.key === 's')) { e.preventDefault(); clearTimeout(syncTimer); sync(); syncComments(); }
  });

  /* ---------- UI: styles ---------- */
  var css = document.createElement('style');
  css.textContent = [
    '#gh-fab{position:fixed;left:14px;bottom:14px;z-index:60;display:flex;gap:6px;align-items:center;flex-wrap:wrap;max-width:calc(100vw - 28px);background:#fff;border:1px solid var(--rule,#D6DCE1);border-radius:999px;padding:5px 6px 5px 12px;box-shadow:0 4px 14px rgba(28,39,51,.12);font:12.5px/1.2 var(--sans,sans-serif);color:var(--ink,#1C2733)}',
    '#gh-fab .dot{width:8px;height:8px;border-radius:50%;background:#8B97A2;flex:none}#gh-fab .dot.ok{background:#2D7A4B}#gh-fab .dot.warn{background:#B86E0A}#gh-fab .dot.err{background:#B3261E}',
    '#gh-fab button{display:inline-flex;align-items:center;gap:4px;border:1px solid var(--rule,#D6DCE1);background:#F4F6F8;border-radius:999px;padding:4px 10px;cursor:pointer;font:inherit;color:inherit;max-width:12em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
    '#gh-fab button:hover{border-color:var(--pencil,#1F5FBF);color:var(--pencil,#1F5FBF)}#gh-fab svg{width:13px;height:13px;flex:none}',
    '#gh-fab button.cmb{position:relative;font-weight:600;color:var(--pencil-ink,#174A96);background:#EEF3FB;border-color:#BFD0EA;overflow:visible}',
    '#gh-fab button.cmb i{position:absolute;top:-3px;right:-3px;width:9px;height:9px;border-radius:50%;background:#D93025;box-shadow:0 0 0 2px #fff}',
    '#gh-cover,#cm-name,#gh-loading{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;padding:16px;font:14px/1.6 var(--sans,sans-serif);color:var(--ink,#1C2733)}',
    '#gh-cover{z-index:80;background:rgba(230,234,237,.94)}#cm-name{z-index:85;background:rgba(230,234,237,.94)}#gh-loading{z-index:75;background:rgba(230,234,237,.82)}',
    '#gh-cover .card,#cm-name .card,#gh-loading .card{background:#fff;border:1px solid var(--rule,#D6DCE1);border-radius:12px;max-width:520px;width:100%;padding:22px 24px;box-shadow:0 10px 40px rgba(28,39,51,.18)}',
    '#gh-loading .card{width:auto;display:flex;gap:12px;align-items:center;padding:16px 22px}',
    '#gh-loading i{width:16px;height:16px;border:2px solid var(--rule,#D6DCE1);border-top-color:var(--pencil,#1F5FBF);border-radius:50%;animation:ghspin .8s linear infinite}@keyframes ghspin{to{transform:rotate(360deg)}}',
    '#gh-cover h2,#cm-name h2{margin:0 0 6px;font-size:18px}#gh-cover p,#cm-name p{margin:6px 0;color:var(--ink-2,#55626E)}',
    '#gh-cover input{width:100%;height:36px;border:1px solid var(--rule,#D6DCE1);border-radius:8px;padding:0 10px;margin:8px 0;font:13px ui-monospace,Menlo,monospace}',
    '#cm-name input{width:100%;height:42px;border:1px solid var(--rule,#D6DCE1);border-radius:8px;padding:0 12px;margin:12px 0 4px;font:16px var(--sans,sans-serif)}',
    '#gh-cover .row,#cm-name .row{display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap}',
    '#gh-cover button,#cm-name button{border:1px solid var(--rule,#D6DCE1);background:#fff;border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit}',
    '#gh-cover button.pri,#cm-name button.pri{background:var(--pencil,#1F5FBF);color:#fff;border-color:var(--pencil,#1F5FBF)}#cm-name button.pri:disabled{opacity:.45;cursor:default}',
    '#gh-cover .err{color:var(--danger,#B3261E);font-size:13px}#gh-cover code{background:#F4F6F8;padding:1px 5px;border-radius:4px;font-size:12.5px}',
    '#gh-cover details{margin-top:14px;border-top:1px solid var(--rule-2,#E8ECEF);padding-top:10px}#gh-cover summary{cursor:pointer;color:var(--pencil-ink,#174A96);font-size:13px}',
    '.cm-chip{display:inline-flex;align-items:center;gap:3px;height:18px;padding:0 6px;margin-left:6px;border:1px solid transparent;border-radius:999px;font:600 11px/1 var(--sans,sans-serif);vertical-align:2px;cursor:pointer;user-select:none;-webkit-user-select:none;white-space:nowrap;flex:none}',
    '.cm-chip svg{width:12px;height:12px;flex:none}.cm-chip::after{content:attr(data-n)}',
    '.cm-chip.open{background:#FFF4D6;border-color:#EBC250;color:#6E4B00}.cm-chip.done{background:#EEF1F4;border-color:#D6DCE1;color:#6B7782}',
    '.cm-chip.new{background:#fff;border-color:#BFD0EA;color:var(--pencil-ink,#174A96)}.cm-chip:hover{border-color:var(--pencil,#1F5FBF)}',
    '.imeta .cm-chip,.rl .cm-chip{margin-left:0}',
    '.cm-pop,.cm-drawer{background:#fff;font:13px/1.55 var(--sans,sans-serif);color:var(--ink,#1C2733);display:flex;flex-direction:column}',
    '.cm-pop{position:fixed;z-index:58;width:min(420px,calc(100vw - 24px));max-height:min(74vh,660px);border-radius:12px;box-shadow:0 16px 44px rgba(28,39,51,.26),0 0 0 1px var(--rule-2,#E8ECEF)}',
    '.cm-drawer{position:fixed;top:12px;right:12px;bottom:12px;z-index:56;width:min(430px,calc(100vw - 24px));border-radius:12px;box-shadow:0 16px 44px rgba(28,39,51,.24),0 0 0 1px var(--rule-2,#E8ECEF)}',
    '.cm-drawer[hidden]{display:none}',
    '.cm-ph,.cm-dh{display:flex;align-items:flex-start;gap:8px;padding:12px 10px 10px 14px;border-bottom:1px solid var(--rule-2,#E8ECEF)}.cm-dh{align-items:center;padding:10px 10px 10px 12px}',
    '.cm-ph b{flex:1;font-size:13px;line-height:1.45;overflow-wrap:anywhere}.cm-gone{color:var(--ink-3,#8B97A2)}',
    '.cm-x{border:0;background:transparent;width:28px;height:28px;border-radius:6px;cursor:pointer;color:var(--ink-2,#55626E);font:20px/1 var(--sans,sans-serif);flex:none}.cm-x:hover{background:#F1F4F6}',
    '.cm-pb{overflow:auto;padding:2px 14px;flex:1;min-height:44px}.cm-db{overflow:auto;flex:1;padding:0 14px 16px}',
    '.cm-empty{color:var(--ink-3,#8B97A2);padding:12px 0;font-size:12.5px}',
    '.cm-th{padding:10px 0;border-bottom:1px solid var(--rule-2,#E8ECEF)}.cm-th:last-child{border-bottom:0}.cm-th.resolved>.cm-c .cm-text{color:var(--ink-2,#55626E)}',
    '.cm-c+.cm-c{margin-top:8px}.cm-c.reply{margin-left:12px;padding-left:10px;border-left:2px solid var(--rule-2,#E8ECEF)}',
    '.cm-meta{display:flex;align-items:center;gap:7px;font-size:12px;color:var(--ink-3,#8B97A2);flex-wrap:wrap}.cm-meta b{color:var(--ink,#1C2733);font-size:12.5px}',
    '.cm-av{display:inline-grid;place-items:center;width:20px;height:20px;border-radius:50%;color:#fff;font:600 11px/1 var(--sans,sans-serif);flex:none}',
    '.cm-res{font-size:11px;color:var(--answer,#2D7A4B);background:#E8F3EC;border-radius:4px;padding:1px 6px}',
    '.cm-text{white-space:pre-wrap;overflow-wrap:anywhere;margin:3px 0 0 27px;font-size:13px;line-height:1.6}.cm-c.reply .cm-text{margin-left:27px}',
    '.cm-text a{color:var(--pencil-ink,#174A96)}',
    '.cm-acts{display:flex;gap:2px;margin:2px 0 0 21px;flex-wrap:wrap}',
    '.cm-acts button{border:0;background:transparent;color:var(--ink-2,#55626E);font:12px/1 var(--sans,sans-serif);padding:5px 6px;border-radius:5px;cursor:pointer}',
    '.cm-acts button:hover{background:#F1F4F6;color:var(--pencil-ink,#174A96)}.cm-acts button.danger:hover{color:var(--danger,#B3261E)}',
    '.cm-compose{border-top:1px solid var(--rule-2,#E8ECEF);padding:10px 12px 12px}',
    '.cm-compose textarea,.cm-reply textarea{display:block;width:100%;min-height:58px;max-height:220px;resize:vertical;border:1px solid var(--rule,#D6DCE1);border-radius:8px;padding:7px 9px;font:13px/1.5 var(--sans,sans-serif);background:#fff;color:inherit}',
    '.cm-compose textarea:focus,.cm-reply textarea:focus{outline:2px solid var(--pencil,#1F5FBF);outline-offset:-1px;border-color:transparent}',
    '.cm-reply{margin:8px 0 0 22px}.cm-reply.flat{margin:4px 0 0 27px}',
    '.cm-crow{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:12px;color:var(--ink-3,#8B97A2);flex-wrap:wrap}.cm-pop .sp,.cm-drawer .sp,.cm-ib .sp{flex:1}',
    '.cm-btn{height:28px;padding:0 12px;border:1px solid var(--rule,#D6DCE1);background:#fff;border-radius:7px;font:12.5px/1 var(--sans,sans-serif);cursor:pointer;color:var(--ink,#1C2733);white-space:nowrap;flex:none}',
    '.cm-btn.sm{height:26px;padding:0 10px;font-size:12px}.cm-btn:hover{border-color:#B6C0C9}',
    '.cm-btn.pri{background:var(--pencil,#1F5FBF);border-color:var(--pencil,#1F5FBF);color:#fff}.cm-btn.pri:hover{background:var(--pencil-ink,#174A96)}',
    '.cm-link{border:0;background:transparent;color:var(--pencil-ink,#174A96);font:inherit;padding:0;cursor:pointer;text-decoration:underline;text-underline-offset:2px}',
    '.cm-tabs{display:flex;gap:2px;background:#F1F4F6;border-radius:8px;padding:2px}',
    '.cm-tabs button{border:0;background:transparent;border-radius:6px;padding:6px 12px;font:600 12.5px/1 var(--sans,sans-serif);color:var(--ink-2,#55626E);cursor:pointer}',
    '.cm-tabs button[aria-pressed=true]{background:#fff;color:var(--ink,#1C2733);box-shadow:0 1px 2px rgba(28,39,51,.14)}',
    '.cm-tools{position:sticky;top:0;background:#fff;z-index:1;display:flex;align-items:center;gap:8px;padding:10px 0 8px}.cm-tt{font-size:12.5px}',
    '.cm-seg{display:flex;border:1px solid var(--rule,#D6DCE1);border-radius:7px;overflow:hidden}',
    '.cm-seg button{border:0;background:#fff;padding:6px 10px;font:12px/1 var(--sans,sans-serif);cursor:pointer;color:var(--ink-2,#55626E)}.cm-seg button+button{border-left:1px solid var(--rule,#D6DCE1)}',
    '.cm-seg button[aria-pressed=true]{background:var(--pencil-wash,rgba(31,95,191,.09));color:var(--pencil-ink,#174A96);font-weight:600}',
    '.cm-group{margin-top:12px;border:1px solid var(--rule-2,#E8ECEF);border-radius:10px;padding:0 12px 2px}.cm-group .cm-compose{border-top:0;padding:8px 0 10px}',
    '.cm-gh{display:flex;align-items:flex-start;gap:8px;padding:10px 0 7px;border-bottom:1px solid var(--rule-2,#E8ECEF)}.cm-gh b{flex:1;font-size:12.5px;line-height:1.45;overflow-wrap:anywhere}',
    '.cm-kind{flex:none;font:600 11px/1 var(--sans,sans-serif);padding:3px 6px;border-radius:4px;border:1px solid currentColor;margin-top:1px;background:#fff}',
    '.cm-note{font-size:12px;color:var(--ink-3,#8B97A2);margin:10px 0 0;line-height:1.55}.cm-note.tight{margin:0 0 4px}.cm-note code{background:#F4F6F8;padding:0 4px;border-radius:3px}',
    '.cm-hist{padding:10px 0;border-bottom:1px solid var(--rule-2,#E8ECEF)}.cm-hist p{margin:3px 0 0 27px;font-size:12.5px;color:var(--ink-2,#55626E);overflow-wrap:anywhere}',
    '.cm-ib{display:flex;align-items:center;gap:8px;margin:0 0 14px;padding:7px 8px 7px 10px;border-radius:8px;background:#FFF8E6;border:1px solid #F0D58A;font-size:12.5px;color:#6B4D00}',
    '.cm-ib.none{background:#F6F8FA;border-color:var(--rule-2,#E8ECEF);color:var(--ink-2,#55626E)}.cm-ib svg{width:14px;height:14px;flex:none}',
    '@media (max-width:640px){#gh-fab{left:8px;right:8px;bottom:8px;border-radius:14px}.cm-drawer{top:0;right:0;bottom:0;width:100vw;border-radius:0}.cm-db{padding-bottom:120px}}'
  ].join('\n');
  document.head.appendChild(css);

  /* ---------- UI: floating bar ---------- */
  var fab = document.createElement('div'); fab.id = 'gh-fab';
  function mountFab() { if (!fab.isConnected && document.body) document.body.appendChild(fab); renderPanel(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountFab); else mountFab();
  function renderPanel() {
    if (!fab.isConnected) return;
    var s = window.__revmapCloudStatus(), cls = s.cls === 'err' ? 'err' : s.cls === 'warn' ? 'warn' : s.cls === '' ? 'ok' : '';
    var n = cm.loaded ? openTotal() : 0, unread = cm.loaded ? unreadCount() : 0;
    fab.innerHTML = '<span class="dot ' + cls + '" title="' + esc(s.text) + '"></span><span>' + (st.loaded ? '在线' : 'GitHub') + '</span>' +
      (st.token
        ? '<button class="cmb" data-g="cm" title="全部评论和修改记录">' + ICON_C + '评论' + (n ? ' ' + n : '') + (unread ? '<i title="有新评论"></i>' : '') + '</button>' +
          '<button data-g="name" title="你的名字（评论和修改记录里显示），点一下修改">' + esc(st.name || '未署名') + '</button>' +
          '<button data-g="share" title="复制一个任何人打开就能修改和评论的链接">分享链接</button>' +
          '<button data-g="sync" title="立即同步（Ctrl/⌘ + Shift + S）">同步</button>' +
          '<button data-g="out" title="在这台电脑上退出（清除钥匙）">退出</button>'
        : '<button data-g="in">连接</button>');
  }
  fab.addEventListener('click', function (e) {
    var b = e.target.closest('button'); if (!b) return;
    var g = b.dataset.g;
    if (g === 'cm') { if (ui.drawer && !ui.drawer.hidden) closeDrawer(); else openDrawer('cm'); }
    else if (g === 'sync') { clearTimeout(syncTimer); sync(); syncComments(); }
    else if (g === 'in') showCover();
    else if (g === 'name') showNameGate(true);
    else if (g === 'share') shareLink();
    else if (g === 'out') {
      if ((st.dirty || cm.dirty) && !confirm('还有没同步完的修改，确定退出？')) return;
      if (!confirm('退出后这台电脑上的钥匙会被清除，需要重新打开分享链接才能继续。确定退出？')) return;
      lsDel(TOKEN_KEY); st.token = null; st.loaded = false; cm.loaded = false; closePop(); closeDrawer(); renderAll(true); status(); showCover();
    }
  });

  /* ---------- UI: name, link, cover, loading ---------- */
  var gate = null, gateThen = null;
  function showNameGate(rename, then) {
    gateThen = then || null;
    if (!gate) {
      gate = document.createElement('div'); gate.id = 'cm-name';
      document.body.appendChild(gate);
      gate.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return; if (b.dataset.n === 'ok') saveName(); else if (b.dataset.n === 'cancel') hideNameGate(); });
      gate.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); saveName(); } });
      gate.addEventListener('input', function () { var i = gate.querySelector('input'), b = gate.querySelector('[data-n="ok"]'); if (i && b) b.disabled = !i.value.trim(); });
    }
    gate.innerHTML = '<div class="card" role="dialog" aria-modal="true" aria-labelledby="cm-name-h"><h2 id="cm-name-h">' + (rename && st.name ? '修改名字' : '欢迎！先留个名字') + '</h2>' +
      '<p>你在这里写的评论、做的修改都会署上这个名字，方便大家知道是谁写的。不需要注册账号。</p>' +
      '<input type="text" maxlength="30" autocomplete="name" placeholder="例如：王老师、Strange" value="' + esc(st.name) + '" aria-label="你的名字">' +
      '<div class="row">' + (rename && st.name ? '<button data-n="cancel">取消</button>' : '') + '<button class="pri" data-n="ok"' + (st.name ? '' : ' disabled') + '>' + (rename && st.name ? '保存' : '开始') + '</button></div></div>';
    gate.hidden = false;
    setTimeout(function () { var i = gate.querySelector('input'); if (i) { i.focus(); i.select(); } }, 30);
  }
  function saveName() {
    var i = gate.querySelector('input'), v = String(i && i.value || '').replace(/\s+/g, ' ').trim().slice(0, 30);
    if (!v) { if (i) i.focus(); return; }
    st.name = v; lsSet(NAME_KEY, v);
    hideNameGate(); status(); renderAll(true);
    var f = gateThen; gateThen = null; if (f) f();
  }
  function hideNameGate() { if (gate) gate.hidden = true; }

  function shareLink() {
    if (!st.token) return;
    var link = location.origin + location.pathname + '#key=' + encodeURIComponent(st.token);
    var note = '这个链接里带着编辑钥匙：任何拿到链接的人打开后填个名字，就能查看、修改和评论这张修改地图。\n只发给合作者；要作废，在 GitHub 上删除这个 token，再生成新链接。';
    function done() { alert('已复制分享链接。\n\n' + note); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function () { prompt(note + '\n\n复制下面的链接：', link); });
    else prompt(note + '\n\n复制下面的链接：', link);
  }

  var cover = null;
  function configMissing() { return !CFG.owner || !CFG.repo || CFG.owner === 'YOUR_GITHUB_NAME'; }
  function showCover() {
    if (!cover) {
      cover = document.createElement('div'); cover.id = 'gh-cover';
      document.body.appendChild(cover);
      cover.addEventListener('click', function (e) {
        var b = e.target.closest('button'); if (!b) return;
        if (b.dataset.c === 'go') connect($('#gh-tok', cover).value.trim());
        if (b.dataset.c === 'retry') { hideCover(); load(); }
      });
      cover.addEventListener('keydown', function (e) { if (e.key === 'Enter' && e.target.id === 'gh-tok') connect(e.target.value.trim()); });
    }
    var h = '<div class="card">';
    if (configMissing()) {
      h += '<h2>网站还没有配置好</h2><p>请仓库拥有者打开网站仓库里的 <code>config.js</code>，把 <code>owner</code> 改成自己的 GitHub 用户名，保存后等一两分钟再刷新。</p>';
    } else if (!st.token || st.keyError) {
      h += '<h2>请用分享链接打开</h2>' + (st.keyError ? '<p class="err">' + esc(st.error) + '</p>' : '') +
        '<p>这张修改地图只对合作者开放。请用作者发给你的链接打开（链接末尾带 <code>#key=…</code>）；打开后填个名字，就能直接修改和评论，不需要 GitHub 账号。</p>';
    } else {
      h += '<h2>暂时无法载入</h2><p class="err">' + esc(st.error) + '</p><div class="row"><button class="pri" data-c="retry">重试</button></div>';
    }
    if (!configMissing()) {
      h += '<details' + (st.token && !st.keyError ? '' : '') + '><summary>我是仓库拥有者：用 token 连接</summary>' +
        '<p>粘贴只授权 <code>' + esc(CFG.owner + '/' + CFG.repo) + '</code>、Contents 可读写的 fine-grained token。它只保存在这台电脑的浏览器里。连上以后点左下角「分享链接」，就能生成给合作者的链接。</p>' +
        '<input id="gh-tok" type="password" placeholder="github_pat_…" autocomplete="off"><div class="err" id="gh-err"></div>' +
        '<div class="row"><button class="pri" data-c="go">连接并载入</button></div></details>';
    }
    cover.innerHTML = h + '</div>';
    cover.hidden = false;
  }
  function hideCover() { if (cover) cover.hidden = true; }
  var loadingEl = null;
  function showLoading(on) {
    if (on && !loadingEl) {
      loadingEl = document.createElement('div'); loadingEl.id = 'gh-loading';
      loadingEl.innerHTML = '<div class="card"><i></i><span>正在载入修改地图（含附件，第一次会慢一些）…</span></div>';
      (document.body || document.documentElement).appendChild(loadingEl);
    }
    if (loadingEl) loadingEl.hidden = !on;
  }

  function connect(tok) {
    var err = cover && $('#gh-err', cover);
    if (!tok) { if (err) err.textContent = '请先粘贴 token'; return; }
    st.token = tok; st.error = ''; st.keyError = false; st.fromLink = false;
    fetch(API + '/user', { headers: headers(), cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw httpErr(r); return r.json(); })
      .then(function (u) {
        st.login = u.login || '';
        lsSet(TOKEN_KEY, tok);
        hideCover();
        if (!st.name) showNameGate(false);
        return load();
      })
      .catch(function (e) { st.token = null; st.error = e.message; if (err) err.textContent = e.message; status(); });
  }

  function start() {
    if (configMissing()) { st.error = 'config.js 还没有填写数据仓库'; renderPanel(); showCover(); return; }
    if (!st.token) { renderPanel(); showCover(); return; }
    if (!st.name) showNameGate(false);
    load();
  }
  setInterval(poll, Math.max(5, CFG.pollSeconds) * 1000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) poll(); });
  setInterval(function () { if (ui.pop || (ui.drawer && !ui.drawer.hidden)) renderAll(false); }, 60000);   // keep "n 分钟前" fresh
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(start, 0); }); else setTimeout(start, 0);

  window.RevmapCloud = { sync: sync, syncComments: syncComments, load: load, poll: poll, merge3: merge3, describe: describe, state: st, comments: cm, ui: ui };   // for debugging / tests
})();
