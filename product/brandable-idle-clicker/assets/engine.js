/* 放置クリッカー・エンジン
 *
 * このファイルは編集しなくて構いません。見た目・文言・数値・登場物はすべて
 * brand.config.json 側で決まります。仕様は README.md を読んでください。
 *
 * 依存ライブラリはありません。ビルドも不要です。静的ファイルとして置くだけで動きます。
 */
(function () {
  'use strict';

  var TICK_MS = 100;
  var SAVE_MS = 5000;
  var COST_GROWTH = 1.15;

  var cfg = null;
  var state = null;
  var saveKey = 'idlekit';
  var lastTick = 0;
  var lastSave = 0;
  var tickerTimer = 0;

  /* ---------- 表示 ---------- */

  var UNITS = [
    [1e20, '垓'], [1e16, '京'], [1e12, '兆'], [1e8, '億'], [1e4, '万']
  ];

  function fmt(n) {
    if (!isFinite(n)) return '∞';
    if (n < 0) return '-' + fmt(-n);
    // 序盤は毎秒0.2などの小さな増分になる。整数だけを出すと画面が止まって見えて、
    // 「増えている」ことが伝わらない。1000未満は小数第1位まで出す。
    if (n < 1000) return (n % 1 !== 0) ? n.toFixed(1) : String(n);
    if (n < 10000) return String(Math.floor(n));
    for (var i = 0; i < UNITS.length; i++) {
      if (n >= UNITS[i][0]) {
        var v = n / UNITS[i][0];
        return (v >= 100 ? v.toFixed(0) : v.toFixed(2).replace(/\.?0+$/, '')) + UNITS[i][1];
      }
    }
    return String(Math.floor(n));
  }

  function el(id) { return document.getElementById(id); }

  function fail(message) {
    var box = el('boot');
    box.hidden = false;
    box.className = 'boot error';
    box.textContent = '設定を読み込めませんでした。\n\n' + message +
      '\n\nbrand.config.json を確認してください。python3 validate_config.py で検査できます。';
    var app = el('app');
    if (app) app.hidden = true;
  }

  /* ---------- 設定の検査 ---------- */

  function need(obj, path) {
    var parts = path.split('.');
    var cur = obj;
    for (var i = 0; i < parts.length; i++) {
      if (cur === null || typeof cur !== 'object' || !(parts[i] in cur)) {
        throw new Error('必須項目がありません: ' + path);
      }
      cur = cur[parts[i]];
    }
    return cur;
  }

  function validate(c) {
    need(c, 'meta.title');
    need(c, 'currency.name');
    need(c, 'tapTarget.baseValue');
    if (!Array.isArray(c.generators) || c.generators.length === 0) {
      throw new Error('generators を1つ以上書いてください');
    }
    var seen = {};
    c.generators.concat(c.upgrades || []).forEach(function (item) {
      if (!item.id) throw new Error('id の無い項目があります: ' + JSON.stringify(item).slice(0, 60));
      if (seen[item.id]) throw new Error('id が重複しています: ' + item.id);
      seen[item.id] = true;
    });
    c.generators.forEach(function (g) {
      if (!(g.baseCost > 0)) throw new Error(g.id + ': baseCost は正の数にしてください');
      if (!(g.baseRate > 0)) throw new Error(g.id + ': baseRate は正の数にしてください');
    });
    (c.upgrades || []).forEach(function (u) {
      if (!(u.cost > 0)) throw new Error(u.id + ': cost は正の数にしてください');
      var t = (u.effect || {}).type;
      if (['tapMultiplier', 'rateMultiplier', 'offlineMultiplier'].indexOf(t) < 0) {
        throw new Error(u.id + ': effect.type は tapMultiplier / rateMultiplier / offlineMultiplier のいずれかです');
      }
      if (!(u.effect.value > 0)) throw new Error(u.id + ': effect.value は正の数にしてください');
    });
    return c;
  }

  /* ---------- テーマ ---------- */

  function applyTheme() {
    var t = cfg.theme || {};
    var root = document.documentElement.style;
    var map = {
      '--bg': t.background, '--panel': t.panel, '--edge': t.panelEdge,
      '--text': t.text, '--muted': t.textMuted, '--accent': t.accent,
      '--accent-text': t.accentText, '--positive': t.positive, '--negative': t.negative
    };
    Object.keys(map).forEach(function (k) { if (map[k]) root.setProperty(k, map[k]); });
    if (t.cornerRadius != null) root.setProperty('--radius', t.cornerRadius + 'px');

    document.title = cfg.meta.title;
    document.documentElement.lang = cfg.meta.lang || 'ja';
    if (cfg.meta.faviconEmoji) {
      var link = document.createElement('link');
      link.rel = 'icon';
      link.href = 'data:image/svg+xml,' + encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
        '<text y="52" font-size="52">' + cfg.meta.faviconEmoji + '</text></svg>');
      document.head.appendChild(link);
    }
    if (cfg.meta.description) {
      var m = document.createElement('meta');
      m.name = 'description';
      m.content = cfg.meta.description;
      document.head.appendChild(m);
    }
  }

  /* ---------- 保存 ---------- */

  function freshState() {
    return { currency: 0, earned: 0, owned: {}, bought: {}, prestige: 0, seenMilestones: [], at: Date.now() };
  }

  function load() {
    var raw;
    try { raw = localStorage.getItem(saveKey); } catch (e) { raw = null; }
    if (!raw) return freshState();
    try {
      var s = JSON.parse(raw);
      var base = freshState();
      Object.keys(base).forEach(function (k) { if (s[k] === undefined) s[k] = base[k]; });
      return s;
    } catch (e) {
      return freshState();
    }
  }

  function save() {
    state.at = Date.now();
    try { localStorage.setItem(saveKey, JSON.stringify(state)); } catch (e) { /* 保存できない環境でも遊べる */ }
  }

  /* ---------- 計算 ---------- */

  function prestigeBonus() {
    var p = cfg.prestige || {};
    if (!p.enabled) return 1;
    return 1 + (state.prestige || 0) * (p.bonusPerPoint || 0);
  }

  function multiplier(type) {
    var m = 1;
    (cfg.upgrades || []).forEach(function (u) {
      if (state.bought[u.id] && u.effect.type === type) m *= u.effect.value;
    });
    return m;
  }

  function tapValue() {
    return cfg.tapTarget.baseValue * multiplier('tapMultiplier') * prestigeBonus();
  }

  function ratePerSecond() {
    var total = 0;
    cfg.generators.forEach(function (g) { total += (state.owned[g.id] || 0) * g.baseRate; });
    return total * multiplier('rateMultiplier') * prestigeBonus();
  }

  function costOf(g) {
    return Math.ceil(g.baseCost * Math.pow(COST_GROWTH, state.owned[g.id] || 0));
  }

  function earn(amount) {
    state.currency += amount;
    state.earned += amount;
  }

  /* ---------- 演出 ---------- */

  function ticker(text) {
    var node = el('ticker');
    node.textContent = text;
    clearTimeout(tickerTimer);
    tickerTimer = setTimeout(function () { node.textContent = ''; }, 3200);
  }

  function checkMilestones() {
    (cfg.milestones || []).forEach(function (m, i) {
      var key = 'm' + i;
      if (state.earned >= m.at && state.seenMilestones.indexOf(key) < 0) {
        state.seenMilestones.push(key);
        ticker(m.text);
      }
    });
  }

  /* ---------- 描画 ---------- */

  function renderWallet() {
    var c = cfg.currency;
    el('currency-name').textContent = c.name;
    el('amount').textContent = (c.emoji ? c.emoji + ' ' : '') + fmt(state.currency) + (c.unit || '');
    el('rate').textContent = '毎秒 ' + fmt(ratePerSecond()) + (c.unit || '') + ' ／ 1タップ ' + fmt(tapValue()) + (c.unit || '');

    var p = cfg.prestige || {};
    var line = el('prestige-line');
    if (p.enabled && state.prestige > 0) {
      line.hidden = false;
      line.textContent = (p.emoji || '') + ' ' + p.currencyName + ' ' + fmt(state.prestige) +
        '（全収入 +' + Math.round((prestigeBonus() - 1) * 100) + '%）';
    } else {
      line.hidden = true;
    }
  }

  function row(opts) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'row' + (opts.bought ? ' bought' : '');
    b.disabled = !!opts.disabled;
    b.innerHTML =
      '<span class="ico"></span>' +
      '<span class="body"><span class="name"></span><span class="desc"></span></span>' +
      '<span class="side"><span class="cost"></span><span class="owned"></span></span>';
    b.querySelector('.ico').textContent = opts.emoji || '•';
    b.querySelector('.name').textContent = opts.name;
    b.querySelector('.desc').textContent = opts.desc || '';
    b.querySelector('.cost').textContent = opts.cost;
    b.querySelector('.owned').textContent = opts.owned || '';
    if (opts.onClick) b.addEventListener('click', opts.onClick);
    return b;
  }

  function renderGenerators() {
    var box = el('generators');
    box.textContent = '';
    var unit = cfg.currency.unit || '';
    cfg.generators.forEach(function (g) {
      var cost = costOf(g);
      var owned = state.owned[g.id] || 0;
      // まだ一度も買えていない、かつ手が届かないほど高いものは隠す。
      // 最初の画面に8個並ぶと、何をすればよいか分からなくなる。
      if (owned === 0 && state.earned < g.baseCost * 0.5) return;
      box.appendChild(row({
        emoji: g.emoji, name: g.name, desc: g.desc,
        cost: fmt(cost) + unit,
        owned: owned > 0 ? '所有 ' + owned : '',
        disabled: state.currency < cost,
        onClick: function () {
          var c = costOf(g);
          if (state.currency < c) return;
          state.currency -= c;
          state.owned[g.id] = (state.owned[g.id] || 0) + 1;
          renderAll();
          save();
        }
      }));
    });
    if (!box.children.length) {
      var p = document.createElement('p');
      p.className = 'desc';
      p.style.color = 'var(--muted)';
      p.style.fontSize = '13px';
      p.textContent = 'タップして ' + cfg.currency.name + ' を貯めると、ここに増やせるものが出てきます。';
      box.appendChild(p);
    }
  }

  function renderUpgrades() {
    var box = el('upgrades');
    box.textContent = '';
    var unit = cfg.currency.unit || '';
    var any = false;
    (cfg.upgrades || []).forEach(function (u) {
      var bought = !!state.bought[u.id];
      if (!bought && state.earned < u.cost * 0.4) return;
      any = true;
      box.appendChild(row({
        emoji: u.emoji, name: u.name, desc: u.desc,
        cost: bought ? '購入済み' : fmt(u.cost) + unit,
        bought: bought,
        disabled: bought || state.currency < u.cost,
        onClick: function () {
          if (state.bought[u.id] || state.currency < u.cost) return;
          state.currency -= u.cost;
          state.bought[u.id] = true;
          renderAll();
          save();
        }
      }));
    });
    if (!any) {
      var p = document.createElement('p');
      p.style.color = 'var(--muted)';
      p.style.fontSize = '13px';
      p.textContent = 'もう少し ' + cfg.currency.name + ' が貯まると、強化が出てきます。';
      box.appendChild(p);
    }
  }

  function renderPrestige() {
    var p = cfg.prestige || {};
    var box = el('prestige-box');
    if (!p.enabled || state.earned < p.unlockAt) { box.hidden = true; return; }
    box.hidden = false;
    var gain = gainablePrestige();
    el('prestige-title').textContent = (p.emoji || '') + ' ' + p.label;
    el('prestige-desc').textContent = p.description || '';
    var btn = el('prestige-btn');
    btn.textContent = p.label + 'する（' + p.currencyName + ' +' + fmt(gain) + '）';
    btn.disabled = gain < 1;
  }

  function gainablePrestige() {
    var p = cfg.prestige || {};
    if (!p.enabled || !p.unlockAt) return 0;
    return Math.floor(Math.sqrt(state.earned / p.unlockAt));
  }

  function renderCta() {
    var c = cfg.cta || {};
    var a = el('cta');
    if (!c.enabled || !c.url || state.earned < (c.showAfterCurrency || 0)) { a.hidden = true; return; }
    a.hidden = false;
    a.textContent = c.label || '詳しく見る';
    a.href = c.url;
    a.target = '_blank';
    a.rel = 'noopener';
  }

  function renderAll() {
    renderWallet();
    renderGenerators();
    renderUpgrades();
    renderPrestige();
    renderCta();
  }

  /* ---------- ループ ---------- */

  function tick() {
    var now = Date.now();
    var dt = Math.min((now - lastTick) / 1000, 5);
    lastTick = now;
    if (dt > 0) {
      earn(ratePerSecond() * dt);
      checkMilestones();
      renderWallet();
      renderGenerators();
      renderUpgrades();
      renderPrestige();
      renderCta();
    }
    if (now - lastSave > SAVE_MS) { save(); lastSave = now; }
  }

  function applyOffline() {
    var o = cfg.offline || {};
    if (!o.enabled || !state.at) return;
    var seconds = (Date.now() - state.at) / 1000;
    if (seconds < 60) return;
    var capped = Math.min(seconds, (o.maxHours || 8) * 3600);
    var gained = ratePerSecond() * capped * (o.rateFactor != null ? o.rateFactor : 0.5) * multiplier('offlineMultiplier');
    if (gained <= 0) return;
    earn(gained);
    ticker('留守のあいだに ' + fmt(gained) + (cfg.currency.unit || '') + ' 入りました。');
  }

  /* ---------- 起動 ---------- */

  function wire() {
    el('title').textContent = cfg.meta.title;
    el('tagline').textContent = cfg.meta.tagline || '';
    el('tap-emoji').textContent = cfg.tapTarget.emoji || '👆';
    el('tap-label').textContent = cfg.tapTarget.label || 'タップ';
    el('tap-hint').textContent = cfg.tapTarget.hint || '';

    var footer = el('footer-text');
    if ((cfg.footer || {}).url) {
      var a = document.createElement('a');
      a.href = cfg.footer.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = cfg.footer.text || '';
      footer.appendChild(a);
    } else {
      footer.textContent = (cfg.footer || {}).text || '';
    }

    el('tap').addEventListener('click', function () {
      earn(tapValue());
      checkMilestones();
      renderAll();
    });

    Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (btn) {
      btn.addEventListener('click', function () {
        Array.prototype.forEach.call(document.querySelectorAll('#tabs button'), function (b) {
          var on = b === btn;
          b.setAttribute('aria-selected', on ? 'true' : 'false');
          el(b.dataset.tab).hidden = !on;
        });
      });
    });

    el('prestige-btn').addEventListener('click', function () {
      var gain = gainablePrestige();
      if (gain < 1) return;
      if (!window.confirm(cfg.prestige.label + 'すると ' + cfg.currency.name +
          ' と所持しているものが無くなり、' + cfg.prestige.currencyName + ' が ' + gain + ' 増えます。よろしいですか?')) return;
      state.prestige = (state.prestige || 0) + gain;
      state.currency = 0;
      state.earned = 0;
      state.owned = {};
      state.bought = {};
      renderAll();
      save();
      ticker(cfg.prestige.label + 'しました。');
    });

    el('reset').addEventListener('click', function () {
      if (!window.confirm('すべての進行を消して最初からやり直します。よろしいですか?')) return;
      state = freshState();
      renderAll();
      save();
    });

    document.addEventListener('visibilitychange', function () {
      if (document.hidden) save(); else lastTick = Date.now();
    });
    window.addEventListener('pagehide', save);
  }

  function start(config) {
    cfg = validate(config);
    saveKey = 'idlekit:' + (cfg.meta.saveId || cfg.meta.title);
    state = load();
    applyTheme();
    wire();
    applyOffline();
    lastTick = Date.now();
    lastSave = Date.now();
    el('boot').hidden = true;
    el('app').hidden = false;
    renderAll();
    setInterval(tick, TICK_MS);
  }

  function boot() {
    // file:// で開かれた場合 fetch は使えない。その場合の案内を出す。
    fetch('brand.config.json', { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(start)
      .catch(function (e) {
        if (location.protocol === 'file:') {
          fail('ファイルを直接開くと設定を読み込めません（ブラウザの制限）。\n' +
               'フォルダの中で次を実行し、表示されたURLを開いてください:\n  python3 -m http.server 8000');
        } else {
          fail(String(e && e.message || e));
        }
      });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
