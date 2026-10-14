// ==UserScript==
// @name         BlueSales – помощник
// @namespace    bluesales-sounds
// @version      1.57.1
// @description  Звуки, избранные смайлики и поиск по ним, переключатель темы, таймер «клиент ждёт», черновики по чатам, поиск по быстрым фразам, предпросмотр чата без прочтения в мессенджере BlueSales.
// @match        https://bluesales.ru/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Misha-Burtsev/bluesales-tools/beta/bluesales-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Misha-Burtsev/bluesales-tools/beta/bluesales-helper.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------- Настройки ----------
  const VOLUME = 0.35;          // громкость 0..1
  const INCOMING_URL = '';      // ссылка на свой mp3 для входящих; пусто – встроенный мягкий «динь»
  const SENT_URL = '';          // ссылка на свой mp3 для отправки; пусто – встроенный короткий «пуф»
  const SENT_SOUND = true;      // false – без звука отправки

  // переключатели из панели в правом углу: bsMuteIn, bsMuteOut, bsEmoClosed ('1' – включён)
  const flag = k => { try { return localStorage.getItem(k) === '1'; } catch (e) { return false; } };
  // тема: класс bs-light на <html> выключает тёмную тему (стиль «BlueSales – тёмная тема» от 1.4.0)
  function applyTheme() {
    let light = false;
    try { light = localStorage.getItem('bsTheme') === 'light'; } catch (e) {}
    document.documentElement.classList.toggle('bs-light', light);
  }
  applyTheme();

  // ---------- Синтез звуков (без файлов) ----------
  let ctx;
  function ac() {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  function tone(freq, start, dur, type, vol) {
    const c = ac(), o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.value = freq;
    g.gain.setValueAtTime(0, c.currentTime + start);
    g.gain.linearRampToValueAtTime(vol * VOLUME, c.currentTime + start + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + start + dur);
    o.connect(g).connect(c.destination);
    o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
  }
  function playIncoming() {
    if (flag('bsMuteIn')) return;
    if (INCOMING_URL) return playFile(INCOMING_URL);
    tone(880, 0, 0.35, 'sine', 0.9);      // два мягких тона вверх
    tone(1320, 0.11, 0.45, 'sine', 0.7);
  }
  function playSent() {
    if (!SENT_SOUND || flag('bsMuteOut')) return;
    if (SENT_URL) return playFile(SENT_URL);
    const c = ac(), o = c.createOscillator(), g = c.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(520, c.currentTime);
    o.frequency.exponentialRampToValueAtTime(1100, c.currentTime + 0.12);
    g.gain.setValueAtTime(0.6 * VOLUME, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + 0.16);
    o.connect(g).connect(c.destination);
    o.start(); o.stop(c.currentTime + 0.18);
  }
  const NativeAudio = window.Audio;
  function playFile(url) {
    const a = new NativeAudio(url); a.volume = VOLUME; a.play().catch(() => {});
  }

  // ---------- Входящие: сайт играет new Audio("audio/notification.mp3") ----------
  window.Audio = function (src) {
    if (src && /notification\.mp3/.test(src)) return { play() { playIncoming(); return Promise.resolve(); }, pause() {} };
    return new NativeAudio(src);
  };
  window.Audio.prototype = NativeAudio.prototype;

  // ---------- Отправка: звук сразу при отправке, при ошибке – низкий сигнал ----------
  const failTone = () => { tone(330, 0, 0.18, 'triangle', 0.6); tone(220, 0.18, 0.3, 'triangle', 0.6); };
  let bsOwnCall = false;   // наш запрос через API сайта – не путать с открытием чата
  const send = XMLHttpRequest.prototype.send, open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) { this._bsUrl = String(url || ''); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const text = this._bsUrl + ' ' + (typeof body === 'string' ? body : '');
    if (/dialogs\.sendMessage/.test(text)) {
      const id = curDialog();
      playSent();
      this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) { onSent(id); tarSent(text); } else failTone(); });
      this.addEventListener('error', failTone);
    } else if (/dialogs\.getMessages/.test(this._bsUrl)) {
      // сайт открыл чат (из списка, левых напоминаний или по ссылке); свой предпросмотр не считаем
      const m = /"dialogId"\s*:\s*"?(\d+)/.exec(typeof body === 'string' ? body : '');
      if (m && !bsOwnCall && !/1970-01-01/.test(body)) onOpened(m[1]);
    } else if (/dialogs\.get(?!LastUpdated|Channels)/.test(this._bsUrl)) {
      this.addEventListener('load', () => { try { onDialogs(JSON.parse(this.responseText)); } catch (e) {} });
    }
    return send.apply(this, arguments);
  };
  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const body = init && typeof init.body === 'string' ? init.body : '';
    const p = nativeFetch.apply(this, arguments);
    if (/dialogs\.sendMessage/.test(url + ' ' + body)) { playSent(); p.then(r => { if (!r.ok) failTone(); else tarSent(url + ' ' + body); }).catch(failTone); }
    return p;
  };
  // ---------- Смайлики: избранное, поиск, сворачивание ----------
  // Клик – вставить, правый клик – добавить в избранное или убрать оттуда.
  const FAV_KEY = 'bsEmojiFav', NAMES_KEY = 'bsEmojiNames';
  const load = k => { try { return JSON.parse(localStorage.getItem(k)) || []; } catch (e) { return []; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  try { localStorage.removeItem('bsEmojiRecent'); } catch (e) {}   // «Недавние» больше не нужны

  function insertEmoji(em) {
    const ta = document.querySelector('textarea.send_message_textarea');
    if (!ta) return;
    const s = ta.selectionStart ?? ta.value.length, e = ta.selectionEnd ?? s;
    ta.value = ta.value.slice(0, s) + em + ta.value.slice(e);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = s + em.length;
    if (window.jQuery) window.jQuery(ta).trigger('input'); else ta.dispatchEvent(new Event('input', { bubbles: true }));
  }
  function toggleFav(em) {
    const f = load(FAV_KEY);
    const i = f.indexOf(em);
    if (i >= 0) f.splice(i, 1); else f.push(em);
    save(FAV_KEY, f);
  }

  function render() {
    const sel = document.querySelector('.emoji_selector');
    if (!sel) return;
    sel.querySelectorAll('.bs-own').forEach(n => n.remove());
    // «Самые популярные» прячем
    sel.querySelectorAll('.emoji_group_label').forEach(l => {
      if (/популярн/i.test(l.textContent)) { l.classList.add('bs-pop'); l.nextElementSibling?.classList.add('bs-pop'); }
    });
    const fav = load(FAV_KEY);
    if (fav.length) {
      const label = document.createElement('span');
      label.className = 'emoji_group_label bs-own';
      label.textContent = 'Избранное';
      const box = document.createElement('div');
      box.className = 'emoji_group bs-own';
      for (const em of fav) {
        const sp = document.createElement('span');
        sp.className = 'emoji bs-emoji';
        sp.textContent = em;
        box.appendChild(sp);
      }
      sel.prepend(label, box);
    }
    paintFavBar();
    emoFilter();
  }
  // первые 5 избранных – в плашке, когда смайлики свёрнуты
  function paintFavBar() {
    const b = document.getElementById('bsEmoFav');
    if (!b) return;
    b.innerHTML = '';
    load(FAV_KEY).slice(0, 5).forEach(em => {
      const sp = document.createElement('span');
      sp.textContent = em;
      b.appendChild(sp);
    });
  }

  // клики по смайликам – в фазе перехвата, чтобы видеть и родные, и наши
  // mousedown не даёт фокусу уйти из поля ввода – после смайлика можно сразу печатать дальше
  document.addEventListener('mousedown', ev => {
    if (ev.target.closest && ev.target.closest('.emoji_selector .emoji')) ev.preventDefault();
  }, true);
  document.addEventListener('click', ev => {
    const sp = ev.target.closest && ev.target.closest('.emoji_selector .emoji');
    if (!sp) return;
    if (sp.classList.contains('bs-emoji')) insertEmoji(sp.textContent); // родные вставляет сам сайт
    else setTimeout(() => {
      const ta = document.querySelector('textarea.send_message_textarea');
      if (ta && document.activeElement !== ta) { const p = ta.selectionStart; ta.focus(); ta.selectionStart = ta.selectionEnd = p; }
    }, 0);
  }, true);
  document.addEventListener('contextmenu', ev => {
    const sp = ev.target.closest && ev.target.closest('.emoji_selector .emoji');
    if (!sp) return;
    ev.preventDefault();
    toggleFav(sp.textContent);
    render();
  }, true);

  // ---------- Поиск смайлика ----------
  // Русские названия и теги – из emojibase (загружаются один раз и хранятся в localStorage).
  let names = null;
  const strip = s => s.replace(/️/g, '');
  async function loadNames() {
    if (names) return names;
    try { names = JSON.parse(localStorage.getItem(NAMES_KEY)); } catch (e) {}
    if (names) return names;
    try {
      const d = await (await fetch('https://cdn.jsdelivr.net/npm/emojibase-data@16/ru/compact.json')).json();
      const all = {};
      d.forEach(x => { all[strip(x.unicode)] = (x.label + ' ' + (x.tags || []).join(' ')).toLowerCase().replace(/ё/g, 'е'); });
      names = {};
      document.querySelectorAll('.emoji_selector .emoji').forEach(e => {
        const k = strip(e.textContent);
        if (all[k]) names[k] = all[k];
      });
      save(NAMES_KEY, names);
    } catch (e) { names = {}; }
    return names;
  }
  function emoFilter() {
    const sel = document.querySelector('.emoji_selector'), inp = document.getElementById('bsEmoSearch');
    if (!sel) return;
    const q = inp ? inp.value.trim().toLowerCase().replace(/ё/g, 'е') : '';
    sel.querySelectorAll('.emoji_group').forEach(g => {
      let n = 0;
      g.querySelectorAll('.emoji').forEach(e => {
        const ok = !q || ((names && names[strip(e.textContent)]) || '').includes(q);
        e.classList.toggle('bs-hide', !ok);
        if (ok) n++;
      });
      g.classList.toggle('bs-hide', !!q && !n);
      const l = g.previousElementSibling;
      if (l && l.classList.contains('emoji_group_label')) l.classList.toggle('bs-hide', !!q && !n);
    });
    sel.scrollTop = 0;
  }

  // ---------- Панель в правом нижнем углу: поиск, тема, звуки, свернуть ----------
  const ICON = {
    moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0"/>',
    send: '<path d="M22 2 11 13"/><path d="M22 2 15 22l-4-9-9-4z"/>',
    down: '<path d="m6 9 6 6 6-6"/>',
    up: '<path d="m18 15-6-6-6 6"/>',
  };
  const svg = p => '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + p + '</svg>';
  function btn(id, title) {
    const b = document.createElement('button');
    b.type = 'button'; b.id = id; b.title = title; b.className = 'bs-dock-btn';
    return b;
  }
  function paintDock() {
    const closed = flag('bsEmoClosed');
    document.body.classList.toggle('bs-emo-closed', closed);
    const light = localStorage.getItem('bsTheme') === 'light';
    const t = document.getElementById('bsThemeBtn');
    if (!t) return;
    t.innerHTML = svg(light ? ICON.moon : ICON.sun);
    t.title = light ? 'Тёмная тема' : 'Светлая тема';
    const snd = document.getElementById('bsSndBtn');
    snd.innerHTML = svg(ICON.bell); snd.title = 'Звуки';
    snd.classList.toggle('bs-off', flag('bsMuteIn') && flag('bsMuteOut'));
    const menu = document.getElementById('bsSndMenu');
    if (menu) menu.querySelectorAll('[data-k]').forEach(r => r.classList.toggle('bs-on', !flag(r.dataset.k)));
    const c = document.getElementById('bsEmoToggle');
    c.innerHTML = svg(closed ? ICON.up : ICON.down);
    c.title = closed ? 'Показать смайлики' : 'Свернуть смайлики';
  }
  function flip(key) { try { localStorage.setItem(key, flag(key) ? '0' : '1'); } catch (e) {} paintDock(); }

  function dockInit() {
    if (document.getElementById('bsDock')) return;
    const dock = document.createElement('div');
    dock.id = 'bsDock';
    const inp = document.createElement('input');
    inp.id = 'bsEmoSearch'; inp.type = 'search'; inp.placeholder = 'Поиск'; inp.autocomplete = 'off';
    inp.addEventListener('focus', () => loadNames().then(emoFilter));
    inp.addEventListener('input', () => loadNames().then(emoFilter));
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; emoFilter(); } });
    const label = document.createElement('span');
    label.id = 'bsEmoLabel'; label.textContent = 'Смайлики';
    label.addEventListener('click', () => flip('bsEmoClosed'));
    const favBar = document.createElement('span');
    favBar.id = 'bsEmoFav';
    favBar.addEventListener('mousedown', ev => ev.preventDefault());
    favBar.addEventListener('click', ev => { if (ev.target.parentNode === favBar) insertEmoji(ev.target.textContent); });
    const theme = btn('bsThemeBtn', '');
    theme.addEventListener('click', () => {
      const light = localStorage.getItem('bsTheme') !== 'light';
      try { localStorage.setItem('bsTheme', light ? 'light' : 'dark'); } catch (e) {}
      applyTheme(); paintDock();
    });
    // звуки входящих и отправки – одна кнопка с выпадающим списком
    const snd = btn('bsSndBtn', ''), tog = btn('bsEmoToggle', '');
    const closeSnd = () => { const m = document.getElementById('bsSndMenu'); if (m) m.remove(); };
    snd.addEventListener('click', () => {
      if (document.getElementById('bsSndMenu')) return closeSnd();
      const m = document.createElement('div');
      m.id = 'bsSndMenu';
      m.innerHTML = '<div data-k="bsMuteIn">' + svg(ICON.bell) + '<span>Звук входящих</span><i></i></div>' +
        '<div data-k="bsMuteOut">' + svg(ICON.send) + '<span>Звук отправки</span><i></i></div>';
      m.addEventListener('click', ev => {
        const r = ev.target.closest('[data-k]');
        if (!r) return;
        flip(r.dataset.k);
        if (!flag(r.dataset.k)) (r.dataset.k === 'bsMuteIn' ? playIncoming : playSent)();
      });
      document.body.appendChild(m);
      paintDock();
    });
    document.addEventListener('mousedown', ev => { if (!ev.target.closest('#bsSndMenu,#bsSndBtn')) closeSnd(); }, true);
    tog.addEventListener('click', () => flip('bsEmoClosed'));
    dock.append(theme, snd);
    // поиск смайликов / «Смайлики ▴» – своя плашка между ссылками и кнопками
    const bar = document.createElement('div');
    bar.id = 'bsEmoBar';
    bar.append(inp, favBar, label);
    // кнопка сворачивания – в правом верхнем углу панели смайликов (ставит placeLinks); свёрнутые открываются по «Смайлики» в панели
    document.body.append(dock, bar, tog);

    const st = document.createElement('style');
    st.textContent = [
      '#bsDock{display:none;position:fixed;right:12px;bottom:12px;width:230px;box-sizing:border-box;height:36px;align-items:center;gap:2px;padding:0 4px 0 6px;',
      'background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);border-radius:12px;z-index:2001;font-size:12.5px;color:var(--bs-text,#222)}',
      'body.slide-panel-right-open #bsDock{display:flex}',
      '#bsDock{justify-content:space-around;padding:0 6px}',
      '#bsEmoBar{display:none;position:fixed;right:12px;bottom:54px;width:230px;box-sizing:border-box;height:36px;align-items:center;padding:0 6px;',
      'background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);border-radius:12px;z-index:2001;font-size:12.5px;color:var(--bs-text,#222)}',
      'body.slide-panel-right-open.bs-can-send #bsEmoBar{display:flex}',
      '#bsEmoSearch{flex:1;min-width:0;height:24px;padding:0 8px;border:1px solid var(--bs-border,#D9E0E7)!important;border-radius:7px;background:var(--bs-hover,#f3f4f6)!important;color:var(--bs-text,#222)!important;font-size:12px;outline:none}',
      '#bsEmoSearch:focus{border-color:var(--bs-accent,#3b82f6)!important}',
      '#bsEmoLabel{display:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:var(--bs-muted,#888);font-size:12.5px;padding-left:6px}',
      'body.bs-emo-closed #bsEmoSearch{display:none}',
      'body.bs-emo-closed #bsEmoLabel{display:block}',
      '#bsEmoFav{display:none;flex:none;gap:1px}',
      'body.bs-emo-closed #bsEmoFav{display:flex}',
      '#bsEmoFav span{width:26px;height:26px;display:flex;align-items:center;justify-content:center;border-radius:7px;font-size:17px;cursor:pointer}',
      '#bsEmoFav span:hover{background:var(--bs-hover,#f3f4f6)}',
      'body.bs-emo-closed #bsEmoFav:not(:empty)+#bsEmoLabel{text-align:right;padding:0 4px 0 0}',
      '#bsEmoToggle{position:fixed;z-index:2002;display:none;height:34px;justify-content:flex-end;padding:6px 12px 0 0;outline:none!important;box-shadow:none!important;border:0!important;box-sizing:border-box;border-radius:11px 11px 0 0;background:none!important}',
      '#bsEmoToggle:hover{color:var(--bs-text,#222)}',
      '#bsEmoToggle:focus,#bsEmoToggle:focus-visible,#bsEmoToggle:active{outline:none!important;box-shadow:none!important}',
      '#bsEmoLabel::after{content:" ▴";font-size:10px}',
      '.bs-dock-btn{flex:none;width:26px;height:26px;display:flex;align-items:center;justify-content:center;padding:0;border:0;border-radius:7px;background:none;color:var(--bs-muted,#888);cursor:pointer;position:relative}',
      '.bs-dock-btn:hover{background:var(--bs-hover,#f3f4f6);color:var(--bs-text,#222)}',
      '.bs-dock-btn.bs-off{opacity:.45}',
      '.bs-dock-btn.bs-off::after{content:"";position:absolute;left:5px;right:5px;top:50%;border-top:2px solid currentColor;transform:rotate(-45deg)}',
      '#bsSndMenu{position:fixed;right:12px;bottom:54px;z-index:3001;width:200px;padding:4px;box-sizing:border-box;border-radius:10px;background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 6px 24px rgba(0,0,0,.18);font-size:13px;color:var(--bs-text,#222)}',
      '#bsSndMenu div{display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:7px;cursor:pointer}',
      '#bsSndMenu div:hover{background:var(--bs-hover,#f3f4f6)}',
      '#bsSndMenu span{flex:1}',
      '#bsSndMenu i{width:26px;height:15px;border-radius:8px;background:var(--bs-border,#D9E0E7);position:relative;flex:none}',
      '#bsSndMenu i::after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:left .15s}',
      '#bsSndMenu .bs-on i{background:var(--bs-accent,#3b82f6)}',
      '#bsSndMenu .bs-on i::after{left:13px}',
      'html:root body.slide-panel-right-open .send_message_box .emoji_selector{bottom:96px!important}',
      'html:root body.bs-emo-closed .send_message_box .emoji_selector{display:none!important}',
      'html:root body .emoji_selector .bs-pop,html:root body .emoji_selector .bs-hide{display:none!important}',
    ].join('');
    document.head.appendChild(st);
    paintDock(); paintFavBar();
  }

  // .emoji_selector создаётся скриптом сайта – ждём его появления
  const waitSel = new MutationObserver(() => {
    if (document.querySelector('.emoji_selector .emoji_group')) { waitSel.disconnect(); render(); }
  });
  document.addEventListener('DOMContentLoaded', () => {
    dockInit();
    if (document.querySelector('.emoji_selector .emoji_group')) render();
    else waitSel.observe(document.body, { childList: true, subtree: true });
  });

  // ---------- Каждое сообщение – отдельно, со своим временем ----------
  // Сайт склеивает сообщения одного автора за 3 минуты в один блок со временем первого.
  // Подменяем у его сборщика порог на -1 – тогда каждый блок из одного сообщения.
  function unstackInit() {
    const m = window.messenger, B = m && m.messagesViewBuilder;
    if (!B || B.bsPatched) return !!B;
    const W = function (opts) { return B.call(this, Object.assign({}, opts, { maxSecondsBetweenMessagesInBlock: -1 })); };
    W.prototype = B.prototype; W.bsPatched = true;
    m.messagesViewBuilder = W;
    return true;
  }
  document.addEventListener('DOMContentLoaded', () => {
    if (unstackInit()) return;
    let n = 0;
    const iv = setInterval(() => { if (unstackInit() || ++n > 40) clearInterval(iv); }, 250);
  });

  // ---------- Таймер «клиент ждёт» в списке чатов ----------
  // Данные берём из ответа dialogs.get, который сайт и так запрашивает: кто написал последним и когда.
  const dlg = {};   // id диалога → { at: время последнего сообщения клиента (мс) или 0, если ждать некого; bot: за нас ответил бот }
  // автоответы бота – сайт считает чат отвеченным, а клиент на самом деле ждёт куратора
  const BOT_RE = /^\s*(?:Вы:\s*)?Отлично!\s*Куратор скоро подключится/i;
  let tzOffset = '+03:00';
  function onDialogs(json) {
    if (!json || !Array.isArray(json.response)) return;
    const m = /([+-]\d\d:\d\d)$/.exec(json.serverDate || '');
    if (m) tzOffset = m[1];
    for (const d of json.response) {
      if (!d || !d.id) continue;
      // тип 10 – «Пользователь запретил присылать сообщения»: ждать некого
      const blocked = d.latestMessageType === 10;
      const bot = !blocked && d.latestMessageUserId !== d.customerUserId && BOT_RE.test(d.latestMessage || '');
      const waiting = !blocked && (bot || (d.latestMessageUserId === d.customerUserId && !d.isAnswered)) && d.latestMessageDate;
      dlg[d.id] = { at: waiting ? Date.parse(d.latestMessageDate + tzOffset) : 0, bot };
    }
    paintWait();
  }
  function waitText(min) {
    if (min < 1) return 'сейчас';
    if (min < 60) return min + ' мин';
    if (min < 1440) return Math.floor(min / 60) + ' ч' + (min % 60 ? ' ' + (min % 60) + ' мин' : '');
    return Math.floor(min / 1440) + ' д';
  }
  // время из списка: «15:50:29» – сегодня; иначе даты не знаем
  function listTime(el) {
    const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec((el.lastChild && el.lastChild.textContent) || el.textContent);
    if (!m) return Date.now();
    const d = new Date(); d.setHours(+m[1], +m[2], +(m[3] || 0), 0);
    return Math.min(d.getTime(), Date.now());
  }
  function paintWait() {
    const now = Date.now();
    document.querySelectorAll('.dialogs_list_item[data-dialog-id]').forEach(it => {
      let info = dlg[it.dataset.dialogId];
      const time = it.querySelector('.dialogs_list_time');
      if (!time) return;
      const prev = it.querySelector('.dialogs_list_preview:not(.bs-draft)'), ptxt = prev ? prev.textContent : '';
      // заблокировал после нашего ответа – превью свежее данных dialogs.get
      const crm = it.querySelector('.crm-status-name, .crm_status');
      if (/запретил присылать/.test(ptxt) || (crm && /^\s*блок/i.test(crm.textContent))) info = null;
      // новые чаты сайт добавляет без dialogs.get – тогда бота узнаём по превью «Вы: Отлично! Куратор…»
      else if ((!info || !info.at) && BOT_RE.test(ptxt)) info = { at: listTime(time), bot: true };
      const isBot = !!(info && info.at && info.bot);
      if (it.classList.contains('bs-botchat') !== isBot) it.classList.toggle('bs-botchat', isBot);
      let b = time.querySelector('.bs-wait');
      if (!info || !info.at) { if (b) b.remove(); return; }
      const min = Math.max(0, Math.floor((now - info.at) / 60000));
      if (!b) { b = document.createElement('span'); b.className = 'bs-wait'; time.prepend(b); }
      const txt = (info.bot ? '🤖 ' : '') + waitText(min), lvl = min >= 1440 ? 'old' : min >= 60 ? 'red' : min >= 10 ? 'amber' : 'new';
      if (b.textContent !== txt) b.textContent = txt;
      if (b.dataset.lvl !== lvl) b.dataset.lvl = lvl;
      b.title = info.bot ? 'Ответил только бот – клиент ждёт куратора' : 'Клиент ждёт ответа';
    });
    paintBotBtn();
  }
  function waitInit() {
    const st = document.createElement('style');
    st.textContent =
      '.dialogs_list_time .bs-wait{display:inline-block;margin-right:5px;padding:0 5px;border-radius:5px;font-size:10.5px;line-height:15px;font-weight:600;vertical-align:1px}' +
      '.bs-wait[data-lvl="new"]{background:rgba(52,168,83,.15);color:#2e9d4f}' +
      '.bs-wait[data-lvl="amber"]{background:rgba(245,158,11,.18);color:#d48806}' +
      '.bs-wait[data-lvl="red"]{background:rgba(229,62,62,.16);color:#e04848}' +
      '.bs-wait[data-lvl="old"]{background:var(--bs-hover,#f1f1f1);color:var(--bs-muted,#888)}';
    document.head.appendChild(st);
    // список перерисовывается сайтом – возвращаем плашки; раз в 30 секунд обновляем минуты
    let t = 0;
    const OWN = '#bsDock,#bsEmoBar,#bsRemList,#bsLinks,#bsToasts,#bsMenu,#bsRepWrap,#bsHome,#bsSndMenu,#bsEmoToggle,#bsPeek,#bsSold,#bsShift,#bsTarWrap,#bsTarHint,#bsSaleWrap,#bsTip,#bsSelPop,#bsAc';
    const own = r => r.target.nodeType === 1 && r.target.closest(OWN);
    new MutationObserver(recs => {
      if (recs.every(own)) return;
      if (!t) t = setTimeout(() => { t = 0; paintWait(); paintDrafts(); paintMarks(); paintSeries(); }, 150);
    })
      .observe(document.body, { childList: true, subtree: true });
    setInterval(paintWait, 30000);
  }
  // ---------- Капсула канала кликабельна целиком, а не только название ----------
  document.addEventListener('click', ev => {
    const tab = ev.target.closest && ev.target.closest('.channel-tab');
    if (!tab || ev.target.closest('a, .cogwheel')) return;
    const a = tab.querySelector('a');
    if (a) a.click();
  });
  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent = '.channel-tab{cursor:pointer}';
    document.head.appendChild(st);
  });

  // ---------- Серии: подряд от одного автора за 3 минуты – имя и аватар только у первого ----------
  const msgMin = b => { const m = /(\d{1,2}):(\d{2})/.exec((b.querySelector('.message_time') || {}).textContent || ''); return m ? m[1] * 60 + +m[2] : null; };
  const msgWho = b => {
    const a = b.querySelector(':scope > .icon_link'), snd = b.querySelector('.message_sender');
    return (a ? a.getAttribute('href') || a.textContent : '') + '|' + (snd ? snd.textContent.trim() : '');
  };
  function paintSeries() {
    const box = document.querySelector('.dialog_messages');
    if (!box) return;
    if (!document.getElementById('bsSeriesCss')) {
      const st = document.createElement('style');
      st.id = 'bsSeriesCss';
      st.textContent =
        '.message_block.bs-cont{margin-top:-5px!important}' +
        '.message_block.bs-cont>.icon_link{visibility:hidden!important;height:0!important;overflow:hidden!important}' +
        '.message_block.bs-cont .message>.person_name,.message_block.bs-cont .message>.message_sender{display:none!important}';
      document.head.appendChild(st);
    }
    for (const b of box.querySelectorAll(':scope > .message_block, :scope > * > .message_block')) {
      const p = b.previousElementSibling;
      let cont = false;
      if (p && p.classList.contains('message_block') && msgWho(p) === msgWho(b)) {
        const a = msgMin(p), c = msgMin(b);
        cont = a !== null && c !== null && c - a >= 0 && c - a <= 3;
      }
      if (b.classList.contains('bs-cont') !== cont) b.classList.toggle('bs-cont', cont);
    }
  }
  // мы ответили – этот чат больше не ждёт
  function markAnswered(id) { if (id && dlg[id]) { dlg[id].at = 0; paintWait(); } }

  // ---------- Черновики: у каждого чата свой недописанный текст ----------
  const DRAFT_KEY = 'bsDrafts', DRAFT_DAYS = 7;
  const curDialog = () => {
    const a = document.querySelector('.dialogs_list_item.active');
    return (a && a.dataset.dialogId) || new URLSearchParams(location.search).get('dialogId') || '';
  };
  function drafts() {
    const all = (() => { try { return JSON.parse(localStorage.getItem(DRAFT_KEY)) || {}; } catch (e) { return {}; } })();
    const old = Date.now() - DRAFT_DAYS * 864e5;
    for (const k in all) if (all[k].ts < old) delete all[k];
    return all;
  }
  function saveDraft(id, text) {
    if (!id) return;
    const all = drafts();
    if (text.trim()) all[id] = { t: text, ts: Date.now() }; else delete all[id];
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(all)); } catch (e) {}
    paintDrafts();
  }
  // в списке чатов вместо последнего сообщения – «Черновик: текст» (кроме открытого чата)
  function paintDrafts() {
    const all = drafts(), open = curDialog();
    document.querySelectorAll('.dialogs_list_item[data-dialog-id]').forEach(it => {
      const id = it.dataset.dialogId, d = id !== open && all[id];
      const prev = it.querySelector('.dialogs_list_preview');
      let box = it.querySelector('.bs-draft');
      it.classList.toggle('bs-has-draft', !!d);
      if (!d) { if (box) box.remove(); return; }
      if (!prev) return;
      if (!box) {
        box = document.createElement('div');
        box.className = 'bs-draft';
        box.innerHTML = '<b>Черновик: </b><span></span>';
        prev.after(box);
      }
      const txt = d.t.replace(/\s+/g, ' ').trim();
      if (!box.firstChild || box.firstChild.tagName !== 'B') box.innerHTML = '<b>Черновик: </b><span></span>';
      if (box.lastChild.textContent !== txt) box.lastChild.textContent = txt;
      if (box.previousElementSibling !== prev) prev.after(box);
    });
  }
  let shownDialog = null, shownTa = null;
  function draftTick() {
    const ta = document.querySelector('textarea.send_message_textarea');
    const id = curDialog();
    if (!ta || !id) return;
    if (id === shownDialog && ta === shownTa) return;
    // открылся другой чат (или сайт пересоздал поле) – ставим его черновик
    shownDialog = id; shownTa = ta;
    paintDrafts();
    const d = drafts()[id], text = d ? d.t : '';
    if (ta.value !== text) {
      ta.value = text;
      if (window.jQuery) window.jQuery(ta).trigger('input'); else ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  function draftInit() {
    const st = document.createElement('style');
    st.textContent =
      '.bs-has-draft .dialogs_list_preview:not(.bs-draft){display:none!important}' +
      '.bs-draft{display:block!important;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:1.3;color:var(--bs-muted,#888);grid-column:1/-1}' +
      '.bs-draft b{color:#e04848;font-weight:600}';
    document.head.appendChild(st);
    document.addEventListener('input', ev => {
      if (ev.target.matches && ev.target.matches('textarea.send_message_textarea') && curDialog() === shownDialog) saveDraft(shownDialog, ev.target.value);
    }, true);
    setInterval(draftTick, 250);
  }
  // сообщение ушло – черновик этого чата больше не нужен
  function onSent(id) { if (id) saveDraft(id, ''); markAnswered(id); }

  document.addEventListener('DOMContentLoaded', () => { waitInit(); draftInit(); });

  // ---------- Закреплённые чаты и напоминания (правый клик по чату в списке) ----------
  const PIN_KEY = 'bsPinned', REM_KEY = 'bsRemind';
  const jget = (k, def) => { try { return JSON.parse(localStorage.getItem(k)) || def; } catch (e) { return def; } };
  const jset = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const PIN_META = 'bsPinMeta';   // {id: {name, sid}} – чтобы закреплённый чат был виден и открывался, даже если его нет в списке
  const realById = id => document.querySelector('.dialogs_list_item[data-dialog-id="' + id + '"]:not(.bs-ghost)');
  const itemById = id => realById(id) || document.querySelector('.bs-ghost[data-dialog-id="' + id + '"]');
  const reqName = () => ((document.querySelector('.dialog_header .person_name') || {}).textContent || '').trim();
  // открыть чат, которого нет в списке: как левые напоминания сайта – по socialId, без перезагрузки
  function openBySid(id, sid) {
    const link = sid && document.querySelector('#remindersContentInner a.openDialogLink[data-social-id="' + sid + '"]');
    if (link) return link.click();
    if (sid) return window.postMessage({ type: 'openDialog', socialId: sid, alertIfDialogNotFound: true }, '*');
    location.assign(location.origin + '/app/Messenger/?dialogId=' + encodeURIComponent(id));
  }
  // чат есть в списке – кликаем; нет – открываем по socialId или по ссылке
  function openChat(id) {
    const it = realById(id);
    if (!it) {
      const meta = jget(PIN_META, {})[id] || {}, r = jget(REM_KEY, {})[id] || {}, g = itemById(id);
      return openBySid(id, meta.sid || r.sid || (g && g.dataset.socialId));
    }
    (it.querySelector('.dialogs_list_item_content') || it).click();
    setTimeout(() => markActive(id), 300);
  }
  // сайт не всегда выделяет чат, открытый не кликом по списку, – выделяем сами и прокручиваем к нему
  function markActive(id) {
    const it = itemById(id);
    if (!it) return false;
    if (!it.classList.contains('active')) {
      document.querySelectorAll('.dialogs_list_item.active').forEach(e => e.classList.remove('active'));
      it.classList.add('active');
    }
    it.scrollIntoView({ block: 'nearest' });
    return true;
  }
  // Чаты, которых нет в загруженном списке, показываем строками-заглушками сверху:
  // открытый из левых напоминаний (чтобы было видно, какой открыт, и продажа ушла в нужный) и закреплённые.
  let openedId = '', opened = {};   // opened: {at, head – шапка до открытия, name, sid}
  let remClick = null;              // последний клик по левым напоминаниям: {sid, name, at}
  const seen = {};                  // имена чатов, уже открывавшихся в этой вкладке
  document.addEventListener('click', ev => {
    const a = ev.target.closest && ev.target.closest('#remindersContentInner a.openDialogLink');
    if (a) { remClick = { sid: a.dataset.socialId || '', name: a.textContent.trim(), at: Date.now() }; return; }
    // клик по настоящей строке – заглушка больше не открытый чат
    const it = ev.target.closest && ev.target.closest('.dialogs_list_item[data-dialog-id]:not(.bs-ghost)');
    if (it) { openedId = it.dataset.dialogId; opened = {}; document.querySelectorAll('.bs-ghost.active').forEach(g => g.classList.remove('active')); }
  }, true);
  function onOpened(id) {
    id = String(id);
    const rc = remClick && Date.now() - remClick.at < 5000 ? remClick : null;
    remClick = null;
    openedId = id;
    opened = { at: Date.now(), head: reqName(), name: rc ? rc.name : '', sid: rc ? rc.sid : '' };
    setTimeout(() => { renderGhosts(); if (realById(id)) markActive(id); }, 300);
  }
  function ghostName(id, meta) {
    if (id === openedId) {
      // шапка обновляется не сразу после запроса – пока она старая, ей не верим
      const h = reqName();
      if (h && (h !== opened.head || Date.now() - opened.at > 3000)) opened.name = h;
      if (opened.name) return (seen[id] = opened.name);
    }
    return seen[id] || (meta && meta.name) || (jget(REM_KEY, {})[id] || {}).name || 'Чат';
  }
  // сменили канал или закрыли чат – справа «Выберите диалог…», заглушка открытого чата больше не нужна
  function dialogClosed() {
    const h = document.querySelector('.dialog_header .person_name');
    if (!h || !h.offsetParent || !h.textContent.trim()) return true;
    const e = document.evaluate("//*[normalize-space(text())='Выберите диалог, чтобы увидеть сообщения']", document, null, 9, null).singleNodeValue;
    return !!(e && e.offsetParent);
  }
  function renderGhosts() {
    const list = document.querySelector('.dialogs_list');
    if (!list) return;
    // сразу после открытия шапка может быть ещё не готова – даём сайту 5 секунд
    if (openedId && Date.now() - (opened.at || 0) > 5000 && dialogClosed()) { openedId = ''; opened = {}; }
    const pins = jget(PIN_KEY, []), meta = jget(PIN_META, {});
    const want = pins.filter(id => !realById(id));
    if (openedId && !realById(openedId) && !want.includes(openedId)) want.unshift(openedId);
    list.querySelectorAll('.bs-ghost').forEach(g => { if (!want.includes(g.dataset.dialogId)) g.remove(); });
    let metaChanged = false;
    want.forEach(id => {
      let g = list.querySelector('.bs-ghost[data-dialog-id="' + id + '"]');
      if (!g) {
        g = document.createElement('div');
        g.className = 'dialogs_list_item bs-ghost';
        g.dataset.dialogId = id;
        g.innerHTML = '<div class="dialogs_list_item_content"><div class="dialogs_list_summary"><div class="dialogs_list_person_name_and_post"><span class="dialogs_list_person_name"></span></div><div class="dialogs_list_preview"></div></div></div>';
        // у заглушки нет данных сайта – клик ему не отдаём, открываем сами
        g.addEventListener('click', ev => {
          ev.stopPropagation();
          if (g.dataset.dialogId !== openedId || !g.classList.contains('active')) openChat(g.dataset.dialogId);
        });
        // новая – сразу после закреплённых (их порядок ставит paintMarks)
        const after = [...list.children].filter(c => c.matches('.dialogs_list_item[data-dialog-id]') && pins.includes(c.dataset.dialogId)).pop();
        if (after) after.after(g); else { list.prepend(g); list.scrollTop = 0; }
      }
      const pinned = pins.includes(id), m = meta[id] || {};
      const nm = ghostName(id, m), sid = (id === openedId && opened.sid) || m.sid || '';
      const el = g.querySelector('.dialogs_list_person_name'), pv = g.querySelector('.dialogs_list_preview');
      const note = pinned ? 'Закреплён, в списке не загружен' : 'Открыт из напоминаний, в списке не загружен';
      if (el.textContent !== nm) el.textContent = nm;
      if (pv.textContent !== note) pv.textContent = note;
      if (sid && g.dataset.socialId !== sid) g.dataset.socialId = sid;
      if (pinned && nm !== 'Чат' && (m.name !== nm || (sid && m.sid !== sid))) { meta[id] = { name: nm, sid: sid || m.sid || '' }; metaChanged = true; }
      if (id === openedId && !g.classList.contains('active') && !document.querySelector('.dialogs_list_item.active:not(.bs-ghost)[data-dialog-id="' + openedId + '"]')) {
        document.querySelectorAll('.dialogs_list_item.active').forEach(e => e.classList.remove('active'));
        g.classList.add('active');
      }
      if (id !== openedId && g.classList.contains('active')) g.classList.remove('active');
    });
    if (metaChanged) jset(PIN_META, meta);
  }
  // сайт перерисовывает список (фильтры, обновление) – заглушки возвращаем, имя из шапки подтягиваем
  setInterval(renderGhosts, 1000);
  // открыли страницу по ссылке ?dialogId= – ждём, пока подгрузится список, и выделяем этот чат
  (() => {
    const id = new URLSearchParams(location.search).get('dialogId');
    if (!id) return;
    let n = 0;
    const t = setInterval(() => { if (document.querySelector('.dialogs_list_item.active') || markActive(id) || ++n > 40) clearInterval(t); }, 500);
  })();
  const nameOf = it => { const n = it && it.querySelector('.dialogs_list_person_name'); return n ? n.textContent.trim() : ''; };

  function togglePin(id) {
    const p = jget(PIN_KEY, []), i = p.indexOf(id);
    const meta = jget(PIN_META, {}), it = itemById(id);
    if (i >= 0) { p.splice(i, 1); delete meta[id]; }
    else { p.push(id); meta[id] = { name: nameOf(it) || (meta[id] && meta[id].name) || '', sid: (it && it.dataset.socialId) || '' }; }
    jset(PIN_META, meta); jset(PIN_KEY, p); paintMarks();
  }
  function setRemind(id, hours, note) {
    const r = jget(REM_KEY, {});
    if (hours > 0) r[id] = { at: Date.now() + Math.round(hours * 3600e3), name: nameOf(itemById(id)) || (r[id] && r[id].name) || '', note: (note || '').trim(), sid: (itemById(id) || { dataset: {} }).dataset.socialId || (r[id] && r[id].sid) || '' };
    else delete r[id];
    jset(REM_KEY, r); paintMarks();
  }
  function remText(ms) {
    const min = Math.ceil(ms / 60000);
    return min < 60 ? min + ' мин' : Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
  }
  // значки 📌 и ⏰ у имени + закреплённые наверх списка
  function paintMarks() {
    renderGhosts();
    const pins = jget(PIN_KEY, []), rem = jget(REM_KEY, {}), now = Date.now(), open = curDialog();
    // открыли чат после срабатывания – напоминание выполнено
    if (open && rem[open] && rem[open].fired) { delete rem[open]; jset(REM_KEY, rem); }
    document.querySelectorAll('.dialogs_list_item[data-dialog-id]').forEach(it => {
      const id = it.dataset.dialogId, row = it.querySelector('.dialogs_list_person_name_and_post');
      if (!row) return;
      let box = row.querySelector('.bs-marks');
      const r = rem[id], pin = pins.includes(id);
      let html = '';
      if (pin) html += '<span class="bs-pin" title="Закреплён">📌</span>';
      if (r) html += r.at <= now ? '<span class="bs-rem bs-due" title="Пора вернуться к клиенту">⏰ пора</span>'
        : '<span class="bs-rem" title="Напоминание">⏰ ' + remText(r.at - now) + '</span>';
      if (r && r.note) html = html.replace(/title="[^"]*"(?=>⏰)/, 'title="' + r.note.replace(/[&"<>]/g, c => '&#' + c.charCodeAt(0) + ';') + '"');
      if (!html) { if (box) box.remove(); return; }
      if (!box) { box = document.createElement('span'); box.className = 'bs-marks'; row.appendChild(box); }
      if (box.dataset.sig !== html) { box.dataset.sig = html; box.innerHTML = html; }
    });
    paintRemBtn(rem, now);
    // порядок трогаем, только если он неправильный – иначе зациклится с наблюдателем
    const items = pins.map(itemById).filter(Boolean);
    if (!items.length) return;
    const list = items[0].parentNode;
    const first = [...list.children].filter(c => c.matches('.dialogs_list_item[data-dialog-id]'));
    if (items.every((it, i) => first[i] === it)) return;
    const anchor = first[0];
    items.forEach(it => { if (it.parentNode === list) list.insertBefore(it, anchor); });
    // insertBefore одного и того же якоря ставит по порядку – закреплённые идут в порядке закрепления
  }

  function chime() {
    tone(988, 0, 0.3, 'sine', 0.8); tone(1319, 0.15, 0.3, 'sine', 0.7); tone(1568, 0.3, 0.5, 'sine', 0.7);
  }
  function toast(id, name, note) {
    let wrap = document.getElementById('bsToasts');
    if (!wrap) { wrap = document.createElement('div'); wrap.id = 'bsToasts'; document.body.appendChild(wrap); }
    const t = document.createElement('div');
    t.className = 'bs-toast';
    t.innerHTML = '<b>⏰ Вернуться к клиенту</b><span></span><small></small><i title="Закрыть">×</i>';
    t.querySelector('span').textContent = name || 'чат';
    t.querySelector('small').textContent = note || '';
    t.addEventListener('click', ev => {
      t.remove();
      if (ev.target.tagName === 'I') return;
      openChat(id);
    });
    wrap.appendChild(t);
  }
  function checkReminders() {
    const r = jget(REM_KEY, {}), now = Date.now();
    let changed = false;
    for (const id in r) if (!r[id].fired && r[id].at <= now) {
      r[id].fired = true; changed = true;
      chime(); toast(id, r[id].name || nameOf(itemById(id)), r[id].note);
    }
    if (changed) jset(REM_KEY, r);
    paintMarks();
  }

  // меню по правому клику
  function closeMenu() { const m = document.getElementById('bsMenu'); if (m) m.remove(); }
  function openMenu(it, x, y) {
    closeMenu();
    const id = it.dataset.dialogId, pinned = jget(PIN_KEY, []).includes(id), r = jget(REM_KEY, {})[id];
    const m = document.createElement('div');
    m.id = 'bsMenu';
    m.innerHTML =
      '<div class="bs-mi" data-a="peek">👁 Предпросмотр</div>' +
      '<div class="bs-mi" data-a="pin">' + (pinned ? '📌 Открепить' : '📌 Закрепить наверху') + '</div>' +
      '<div class="bs-mh">⏰ Напомнить через</div>' +
      '<div class="bs-note"><input class="bs-note-inp" type="text" maxlength="120" placeholder="Заметка: что сделать (необязательно)"></div>' +
      '<div class="bs-chips"><span data-h="0.5">30 мин</span><span data-h="1">1 ч</span><span data-h="2">2 ч</span><span data-h="4">4 ч</span></div>' +
      '<div class="bs-hrs"><input class="bs-num" data-k="h" type="number" min="0" step="1" placeholder="0"><span class="bs-lbl">ч</span><input class="bs-num" data-k="m" type="number" min="0" step="1" placeholder="0"><span class="bs-lbl">мин</span><button title="Поставить">✓</button></div>' +
      (r ? '<div class="bs-mi bs-del" data-a="unrem">Убрать напоминание</div>' : '');
    document.body.appendChild(m);
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(x, innerWidth - w - 8) + 'px';
    m.style.top = Math.min(y, innerHeight - h - 8) + 'px';
    const inH = m.querySelector('[data-k="h"]'), inM = m.querySelector('[data-k="m"]'), note = m.querySelector('.bs-note-inp');
    const inp = inH;
    if (r && r.note) note.value = r.note;
    // своё время: часы + минуты
    const num = el => Math.max(0, parseFloat(String(el.value).replace(',', '.')) || 0);
    const custom = () => {
      const hrs = num(inH) + num(inM) / 60;
      if (hrs > 0) { setRemind(id, hrs, note.value); closeMenu(); } else inH.focus();
    };
    m.addEventListener('click', ev => {
      const a = ev.target.closest('[data-a]'), chip = ev.target.closest('[data-h]');
      if (a && a.dataset.a === 'peek') { closeMenu(); openPeek(it, x, y); }
      else if (a && a.dataset.a === 'pin') { togglePin(id); closeMenu(); }
      else if (a && a.dataset.a === 'unrem') { setRemind(id, 0); closeMenu(); }
      else if (chip) { setRemind(id, +chip.dataset.h, note.value); closeMenu(); }
      else if (ev.target.tagName === 'BUTTON') custom();
    });
    [inH, inM].forEach(el => el.addEventListener('keydown', ev => { if (ev.key === 'Enter') custom(); if (ev.key === 'Escape') closeMenu(); }));
    note.addEventListener('keydown', ev => { if (ev.key === 'Enter') inp.focus(); if (ev.key === 'Escape') closeMenu(); });
  }

  // ---------- Предпросмотр чата без открытия (не ставит «прочитано») ----------
  // Сайт при открытии чата сам отдельно шлёт dialogs.setReadStatus, а мы берём только
  // dialogs.get и dialogs.getMessages – это чтение.
  function bsApi(method, params) {
    if (!(window.blueSales && window.blueSales.blueSalesApi))
      return fetch('/app/Customers/WebServer.aspx?command=' + method + '&v=1', {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(params),
      }).then(r => r.json()).then(r => r && r.response);
    return new Promise((ok, fail) => {
      try {
        bsOwnCall = true;
        new window.blueSales.blueSalesApi().callApi(method, params, { version: 1 })
          .done(r => ok(r && r.response)).fail(e => fail(e));
      } catch (e) { fail(e); } finally { bsOwnCall = false; }
    });
  }
  const getDialog = id => bsApi('dialogs.get', { dialogId: +id, startRowNumber: 1, pageSize: 1 }).then(r => (r || [])[0]);
  function closePeek() { const p = document.getElementById('bsPeek'); if (p) p.remove(); }
  async function openPeek(it, x, y) {
    closePeek();
    const id = it.dataset.dialogId, p = document.createElement('div');
    p.id = 'bsPeek';
    p.innerHTML = '<div class="bs-pk-head"><b></b><span class="bs-pk-x" title="Закрыть">×</span></div>' +
      '<div class="bs-pk-body"><div class="bs-pk-info">Загружаю…</div></div>' +
      '<div class="bs-pk-foot"><span class="bs-pk-note">Чат не открыт и остаётся непрочитанным</span><button>Открыть чат</button></div>';
    p.querySelector('b').textContent = nameOf(it) || 'Чат';
    document.body.appendChild(p);
    const r = it.getBoundingClientRect();
    p.style.left = Math.min(r.right + 8, innerWidth - p.offsetWidth - 8) + 'px';
    p.style.top = Math.max(8, Math.min(y - 40, innerHeight - p.offsetHeight - 8)) + 'px';
    p.querySelector('.bs-pk-x').onclick = closePeek;
    p.querySelector('button').onclick = () => { closePeek(); openChat(id); };
    const body = p.querySelector('.bs-pk-body'), info = t => { body.innerHTML = '<div class="bs-pk-info"></div>'; body.firstChild.textContent = t; };
    try {
      const d = await getDialog(id);
      if (!d) return info('Не нашёл этот чат');
      const tab = document.querySelector('.channel-tab a[data-channel-id="' + d.channelId + '"]') || document.querySelector('.channel-tab.active a[data-channel-type]');
      const msgs = (await bsApi('dialogs.getMessages', { dialogId: +id, startRowNumber: 1, pageSize: 15, newerThan: new Date(1), channelType: tab ? +tab.dataset.channelType : undefined })) || [];
      if (!document.body.contains(p)) return;
      msgs.sort((a, b) => new Date(a.date) - new Date(b.date));
      body.innerHTML = '';
      msgs.forEach(m => {
        const text = String(m.message || '').replace(/\[(?:id|club|public)\d+\|([^\]]+)\]/g, '$1').trim();
        const files = (m.attachments || []).length + (m.forwardedMessages || []).length;
        if (!text && !files && !m.fileUrl) return;
        const row = document.createElement('div');
        row.className = 'bs-pk-msg' + (m.fromUserId === d.shopUserId ? ' bs-pk-my' : '');
        row.innerHTML = '<div class="bs-pk-bub"></div><small></small>';
        row.firstChild.textContent = text || '📎 вложение';
        if (text && files) row.firstChild.append(document.createElement('br'), '📎 вложение');
        const dt = new Date(m.date);
        row.lastChild.textContent = isNaN(dt) ? '' : dt.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        body.appendChild(row);
      });
      if (!body.children.length) return info('Сообщений нет');
      body.scrollTop = body.scrollHeight;
      // проверка: не пометил ли сервер чат прочитанным
      if (d.isRead === false) {
        const d2 = await getDialog(id);
        if (d2 && d2.isRead) { const n = p.querySelector('.bs-pk-note'); n.textContent = '⚠ Сервер отметил чат прочитанным'; n.classList.add('bs-pk-warn'); }
      }
    } catch (e) {
      if (document.body.contains(p)) info('Не получилось загрузить сообщения');
    }
  }

  // ---------- Список напоминаний: кнопка ⏰ в панели справа внизу ----------
  function paintRemBtn(rem, now) {
    const b = document.getElementById('bsRemBtn');
    if (!b) return;
    const ids = Object.keys(rem), due = ids.some(id => rem[id].at <= now);
    const cnt = b.querySelector('b');
    if (cnt.textContent !== String(ids.length || '')) cnt.textContent = ids.length || '';
    cnt.classList.toggle('bs-due', due);
    b.title = ids.length ? 'Напоминания: ' + ids.length : 'Напоминаний нет';
    if (document.getElementById('bsRemList')) fillRemList();
  }
  function fillRemList() {
    const box = document.getElementById('bsRemList'), rem = jget(REM_KEY, {}), now = Date.now();
    const ids = Object.keys(rem).sort((a, b) => rem[a].at - rem[b].at);
    const sig = JSON.stringify(ids.map(id => [id, rem[id].at <= now ? 'пора' : remText(rem[id].at - now), rem[id].note, !!itemById(id)]));
    if (box.dataset.sig === sig) return;
    box.dataset.sig = sig;
    box.textContent = '';
    const h = document.createElement('div');
    h.className = 'bs-rl-head'; h.textContent = ids.length ? 'Напоминания' : 'Напоминаний нет';
    box.appendChild(h);
    for (const id of ids) {
      const r = rem[id], row = document.createElement('div');
      row.className = 'bs-rl-row';
      row.innerHTML = '<div class="bs-rl-top"><b></b><span></span><i title="Убрать">×</i></div><small></small>';
      row.querySelector('b').textContent = r.name || nameOf(itemById(id)) || 'чат';
      const t = row.querySelector('span');
      t.textContent = r.at <= now ? 'пора' : 'через ' + remText(r.at - now);
      t.classList.toggle('bs-due', r.at <= now);
      row.querySelector('small').textContent = r.note || '';
      if (!itemById(id)) row.title = 'Чата нет в загруженном списке – страница перезагрузится и откроет его';
      row.addEventListener('click', ev => {
        if (ev.target.tagName === 'I') { setRemind(id, 0); return; }
        closeRemList(); openChat(id);
      });
      box.appendChild(row);
    }
  }
  function closeRemList() { const l = document.getElementById('bsRemList'); if (l) l.remove(); }
  function toggleRemList() {
    if (document.getElementById('bsRemList')) return closeRemList();
    const l = document.createElement('div');
    l.id = 'bsRemList';
    document.body.appendChild(l);
    fillRemList();
  }
  function remBtnInit() {
    const dock = document.getElementById('bsDock'), before = document.getElementById('bsThemeBtn');
    if (!dock || document.getElementById('bsRemBtn')) return;
    const b = btn('bsRemBtn', '');
    b.innerHTML = svg('<circle cx="12" cy="13" r="8"/><path d="M12 9v4l2 2M5 3 2 6M19 3l3 3"/>') + '<b></b>';
    b.addEventListener('click', toggleRemList);
    dock.insertBefore(b, before);
  }

  // ---------- Фильтр «ответил только бот»: кнопка 🤖 рядом с ⏰ ----------
  function paintBotBtn() {
    const b = document.getElementById('bsBotBtn');
    if (!b) return;
    const n = document.querySelectorAll('.dialogs_list_item.bs-botchat').length, on = flag('bsOnlyBot');
    const cnt = b.querySelector('b');
    if (cnt.textContent !== String(n || '')) cnt.textContent = n || '';
    b.classList.toggle('bs-on', on);
    document.body.classList.toggle('bs-only-bot', on);
    b.title = (on ? 'Показаны только чаты, где ответил бот. Нажми, чтобы показать все' : 'Показать только чаты, где ответил бот') +
      ' (в загруженном списке: ' + n + ')';
  }
  function botBtnInit() {
    const dock = document.getElementById('bsDock'), before = document.getElementById('bsThemeBtn');
    if (!dock || document.getElementById('bsBotBtn')) return;
    const b = btn('bsBotBtn', '');
    b.innerHTML = svg('<rect x="4" y="8" width="16" height="12" rx="3"/><path d="M12 8V4.5"/><circle cx="12" cy="3.5" r="1"/><path d="M9 13v1.5M15 13v1.5M2 13v3M22 13v3"/>') + '<b></b>';
    b.addEventListener('click', () => { flip('bsOnlyBot'); paintBotBtn(); });
    dock.insertBefore(b, before);
    paintBotBtn();
  }

  function marksInit() {
    const st = document.createElement('style');
    st.textContent =
      '.bs-marks{display:inline-flex;gap:4px;margin-left:6px;vertical-align:1px;white-space:nowrap}' +
      '.bs-pin{font-size:11px}' +
      '.bs-rem{padding:0 5px;border-radius:5px;font-size:10.5px;line-height:15px;font-weight:600;background:rgba(59,130,246,.14);color:var(--bs-accent,#3b82f6)}' +
      '.bs-rem.bs-due{background:rgba(229,62,62,.16);color:#e04848}' +
      '#bsMenu{position:fixed;z-index:3000;min-width:230px;padding:6px;border-radius:10px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 8px 24px rgba(0,0,0,.18)}' +
      '#bsMenu .bs-mi{padding:6px 8px;border-radius:6px;cursor:pointer}' +
      '#bsPeek{position:fixed;z-index:3000;width:340px;max-width:calc(100vw - 16px);display:flex;flex-direction:column;border-radius:12px;font-size:13px;overflow:hidden;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 32px rgba(0,0,0,.2)}' +
      '#bsPeek .bs-pk-head{display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid var(--bs-border,#D9E0E7)}' +
      '#bsPeek .bs-pk-head b{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '#bsPeek .bs-pk-x{cursor:pointer;color:var(--bs-muted,#888);font-size:18px;line-height:1}' +
      '#bsPeek .bs-pk-body{max-height:360px;min-height:60px;overflow-y:auto;padding:10px 12px;display:flex;flex-direction:column;gap:6px}' +
      '#bsPeek .bs-pk-info{margin:auto;color:var(--bs-muted,#888)}' +
      '#bsPeek .bs-pk-msg{display:flex;flex-direction:column;align-items:flex-start;max-width:85%}' +
      '#bsPeek .bs-pk-my{align-self:flex-end;align-items:flex-end}' +
      '#bsPeek .bs-pk-bub{padding:6px 9px;border-radius:10px;background:var(--bs-hover,#f1f3f6);white-space:pre-wrap;word-break:break-word;line-height:1.35}' +
      '#bsPeek .bs-pk-my .bs-pk-bub{background:rgba(59,130,246,.14)}' +
      '#bsPeek .bs-pk-msg small{color:var(--bs-muted,#888);font-size:10.5px;margin:1px 4px 0}' +
      '#bsPeek .bs-pk-foot{display:flex;align-items:center;gap:8px;padding:8px 12px;border-top:1px solid var(--bs-border,#D9E0E7)}' +
      '#bsPeek .bs-pk-note{flex:1;color:var(--bs-muted,#888);font-size:11.5px}' +
      '#bsPeek .bs-pk-warn{color:#e04848}' +
      '#bsPeek button{padding:5px 11px;border:0;border-radius:7px;background:var(--bs-accent,#3b82f6);color:#fff;cursor:pointer;font-size:12.5px}' +
      '#bsMenu .bs-mi:hover,#bsMenu .bs-chips span:hover{background:var(--bs-hover,#f5f7fa)}' +
      '#bsMenu .bs-mh{padding:6px 8px 4px;color:var(--bs-muted,#888);font-size:12px}' +
      '#bsMenu .bs-chips{display:flex;gap:4px;padding:0 6px 6px}' +
      '#bsMenu .bs-chips span{flex:1 0 auto;text-align:center;padding:4px 8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:6px;cursor:pointer;font-size:12px;white-space:nowrap}' +
      '#bsMenu .bs-hrs{display:flex;align-items:center;gap:5px;padding:0 6px 6px}' +
      '#bsMenu .bs-hrs input{width:44px;padding:4px 6px;border:1px solid var(--bs-border,#D9E0E7);border-radius:6px;background:transparent;color:inherit;font-size:12px;outline:none}' +
      '#bsMenu .bs-hrs input:focus{border-color:var(--bs-accent,#3b82f6)}' +
      '#bsMenu .bs-lbl{font-size:12px;color:var(--bs-muted,#888);margin-right:4px}' +
      '#bsMenu .bs-hrs button{margin-left:auto;padding:3px 10px;border:0;border-radius:6px;background:var(--bs-accent,#3b82f6);color:#fff;cursor:pointer}' +
      '#bsMenu .bs-del{color:#e04848;border-top:1px solid var(--bs-border,#D9E0E7);border-radius:0 0 6px 6px;margin-top:2px}' +
      '#bsMenu .bs-note{padding:0 6px 6px}' +
      '#bsMenu .bs-note input{width:100%;box-sizing:border-box;padding:4px 6px;border:1px solid var(--bs-border,#D9E0E7);border-radius:6px;background:transparent;color:inherit;font-size:12px;outline:none}' +
      '#bsMenu .bs-note input:focus{border-color:var(--bs-accent,#3b82f6)}' +
      '#bsRemBtn b{position:absolute;top:0;right:0;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:var(--bs-accent,#3b82f6);color:#fff;font-size:9px;line-height:13px;font-weight:700}' +
      '#bsRemBtn b:empty{display:none}' +
      '#bsBotBtn.bs-on{background:var(--bs-accent-soft,rgba(59,130,246,.14))!important;color:var(--bs-accent,#3b82f6)!important}' +
      '#bsBotBtn b{position:absolute;top:0;right:0;min-width:13px;height:13px;padding:0 3px;box-sizing:border-box;border-radius:7px;background:#d48806;color:#fff;font-size:9px;line-height:13px;font-weight:700}' +
      '#bsBotBtn b:empty{display:none}' +
      'body.bs-only-bot .dialogs_list_item:not(.bs-botchat){display:none!important}' +
      '#bsRemBtn b.bs-due{background:#e04848}' +
      '#bsRemList{position:fixed;right:12px;bottom:54px;z-index:3000;width:260px;max-height:50vh;overflow:auto;box-sizing:border-box;padding:6px;border-radius:12px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 8px 24px rgba(0,0,0,.18)}' +
      '.bs-rl-head{padding:4px 8px 6px;color:var(--bs-muted,#888);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.03em}' +
      '.bs-rl-row{padding:6px 8px;border-radius:8px;cursor:pointer}' +
      '.bs-rl-row:hover{background:var(--bs-hover,#f5f7fa)}' +
      '.bs-rl-top{display:flex;align-items:center;gap:6px}' +
      '.bs-rl-top b{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600}' +
      '.bs-rl-top span{font-size:11.5px;color:var(--bs-accent,#3b82f6);white-space:nowrap}' +
      '.bs-rl-top span.bs-due{color:#e04848;font-weight:600}' +
      '.bs-rl-top i{font-style:normal;color:var(--bs-muted,#888);font-size:15px;padding:0 2px}' +
      '.bs-rl-top i:hover{color:#e04848}' +
      '.bs-rl-row small{display:block;color:var(--bs-muted,#888);font-size:12px;margin-top:1px}' +
      '.bs-rl-row small:empty{display:none}' +
      '.bs-toast small{display:block;color:var(--bs-muted,#888);font-size:12px;margin-top:2px}' +
      '.bs-toast small:empty{display:none}' +
      '#bsToasts{position:fixed;right:12px;bottom:60px;z-index:3001;display:flex;flex-direction:column;gap:6px;width:230px}' +
      '.bs-toast{position:relative;padding:9px 26px 9px 11px;border-radius:10px;cursor:pointer;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid #e04848;box-shadow:0 8px 24px rgba(0,0,0,.18)}' +
      '.bs-toast b{display:block;color:#e04848;font-size:12px;margin-bottom:2px}' +
      '.bs-toast i{position:absolute;right:8px;top:5px;font-style:normal;color:var(--bs-muted,#888);font-size:16px}';
    document.head.appendChild(st);
    document.addEventListener('contextmenu', ev => {
      const it = ev.target.closest && ev.target.closest('.dialogs_list_item[data-dialog-id]');
      if (!it) return;
      ev.preventDefault();
      openMenu(it, ev.clientX, ev.clientY);
    }, true);
    document.addEventListener('mousedown', ev => {
      if (!ev.target.closest) return;
      if (!ev.target.closest('#bsMenu')) closeMenu();
      if (!ev.target.closest('#bsPeek,#bsMenu')) closePeek();
      if (!ev.target.closest('#bsRemList,#bsRemBtn')) closeRemList();
    }, true);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') { closeMenu(); closeRemList(); closePeek(); } });
    remBtnInit();
    botBtnInit();
    checkReminders();
    setInterval(checkReminders, 15000);
  }
  document.addEventListener('DOMContentLoaded', marksInit);


  // ---------- Отчёт за смену ----------
  // Цифры берём со страницы «Клиенты» теми же фильтрами, что и вручную: только чтение, ничего не меняем.
  const CL_URL = '/app/Customers/CustomersList.aspx', CF = 'ctl00$ContentPlaceHolder1$tabs$ucCustomersFilter$';
  // третье поле – женский род: «Работу завершила»
  const MANAGERS = [['62503', 'Миша'], ['62451', 'Ксюша', 1], ['62434', 'Даша', 1], ['62713', 'Бес']];
  // «кто я»: раньше брался из отчёта (bsRepManager) – переносим один раз
  const ME_KEY = 'bsMe';
  try { if (!localStorage.getItem(ME_KEY) && localStorage.getItem('bsRepManager')) localStorage.setItem(ME_KEY, localStorage.getItem('bsRepManager')); localStorage.removeItem('bsRepManager'); } catch (e) {}
  const meId = () => { const v = localStorage.getItem(ME_KEY); return MANAGERS.some(m => m[0] === v) ? v : MANAGERS[0][0]; };
  // Поинтересовался, Презентация, Возражения, Ждём оплату, Бронь, Апсейл, Заказ оплачен, Отказ, Блок
  //  + Перестал отвечать (331182)
  const ST_ALL = '330640,331235,331253,331180,331532,334485,330646,330650,331531,331182', ST_BLOCK = '331531';
  const REP_KEY = 'bsReport';
  const ddmm = d => String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
  const plural = (n, a, b, c) => { const m = n % 100, k = n % 10; return m > 10 && m < 20 ? c : k === 1 ? a : k > 1 && k < 5 ? b : c; };
  const parseHtml = h => new DOMParser().parseFromString(h, 'text/html');

  // kind – psFirstContact (первый контакт) или psLastContact (последний)
  // форма страницы «Клиенты» – одна на все три подсчёта
  async function clientsForm() {
    return parseHtml(await (await fetch(CL_URL, { credentials: 'same-origin' })).text()).forms[0];
  }
  async function countClients(form, kind, from, till, statuses, manager) {
    const fd = new FormData(form);
    fd.set(CF + kind + '$cmbPeriod', '8');
    fd.set(CF + kind + '$dpDateFrom$dbcDate', from);
    fd.set(CF + kind + '$dpDateTill$dbcDate', till);
    fd.set(CF + 'tsCrmStatuses', statuses);
    fd.set(CF + 'tsManagers', manager);
    fd.set('__EVENTTARGET', ''); fd.set('__EVENTARGUMENT', '');
    fd.set('ctl00$ContentPlaceHolder1$btnShow', 'Показать');
    const res = await fetch(CL_URL, { method: 'POST', body: new URLSearchParams(fd), credentials: 'same-origin' });
    const txt = (await res.text()).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    // до 30 строк сайт пишет «Всего: N клиентов», больше – «Показаны строки с 1 по 30 из N»
    const m = /строки с \d+ по \d+ из (\d+)/.exec(txt) || /Всего:\s*(\d+)/.exec(txt);
    return m ? +m[1] : 0;
  }

  function repSaved() {
    let r = jget(REP_KEY, {});
    if (r.d && r.d !== ddmm(new Date()) && histRoll()) r = jget(REP_KEY, {});
    return r.d === ddmm(new Date()) ? r : { d: ddmm(new Date()) };
  }
  function repText(v, fem) {
    const n = k => +v[k] || 0;
    return '#отчёт\n\n' +
      'новые лиды - ' + n('leads') + ' (' + n('blocks') + ' ' + plural(n('blocks'), 'блок', 'блока', 'блоков') + ')\n' +
      'чатов в работе - ' + n('chats') + '\n' +
      'выставлено ссылок - ' + n('links') + '\n\n' +
      'купили (кол-во программ) - ' + String(n('bought')).replace('.', ',') + '\n\n' +
      'сумма продаж за сегодня - ' + n('sum') + ' рублей\n\n' +
      'Работу ' + (fem ? 'завершила' : 'завершил') + '\n\n' +
      n('rem') + ' ' + plural(n('rem'), 'напоминание', 'напоминания', 'напоминаний');
  }
  const REP_FIELDS = [
    ['leads', 'Новые лиды', 1], ['blocks', 'из них блоков', 1], ['chats', 'Чатов в работе', 1],
    ['links', 'Выставлено ссылок'], ['bought', 'Купили (программ)'], ['sum', 'Сумма продаж, ₽'], ['rem', 'Напоминаний'],
  ];
  const repFem = m => (MANAGERS.find(x => x[0] === (m || meId())) || [])[2];
  // отчёт – вкладка раздела «Смена»: смотреть и копировать можно по ходу дня, при закрытии смены он сохраняется сам
  function paintReport(host) {
    host.innerHTML =
      '<div id="bsRep">' +
      '<div class="bs-rep-top"><div class="bs-rep-range">' + MANAGERS.map(([id, n]) => '<span data-m="' + id + '">' + n + '</span>').join('') + '</div>' +
      '<input type="date" class="bs-rep-date" title="Дата отчёта"></div>' +
      '<div class="bs-rep-grid">' + REP_FIELDS.map(([k, label, auto]) =>
        '<label' + (auto ? ' class="bs-auto"' : '') + '><span>' + label + '</span><input type="number" min="0" data-k="' + k + '"></label>').join('') + '</div>' +
      '<div class="bs-rep-status"></div>' +
      '<textarea spellcheck="false"></textarea>' +
      '<div class="bs-rep-btns"><span class="bs-rep-edited">Текст правлен вручную</span><button data-a="rebuild" class="bs-rep-edited" title="Собрать текст из цифр заново">Собрать заново</button><button data-a="reload">Обновить цифры</button><button data-a="copy" class="bs-main">Скопировать</button></div></div>';
    const box = host.querySelector('#bsRep'), ta = box.querySelector('textarea'), status = box.querySelector('.bs-rep-status');
    const inputs = {};
    box.querySelectorAll('input[data-k]').forEach(i => { inputs[i.dataset.k] = i; });
    const saved = repSaved();
    for (const k in inputs) if (saved[k] != null) inputs[k].value = saved[k];
    if (saved.rem == null) inputs.rem.value = 0;
    let manager = meId();   // переключение ниже – только посмотреть чужие цифры, «кто я» не меняет
    // дата по умолчанию – сегодня; value у input[type=date] в виде гггг-мм-дд
    const dateInp = box.querySelector('.bs-rep-date');
    dateInp.value = ddmm(new Date()).split('.').reverse().join('-');
    const repDate = () => dateInp.value ? dateInp.value.split('-').reverse().join('.') : ddmm(new Date());
    // текст отчёта можно править руками: тогда он хранится как есть (bsReport.text) и цифры его не перезаписывают
    let edited = saved.text != null;
    // статус – цветная плашка: синяя с крутилкой, зелёная с галочкой, красная
    const setStatus = (st, text) => {
      status.dataset.st = st;
      status.innerHTML = '<i></i><span></span>';
      status.querySelector('span').textContent = text;
    };
    const values = () => { const v = {}; for (const k in inputs) v[k] = inputs[k].value; return v; };
    const update = () => {
      if (!box.isConnected) return;   // вкладку закрыли или смену уже закрыли – старые цифры не записываем
      if (!edited) ta.value = repText(values(), repFem(manager));
      box.classList.toggle('bs-edited', edited);
      // ручные цифры за сегодня запоминаются, автоматические пересчитываются при каждом открытии
      jset(REP_KEY, Object.assign({ d: ddmm(new Date()) }, values(), edited ? { text: ta.value } : {}));
    };
    if (edited) ta.value = saved.text;
    const paintRange = () => box.querySelectorAll('[data-m]').forEach(s => s.classList.toggle('bs-on', s.dataset.m === manager));
    let run = 0;
    // reset – пересчёт запросил сам пользователь (кнопка, дата, менеджер): ручную правку текста сбрасываем
    async function load(reset) {
      if (reset === true) edited = false;
      const t = repDate(), m = manager, my = ++run;
      const who = MANAGERS.find(x => x[0] === m)[1];
      setStatus('load', 'Считаю лиды и чаты – ' + who + ', ' + t.slice(0, 5) + '…');
      box.classList.add('bs-loading');
      try {
        const form = await clientsForm();
        const [leads, blocks, chats] = await Promise.all([
          countClients(form, 'psFirstContact', t, t, ST_ALL, m),
          countClients(form, 'psFirstContact', t, t, ST_BLOCK, m),
          countClients(form, 'psLastContact', t, t, ST_ALL, m),
        ]);
        if (my !== run || !box.isConnected) return;   // пока считали, переключили менеджера или закрыли вкладку
        inputs.leads.value = leads; inputs.blocks.value = blocks; inputs.chats.value = chats;
        setStatus('ok', 'Посчитано: ' + who + ', ' + t.slice(0, 5) + ' · остальное вручную');
        box.classList.remove('bs-done'); void box.offsetWidth; box.classList.add('bs-done');
      } catch (e) {
        if (my !== run) return;
        setStatus('err', 'Не посчиталось – впиши цифры вручную');
      }
      box.classList.remove('bs-loading');
      update();
    }
    box.addEventListener('input', ev => {
      if (ev.target === ta) edited = true;
      if (ev.target !== dateInp) update();
    });
    dateInp.addEventListener('change', () => load(true));
    box.addEventListener('click', ev => {
      const r = ev.target.dataset.m, a = ev.target.dataset.a;
      if (r) { manager = r; paintRange(); load(true); }
      else if (a === 'reload') load(true);
      else if (a === 'rebuild') { edited = false; update(); }
      else if (a === 'copy') {
        update();
        navigator.clipboard.writeText(ta.value).then(() => {
          ev.target.textContent = 'Скопировано ✓';
          setTimeout(() => { ev.target.textContent = 'Скопировать'; }, 1500);
        });
      }
    });
    paintRange(); update(); load();
  }
  function reportInit() {
    if (document.getElementById('bsRepCss')) return;
    setTimeout(repAuto, 5000);
    setInterval(repAuto, 60e3);
    const st = document.createElement('style');
    st.id = 'bsRepCss';
    st.textContent =
      '.bs-tab #bsRep{width:auto;max-width:none;max-height:none;overflow:visible;padding:0;border:0;border-radius:0;box-shadow:none;background:none}' +
      '.bs-hrep textarea{width:100%;box-sizing:border-box;height:260px;resize:vertical;padding:8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:var(--bs-hover,#f5f7fa);color:var(--bs-text,#222);font:12.5px/1.4 inherit}' +
      '#bsRepWrap{position:fixed;inset:0;z-index:3100;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}' +
      '#bsRep{width:400px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:14px 16px;border-radius:14px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
      '.bs-rep-head{display:flex;align-items:center;margin-bottom:10px}.bs-rep-head b{flex:1;font-size:15px}' +
      '.bs-rep-head i{font-style:normal;font-size:20px;color:var(--bs-muted,#888);cursor:pointer}' +
      '.bs-rep-top{display:flex;align-items:center;gap:8px;margin-bottom:10px}' +
      '.bs-rep-date{margin-left:auto;padding:3px 6px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:transparent;color:var(--bs-text,#222);font-size:12px;color-scheme:light dark}' +
      '.bs-rep-edited{display:none!important}#bsRep.bs-edited .bs-rep-edited{display:inline-block!important}' +
      'span.bs-rep-edited{margin-right:auto;align-self:center;font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-rep-range{display:inline-flex;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;overflow:hidden}' +
      '.bs-rep-range span{padding:4px 10px;cursor:pointer;color:var(--bs-muted,#888);font-size:12px}' +
      '.bs-rep-range span.bs-on{background:var(--bs-accent,#3b82f6);color:#fff}' +
      '.bs-rep-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px 10px}' +
      '.bs-rep-grid label{display:flex;flex-direction:column;gap:2px;font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-rep-grid label.bs-auto span::after{content:" · авто";color:var(--bs-accent,#3b82f6)}' +
      '.bs-rep-grid input{padding:5px 8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:transparent;color:var(--bs-text,#222);font-size:13px;outline:none}' +
      '.bs-rep-grid input:focus{border-color:var(--bs-accent,#3b82f6)}' +
      // пока считаем – поля «авто» переливаются, кнопки копирования и пересчёта неактивны
      '#bsRep.bs-loading .bs-auto input{color:transparent!important;background-image:linear-gradient(var(--bs-border,#D9E0E7),var(--bs-border,#D9E0E7))!important;background-repeat:no-repeat!important;background-position:9px center!important;background-size:22px 8px;animation:bsBar .9s ease-in-out infinite alternate}' +
      '@keyframes bsBar{from{background-size:22px 8px}to{background-size:58px 8px}}' +
      '#bsRep.bs-loading .bs-rep-btns button[data-a=copy],#bsRep.bs-loading .bs-rep-btns button[data-a=reload]{opacity:.45;pointer-events:none}' +
      '#bsRep.bs-done .bs-auto input{animation:bsOk 1.4s ease-out}' +
      '@keyframes bsOk{0%,40%{border-color:#22a55a;box-shadow:0 0 0 3px rgba(34,165,90,.18)}100%{box-shadow:0 0 0 0 rgba(34,165,90,0)}}' +
      '.bs-rep-status{display:flex;align-items:center;gap:8px;margin:10px 0;padding:8px 10px;border-radius:9px;font-size:12.5px;font-weight:500}' +
      '.bs-rep-status:empty{display:none}' +
      '.bs-rep-status span{min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.bs-rep-status[data-st=load]{background:var(--bs-hover,#f3f5f8);color:var(--bs-muted,#777)}' +
      '.bs-rep-status[data-st=load] i{color:var(--bs-accent,#3b82f6)}' +
      '.bs-rep-status[data-st=ok]{background:rgba(34,165,90,.13);color:#1f9d55}' +
      '.bs-rep-status[data-st=err]{background:rgba(229,62,62,.13);color:#e04848}' +
      '.bs-rep-status i{flex:none;width:16px;height:16px;box-sizing:border-box;border-radius:50%;display:flex;align-items:center;justify-content:center;font-style:normal;font-size:11px;font-weight:700;color:#fff}' +
      '.bs-rep-status[data-st=load] i{border:2px solid currentColor;border-right-color:transparent;animation:bsSpin .7s linear infinite}' +
      '.bs-rep-status[data-st=ok] i{background:#22a55a}.bs-rep-status[data-st=ok] i::before{content:"✓"}' +
      '.bs-rep-status[data-st=err] i{background:#e04848}.bs-rep-status[data-st=err] i::before{content:"!"}' +
      '@keyframes bsSpin{to{transform:rotate(360deg)}}' +
      '#bsRep textarea{width:100%;box-sizing:border-box;height:210px;resize:vertical;padding:8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:var(--bs-hover,#f5f7fa);color:var(--bs-text,#222);font:12.5px/1.4 inherit}' +
      '.bs-rep-btns{display:flex;flex-wrap:wrap;gap:8px;justify-content:flex-end;margin-top:10px}' +
      '.bs-rep-btns button{padding:6px 12px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:none;color:var(--bs-text,#222);cursor:pointer;font-size:13px}' +
      '.bs-rep-btns button.bs-main{background:var(--bs-accent,#3b82f6);border-color:var(--bs-accent,#3b82f6);color:#fff}';
    document.head.appendChild(st);
  }
  document.addEventListener('DOMContentLoaded', reportInit);
  // ---------- Кнопка «Тарифы и фразы» в нижней панели ----------
  function tarBtnInit() {
    const dock = document.getElementById('bsDock'), before = document.getElementById('bsThemeBtn');
    if (!dock || document.getElementById('bsTarBtn')) return;
    const b = btn('bsTarBtn', 'Тарифы и свои фразы {…}');
    b.innerHTML = svg('<path d="M8 4H7a2 2 0 0 0-2 2v4a2 2 0 0 1-2 2 2 2 0 0 1 2 2v4a2 2 0 0 0 2 2h1M16 4h1a2 2 0 0 1 2 2v4a2 2 0 0 0 2 2 2 2 0 0 0-2 2v4a2 2 0 0 1-2 2h-1"/>');
    b.addEventListener('click', openTariffs);
    dock.insertBefore(b, before);
  }
  document.addEventListener('DOMContentLoaded', tarBtnInit);

  // ---------- Счётчик выставленных ссылок над смайликами ----------
  // «+» после каждой ссылки на оплату – число сразу попадает в отчёт (поле «Выставлено ссылок»).
  function linksGet() { return +repSaved().links || 0; }
  function linksSet(n) {
    jset(REP_KEY, Object.assign(repSaved(), { links: Math.max(0, n) }));
    paintLinks();
    const i = document.querySelector('#bsRep input[data-k="links"]');
    if (i) { i.value = linksGet(); i.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function paintLinks() {
    const b = document.querySelector('#bsLinkC b');
    if (b && b.textContent !== String(linksGet())) b.textContent = linksGet();
  }
  function placeLinks() {
    const b = document.getElementById('bsLinks'), dock = document.getElementById('bsDock');
    if (!b || !dock) return;
    const on = document.body.classList.contains('slide-panel-right-open');
    const tog = document.getElementById('bsEmoToggle');
    b.style.display = on ? 'flex' : 'none';
    const sh = document.getElementById('bsShift');
    if (sh) sh.style.display = b.style.display;
    if (tog) tog.style.display = 'none';
    if (!on) return;
    // поле ввода скрыто (клиент заблокировал и т.п.) – плашку смайликов не показываем
    const box = document.querySelector('.send_message_box'), can = !!(box && box.getClientRects().length);
    if (document.body.classList.contains('bs-can-send') !== can) document.body.classList.toggle('bs-can-send', can);
    const sel = can && document.querySelector('.send_message_box .emoji_selector');
    const open = sel && sel.getClientRects().length && !document.body.classList.contains('bs-emo-closed');
    if (open) fitEmoji(sel, b);
    const bar = document.getElementById('bsEmoBar');
    const r = (open ? sel : can && bar ? bar : dock).getBoundingClientRect();
    b.style.bottom = (innerHeight - r.top + 6) + 'px';
    if (sh) sh.style.bottom = (innerHeight - b.getBoundingClientRect().top + 6) + 'px';
    // карточка клиента прокручивается под плашками – снизу у неё отступ на их высоту
    const top = (sh && sh.offsetHeight ? sh : b).getBoundingClientRect().top;
    document.body.style.setProperty('--bs-stack', Math.max(10, Math.round(innerHeight - top + 10)) + 'px');
    if (open && tog) {
      tog.style.display = 'flex';
      // вся верхняя полоса панели – кнопка сворачивания, стрелка справа
      tog.style.top = (r.top + 1) + 'px';
      tog.style.left = (r.left + 1) + 'px';
      tog.style.width = (r.width - 2) + 'px';
    }
  }
  // много тегов – карточка клиента растёт вниз; панель смайликов сужаем, чтобы не наезжала на неё
  function fitEmoji(sel, pill) {
    const R = document.querySelector('.slide-panel-right');
    if (!R) return;
    let bottom = 0;
    R.querySelectorAll('.slide-panel-section *').forEach(e => {
      if (e.children.length) return;
      const rr = e.getBoundingClientRect();
      if (rr.height && rr.bottom > bottom) bottom = rr.bottom;
    });
    sel.style.removeProperty('height');
    const r = sel.getBoundingClientRect();
    const sh = document.getElementById('bsShift');
    const pills = pill.offsetHeight + 6 + (sh && sh.offsetHeight ? sh.offsetHeight + 6 : 0);
    const room = r.bottom - (bottom + 22 + pills);
    if (room < r.height) sel.style.setProperty('height', Math.max(110, room) + 'px', 'important');
  }
  // два круга над смайликами: «продано» (нажал – новая продажа) и «ссылки» (нажал – +1, минус – в уголке)
  function linksInit() {
    if (document.getElementById('bsLinks')) return;
    const b = document.createElement('div');
    b.id = 'bsLinks';
    b.className = 'bs-duo';
    b.innerHTML = '<div id="bsSold" class="bs-ring" data-a="sale" title="Добавить продажу в этом чате"><div><b>0</b><i class="bs-ring-p">+</i></div><span>продано</span></div>' +
      '<div id="bsLinkC" class="bs-ring bs-ring-l" data-a="link" title="Выставил ссылку – плюс одна"><div><b>0</b><i class="bs-ring-p">+</i><i class="bs-ring-m" data-a="unlink" title="Убрать одну">−</i></div><span>ссылки</span></div>';
    b.addEventListener('click', ev => {
      const a = ev.target.closest('[data-a]')?.dataset.a;
      if (a === 'sale') openSale();
      else if (a === 'link') linksSet(linksGet() + 1);
      else if (a === 'unlink') linksSet(linksGet() - 1);
    });
    document.body.appendChild(b);
    const st = document.createElement('style');
    st.textContent =
      '.bs-duo{position:fixed;right:12px;width:230px;box-sizing:border-box;z-index:2001;justify-content:center;gap:34px;padding:2px 0 0;pointer-events:none}' +
      '.bs-ring{display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;user-select:none;pointer-events:auto}' +
      '.bs-ring>div{position:relative;width:60px;height:60px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:50%;' +
      'background:var(--bs-panel,#fff);border:2px solid var(--bs-accent,#3b82f6);box-shadow:0 2px 10px rgba(0,0,0,.08);transition:transform .12s,box-shadow .12s}' +
      '.bs-ring:hover>div{transform:translateY(-1px);box-shadow:0 4px 14px rgba(0,0,0,.14)}.bs-ring:active>div{transform:scale(.96)}' +
      '.bs-ring b{font-size:19px;font-weight:700;color:var(--bs-text,#222);font-variant-numeric:tabular-nums;letter-spacing:-.3px}' +
      '.bs-ring span{font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-ring i{position:absolute;bottom:-3px;width:20px;height:20px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:50%;font-style:normal;font-size:14px;line-height:1;font-weight:600}' +
      '.bs-ring-p{right:-3px;background:var(--bs-accent,#3b82f6);color:#fff;border:2px solid var(--bs-panel,#fff)}' +
      '.bs-ring-l>div{border-color:#22a55a}.bs-ring-l .bs-ring-p{background:#22a55a}' +
      '.bs-ring-m{left:-3px;background:var(--bs-panel,#fff);color:var(--bs-muted,#888);border:1px solid var(--bs-border,#D9E0E7)}.bs-ring-m:hover{color:#e04848;border-color:#e04848}';
    document.head.appendChild(st);
    paintLinks(); placeLinks();
    document.getElementById('bsEmoToggle')?.addEventListener('click', () => setTimeout(placeLinks));
    document.getElementById('bsEmoLabel')?.addEventListener('click', () => setTimeout(placeLinks));
    addEventListener('resize', placeLinks);
    // панель смайликов сворачивается и появляется – просто переставляем раз в секунду, это дёшево
    setInterval(() => { placeLinks(); paintLinks(); paintSold(); homeInit(); remMark(); }, 1000);
  }
  document.addEventListener('DOMContentLoaded', linksInit);

  // ---------- Счётчик проданных курсов ----------
  // Жмётся руками в момент продажи: ¼, ⅓, ½ или целый курс. Число идёт в отчёт («Купили (программ)»).
  const r2 = x => Math.round(x * 100) / 100;
  function soldGet() { return +repSaved().bought || 0; }
  function soldAdd(d) {
    const r = repSaved(), log = r.soldLog || [];
    if (d) log.push(d); else if (log.length) d = -log.pop(); else return;
    jset(REP_KEY, Object.assign(r, { bought: Math.max(0, r2((+r.bought || 0) + d)), soldLog: log }));
    paintSold();
    const i = document.querySelector('#bsRep input[data-k="bought"]');
    if (i) { i.value = soldGet(); i.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  function paintSold() {
    const b = document.querySelector('#bsSold b'), v = String(soldGet()).replace('.', ',');
    if (b && b.textContent !== v) b.textContent = v;
    const sh = document.getElementById('bsShift'), now = new Date();
    if (sh) { const t = WD[now.getDay()] + ', ' + ddmm(now).slice(0, 5); if (sh.querySelector('span').textContent !== t) sh.querySelector('span').textContent = t; }
  }
  function soldInit() {
    if (document.getElementById('bsShift')) return;
    // раздел «Смена» – отдельной большой кнопкой над кругами
    const sh = document.createElement('div');
    sh.id = 'bsShift';
    sh.style.display = 'none';
    sh.title = 'Смена: продажи, отчёт за день, история';
    sh.innerHTML = '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="16" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg><b>Смена</b><span></span><i>›</i>';
    sh.addEventListener('click', () => openSales());
    document.body.appendChild(sh);
    const st = document.createElement('style');
    st.textContent =
      '#bsShift{position:fixed;right:12px;width:230px;height:42px;box-sizing:border-box;z-index:2001;align-items:center;gap:8px;padding:0 12px;border-radius:12px;cursor:pointer;font-size:12.5px;' +
      'background:var(--bs-accent,#3b82f6);color:#fff;box-shadow:0 2px 8px rgba(59,130,246,.25)}#bsShift:hover{filter:brightness(1.08)}' +
      '#bsShift svg{flex:none}#bsShift b{font-size:14px;font-weight:600}#bsShift span{flex:1;min-width:0;text-align:right;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}' +
      '#bsShift i{font-style:normal;font-size:20px;line-height:1;opacity:.85}';
    document.head.appendChild(st);
    paintSold();
  }
  document.addEventListener('DOMContentLoaded', soldInit);

  // ---------- Тарифы: {мат кур год} в поле ввода превращается в ссылку ----------
  // Ссылки хранятся только в этом браузере (localStorage bsTariffs), в репозиторий не попадают.
  // Строка тарифа: «слова | ссылка | цена». Слова и сокращение сводятся к одним меткам:
  const TAR_KEY = 'bsTariffs';
  const TAR_WORDS = [['мат', ['мат', 'проф']], ['баз', ['баз']], ['рус', ['рус']], ['комбо', ['комб']],
    ['бронь', ['брон', 'мес', 'сен']], ['год', ['год']], ['кур', ['кур']], ['сам', ['сам', 'бк']]];
  const TAR_SKIP = ['с', 'и', 'на', 'егэ', 'курс', 'тариф', 'ссылка'];
  // текст → набор меток; unknown – слова, которых нет в словаре
  function tarTags(text) {
    const t = norm(text).replace(/без\s*кур\S*/g, 'сам').replace(/мат\S*\s*\+\s*рус\S*|рус\S*\s*\+\s*мат\S*/g, 'комбо');
    const tags = new Set(), unknown = [];
    t.split(/[\s,.;:+/]+/).filter(Boolean).forEach(w => {
      if (TAR_SKIP.includes(w)) return;
      const hit = TAR_WORDS.find(([, stems]) => stems.some(x => w.startsWith(x)));
      if (hit) tags.add(hit[0]); else unknown.push(w);
    });
    // и математика, и русский – это комбо
    if (tags.has('мат') && tags.has('рус')) { tags.delete('мат'); tags.delete('рус'); tags.add('комбо'); }
    // «базовая математика» – это база
    if (tags.has('баз')) tags.delete('мат');
    return { tags, unknown };
  }
  function tarFind(query) {
    const { tags, unknown } = tarTags(query);
    if (unknown.length) return { err: 'Не понял: ' + unknown.join(', ') };
    if (!tags.size) return { err: 'Пустое сокращение' };
    const list = jget(TAR_KEY, []);
    if (!list.length) return { err: 'Тарифов нет – добавь их через кнопку { } в нижней панели' };
    const found = list.filter(t => { const own = tarTags(t.k).tags; return [...tags].every(x => own.has(x)); });
    if (found.length === 1) return { t: found[0] };
    if (!found.length) return { err: 'Нет такого тарифа: ' + [...tags].join(' ') };
    return { err: 'Подходит несколько: ' + found.map(t => t.k).join(' · ') + ' – уточни' };
  }
  function tarHint(text, ok) {
    let h = document.getElementById('bsTarHint');
    if (!h) { h = document.createElement('div'); h.id = 'bsTarHint'; document.body.appendChild(h); }
    const box = document.querySelector('.send_message_box');
    const r = box ? box.getBoundingClientRect() : { left: 20, top: innerHeight - 60 };
    h.style.left = r.left + 'px';
    h.style.bottom = (innerHeight - r.top + 6) + 'px';
    h.textContent = text;
    h.className = ok ? 'bs-ok' : '';
    h.style.display = 'block';
    clearTimeout(h._t);
    h._t = setTimeout(() => { h.style.display = 'none'; }, ok ? 2500 : 5000);
  }
  // свои фразы {ключ} → текст; слова ключа – в любом порядке
  const SNIP_KEY = 'bsSnippets';
  const snipKey = t => norm(t).split(/[\s,.;]+/).filter(Boolean).sort().join(' ');
  function tarOnInput(ev) {
    const ta = ev.target;
    if (!ta.matches || !ta.matches('textarea.send_message_textarea')) return;
    const m = /\{([^{}\n]*)\}/.exec(ta.value);
    if (!m) return;
    const sn = jget(SNIP_KEY, []).find(x => snipKey(x.k) === snipKey(m[1]));
    const res = sn ? { t: { u: sn.v, k: sn.k, p: '' } } : tarFind(m[1]);
    if (!res.t) return tarHint(res.err);
    const pos = m.index + res.t.u.length;
    ta.value = ta.value.slice(0, m.index) + res.t.u + ta.value.slice(m.index + m[0].length);
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    tarHint('✓ ' + (sn ? 'фраза: ' : '') + res.t.k + (res.t.p ? ' – ' + res.t.p + ' ₽' : ''), true);
  }
  // сообщение ушло – сколько в нём ссылок из тарифов и на заказы, столько +1 в «Ссылки»
  function tarSent(raw) {
    let t = raw.replace(/\\\//g, '/');
    try { t += ' ' + decodeURIComponent(raw.replace(/\+/g, ' ')); } catch (e) {}
    // плюс ссылки на заказ (…/sales/shop/deal?id=…) – каждый заказ один раз
    const deals = new Set([...t.matchAll(/\/sales\/shop\/deal\?id=(\d+)/g)].map(m => m[1]));
    const n = jget(TAR_KEY, []).filter(x => t.includes(x.u)).length + deals.size;
    if (n) linksSet(linksGet() + n);
  }
  // обмен тарифами и фразами: файл только с ними (без продаж, отчёта и прочего)
  function tarExport() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'bluesales-tariffs', t: Date.now(), tar: jget(TAR_KEY, []), snip: jget(SNIP_KEY, []) }, null, 1)], { type: 'application/json' }));
    a.download = 'тарифы-' + ddmm(new Date()) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  // слияние: совпало сокращение/ключ – берём из файла, остальное своё не трогаем
  function tarImport(text) {
    let j; try { j = JSON.parse(text); } catch (e) {}
    // подходит и файл тарифов, и полная резервная копия помощника
    if (j && j.app === 'bluesales-helper' && j.data) { const g = k => { try { return JSON.parse(j.data[k] || '[]'); } catch (e) { return []; } }; j = { app: 'bluesales-tariffs', tar: g(TAR_KEY), snip: g(SNIP_KEY) }; }
    if (!j || j.app !== 'bluesales-tariffs') { alert('Это не файл тарифов помощника.'); return false; }
    const str = v => typeof v === 'string' ? v.trim() : v == null ? '' : String(v).trim();
    const inTar = (Array.isArray(j.tar) ? j.tar : []).map(x => ({ k: str(x && x.k), u: str(x && x.u), p: str(x && x.p).replace(/\s/g, ''), n: str(x && x.n) })).filter(x => x.k && /^https?:\/\/\S+$/.test(x.u));
    const inSnip = (Array.isArray(j.snip) ? j.snip : []).map(x => ({ k: str(x && x.k), v: str(x && x.v) })).filter(x => x.k && x.v);
    if (!inTar.length && !inSnip.length) { alert('В файле нет ни одного тарифа или фразы.'); return false; }
    let added = 0, changed = 0;
    const merge = (key, items, same) => {
      const list = jget(key, []);
      items.forEach(x => {
        const i = list.findIndex(y => same(y.k) === same(x.k));
        if (i < 0) { list.push(x); added++; } else if (JSON.stringify(list[i]) !== JSON.stringify(x)) { list[i] = x; changed++; }
      });
      return list;
    };
    const tar = merge(TAR_KEY, inTar, k => snipKey(k)), snip = merge(SNIP_KEY, inSnip, snipKey);
    if (!added && !changed) { tarHint('✓ Всё из файла уже есть', true); return false; }
    if (!confirm('Из файла: тарифов ' + inTar.length + ', фраз ' + inSnip.length + '.\nДобавится новых: ' + added + ', заменится с тем же сокращением: ' + changed + '.\nОстальные твои тарифы и фразы останутся. Загрузить?')) return false;
    jset(TAR_KEY, tar); jset(SNIP_KEY, snip);
    tarHint('✓ Загружено: новых ' + added + ', заменено ' + changed, true);
    return true;
  }
  function closeTariffs() { const o = document.getElementById('bsTarWrap'); if (o) o.remove(); }
  // редактор – табличка; сохраняется сам при каждом изменении
  function openTariffs() {
    if (document.getElementById('bsTarWrap')) return closeTariffs();
    const wrap = document.createElement('div');
    wrap.id = 'bsTarWrap';
    wrap.innerHTML =
      '<div id="bsTar"><div class="bs-rep-head"><b>Тарифы и фразы</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-rep-range bs-tar-tabs"><span data-tab="tar" class="bs-on">Тарифы</span><span data-tab="snip">Свои фразы</span></div>' +
      '<div class="bs-tar-pane" data-pane="tar"><div class="bs-tar-help">В сообщении пиши <code>{мат мес сам}</code> – подставится ссылка. ' +
      'Слова: мат / баз / рус / комбо · мес / год · кур / сам, порядок любой.</div>' +
      '<div class="bs-tr bs-th"><span>Сокращение</span><span>Ссылка</span><span>Цена, ₽</span><span>Название в отчёте</span><span></span></div>' +
      '<div class="bs-tbody" data-list="tar"></div><button class="bs-tar-add" data-add="tar">+ Добавить тариф</button></div>' +
      '<div class="bs-tar-pane" data-pane="snip" hidden><div class="bs-tar-help">В сообщении пиши <code>{мат отзывы}</code> – подставится текст. Слова ключа – в любом порядке.</div>' +
      '<div class="bs-tr bs-sr bs-th"><span>Ключ</span><span>Текст или ссылка</span><span></span></div>' +
      '<div class="bs-tbody" data-list="snip"></div><button class="bs-tar-add" data-add="snip">+ Добавить фразу</button></div>' +
      '<div class="bs-tar-foot"><span class="bs-tar-note">Сохраняется само · хранится только в этом браузере</span><span class="bs-tar-st"></span>' +
      '<button data-x="out" title="Скачать тарифы и фразы файлом – например, чтобы отдать коллеге">Выгрузить</button>' +
      '<button data-x="in" title="Добавить тарифы и фразы из файла: с тем же сокращением – заменятся, остальные твои останутся">Загрузить</button>' +
      '<input type="file" accept=".json,application/json" hidden></div></div>';
    document.body.appendChild(wrap);
    const lists = { tar: wrap.querySelector('[data-list="tar"]'), snip: wrap.querySelector('[data-list="snip"]') };
    const st = wrap.querySelector('.bs-tar-st');
    const grow = ta => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight + 2, 200) + 'px'; };
    const row = (kind, x) => {
      const r = document.createElement('div');
      r.className = kind === 'tar' ? 'bs-tr' : 'bs-tr bs-sr';
      r.innerHTML = kind === 'tar'
        ? '<input data-f="k" placeholder="мат мес сам"><input data-f="u" placeholder="https://…"><input data-f="p" placeholder="0" inputmode="numeric"><input data-f="n" placeholder="соберётся само"><i title="Удалить">×</i>'
        : '<input data-f="k" placeholder="мат отзывы"><textarea data-f="v" rows="1" placeholder="Текст, можно в несколько строк"></textarea><i title="Удалить">×</i>';
      r.querySelectorAll('[data-f]').forEach(e => { e.value = (x && x[e.dataset.f]) || ''; e.spellcheck = false; });
      lists[kind].appendChild(r);
      return r;
    };
    const val = (r, f) => r.querySelector('[data-f="' + f + '"]').value.trim();
    const check = r => {
      const kind = r.classList.contains('bs-sr') ? 'snip' : 'tar';
      const any = [...r.querySelectorAll('[data-f]')].some(e => e.value.trim());
      const ok = kind === 'tar' ? val(r, 'k') && /^https?:\/\/\S+$/.test(val(r, 'u')) : val(r, 'k') && val(r, 'v');
      r.classList.toggle('bs-bad', !!any && !ok);
      return ok;
    };
    let tm;
    const save = () => {
      if (!wrap.isConnected) return;
      const tar = [...lists.tar.children].filter(check).map(r => ({ k: val(r, 'k'), u: val(r, 'u'), p: val(r, 'p').replace(/\s/g, ''), n: val(r, 'n') }));
      const sn = [...lists.snip.children].filter(check).map(r => ({ k: val(r, 'k'), v: val(r, 'v') }));
      jset(TAR_KEY, tar); jset(SNIP_KEY, sn);
      const bad = wrap.querySelectorAll('.bs-bad').length;
      st.className = 'bs-tar-st' + (bad ? ' bs-warn' : '');
      st.textContent = bad ? 'Не сохранено строк: ' + bad + ' – заполни сокращение и ссылку' : '✓ Сохранено';
    };
    jget(TAR_KEY, []).forEach(t => row('tar', t));
    jget(SNIP_KEY, []).forEach(t => row('snip', t));
    const file = wrap.querySelector('input[type=file]');
    file.addEventListener('change', () => { clearTimeout(tm); const f = file.files[0]; file.value = ''; if (f) f.text().then(t => { if (tarImport(t)) { closeTariffs(); openTariffs(); } }); });
    if (!lists.tar.children.length) row('tar');
    if (!lists.snip.children.length) row('snip');
    requestAnimationFrame(() => wrap.querySelectorAll('textarea').forEach(grow));
    wrap.addEventListener('input', ev => {
      if (ev.target === file) return;
      if (ev.target.matches('textarea')) grow(ev.target);
      const r = ev.target.closest('.bs-tr');
      if (r && r.classList.contains('bs-bad')) check(r);
      clearTimeout(tm); tm = setTimeout(save, 400);
    });
    wrap.addEventListener('click', ev => {
      const t = ev.target, tab = t.dataset.tab, add = t.dataset.add;
      if (t.dataset.x) { clearTimeout(tm); save(); return t.dataset.x === 'out' ? tarExport() : file.click(); }
      if (t.matches('.bs-rep-head i')) closeTariffs();
      else if (tab) {
        wrap.querySelectorAll('[data-tab]').forEach(e => e.classList.toggle('bs-on', e === t));
        wrap.querySelectorAll('[data-pane]').forEach(e => { e.hidden = e.dataset.pane !== tab; });
        wrap.querySelectorAll('textarea').forEach(grow);
      } else if (add) {
        const r = row(add);
        r.querySelector('[data-f]').focus();
        lists[add].scrollTop = lists[add].scrollHeight;
      } else if (t.matches('.bs-tr:not(.bs-th) > i')) {
        const r = t.closest('.bs-tr');
        if ([...r.querySelectorAll('[data-f]')].some(e => e.value.trim()) && !confirm('Удалить «' + (val(r, 'k') || 'строку') + '»?')) return;
        r.remove(); save();
      }
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeTariffs(); });
  }

  function tariffsInit() {
    document.addEventListener('input', tarOnInput, true);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeTariffs(); });
    const st = document.createElement('style');
    st.textContent =
      '#bsTarWrap{position:fixed;inset:0;z-index:3100;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}' +
      '#bsTar{width:780px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:14px 16px;border-radius:14px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
      '.bs-tar-help{font-size:12px;line-height:1.5;color:var(--bs-muted,#888);margin-bottom:8px}' +
      '.bs-tar-help code{padding:0 4px;border-radius:4px;background:var(--bs-hover,#f3f5f8);color:var(--bs-text,#222)}' +
      '.bs-tr{display:grid;grid-template-columns:120px minmax(0,1fr) 76px 170px 24px;gap:6px;align-items:start;margin-bottom:6px}' +
      '.bs-tr.bs-sr{grid-template-columns:150px minmax(0,1fr) 24px}' +
      '.bs-th{margin-bottom:4px;font-size:11.5px;color:var(--bs-muted,#888)}.bs-th span{padding-left:2px}' +
      '.bs-tbody{max-height:min(420px,calc(100vh - 300px));overflow:auto;padding-right:2px}' +
      '.bs-tr input,.bs-tr textarea{width:100%;min-width:0;box-sizing:border-box;height:30px;padding:5px 8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);font:inherit;font-size:12.5px;outline:none;resize:none;line-height:18px}' +
      '.bs-tr input[data-f="u"]{color:var(--bs-muted,#888)}.bs-tr input[data-f="p"]{text-align:right;font-variant-numeric:tabular-nums}' +
      '.bs-tr input:focus,.bs-tr textarea:focus{border-color:var(--bs-accent,#3b82f6);color:var(--bs-text,#222)}' +
      '.bs-tr.bs-bad input[data-f="k"],.bs-tr.bs-bad input[data-f="u"],.bs-tr.bs-bad textarea{border-color:#e04848}' +
      '.bs-tr > i{font-style:normal;height:30px;display:flex;align-items:center;justify-content:center;border-radius:7px;color:var(--bs-muted,#888);cursor:pointer;font-size:17px}' +
      '.bs-tr > i:hover{background:rgba(224,72,72,.12);color:#e04848}' +
      '.bs-tar-add{margin-top:2px;padding:5px 10px;border:1px dashed var(--bs-border,#D9E0E7);border-radius:7px;background:none;color:var(--bs-accent,#3b82f6);font-size:12.5px;cursor:pointer}' +
      '.bs-tar-add:hover{background:var(--bs-hover,#f5f7fa)}' +
      '.bs-tar-foot{display:flex;align-items:center;gap:10px;margin-top:12px;font-size:11.5px}.bs-tar-note{color:var(--bs-muted,#888)}' +
      '.bs-tar-st{margin-left:auto;font-size:12px;color:#1f9d55}.bs-tar-st.bs-warn{color:#e04848}' +
      '.bs-tar-foot button{padding:5px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:none;color:var(--bs-text,#222);font:inherit;font-size:12px;cursor:pointer}' +
      '.bs-tar-foot button:hover{background:var(--bs-hover,#f5f7fa)}' +
      '.bs-tar-tabs{margin-bottom:10px}.bs-sale-share[hidden],#bsSale button[hidden]{display:none!important}.bs-tar-pane[hidden]{display:none}' +
      '#bsTarHint{position:fixed;z-index:2500;display:none;max-width:520px;padding:6px 10px;border-radius:9px;font-size:12.5px;background:rgba(229,62,62,.95);color:#fff;box-shadow:0 4px 14px rgba(0,0,0,.18)}' +
      '#bsTarHint.bs-ok{background:rgba(34,165,90,.95)}';
    document.head.appendChild(st);
  }
  document.addEventListener('DOMContentLoaded', tariffsInit);

  // ---------- Продажи за смену: окно продажи и текст для Telegram ----------
  // Продажа хранится за день (bsSales); доля и «цена × доля» сразу идут в отчёт («Продано», «Сумма продаж»).
  const SALES_KEY = 'bsSales';
  const MONTHS = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
  const SHARES = [[1, '1'], [0.5, '½'], [0.33, '⅓'], [0.25, '¼']];
  const shareFor = n => n >= 4 ? 0.25 : n === 3 ? 0.33 : n === 2 ? 0.5 : 1;
  const rub = n => String(Math.round(+n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  const esc = t => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  function salesGet() {
    let r = jget(SALES_KEY, {});
    if (r.d && r.d !== ddmm(new Date()) && histRoll()) r = jget(SALES_KEY, {});
    return r.d === ddmm(new Date()) ? r.list || [] : [];
  }
  // ---------- История смен: закрытая смена (кнопкой или сменой даты) уходит в архив bsHistory ----------
  const HIST_KEY = 'bsHistory', HIST_MAX = 180;
  const histGet = () => jget(HIST_KEY, []);
  // моя смена или нет (моя продажа может закрыться и в чужую смену). mine ставится при закрытии дня:
  // «Закрыть смену» – моя, день закрылся сам – не моя (или как отметили руками). Старые смены и импорт –
  // по работе за день: были мои лиды, чаты или ссылки – значит, моя
  const MINE_KEY = 'bsShiftMine';
  const shiftMine = e => e.mine != null ? !!e.mine : ['leads', 'blocks', 'chats', 'links'].some(k => +(e.rep || {})[k] > 0);
  const curMine = () => { const m = jget(MINE_KEY, {}); return m.d === ddmm(new Date()) ? !!m.v : null; };
  const repHas = r => ['bought', 'sum', 'links', 'leads'].some(k => +r[k]);
  // в архив – только то, что нужно для статистики, без лишних полей
  const histSale = x => ({ id: x.id, dlg: x.dlg, name: x.name, price: x.price, disc: x.disc, mops: x.mops, share: x.share, cnt: x.cnt, fio: x.fio, who: x.who, email: x.email, pay: x.pay, prem: x.prem, premM: x.premM, sh: x.sh, shT: x.shT, shAlso: x.shAlso });
  const histRep = r => { const o = {}; ['leads', 'blocks', 'chats', 'links', 'bought', 'sum', 'rem'].forEach(k => { if (r[k] != null && r[k] !== '') o[k] = +r[k] || 0; }); return o; };
  // true – если запись получилась (если место в браузере кончилось – выкидываем самые старые смены)
  function histPush(e) {
    const h = histGet();
    h.push(e);
    while (h.length > HIST_MAX) h.shift();
    for (;;) {
      try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); return true; } catch (err) { if (h.length <= 1) return false; h.shift(); }
    }
  }
  // данные за прошлые даты (или текущая смена при «Начать новую смену») – в архив, потом очищаем
  function histRoll(all) {
    const today = ddmm(new Date());
    const r = jget(REP_KEY, {}), sl = jget(SALES_KEY, {});
    const rOld = r.d && (all || r.d !== today) && repHas(r), sOld = sl.d && (all || sl.d !== today) && (sl.list || []).length;
    if (!rOld && !sOld) {
      if (r.d && r.d !== today) jset(REP_KEY, { d: today });
      if (sl.d && sl.d !== today) jset(SALES_KEY, { d: today, list: [] });
      return false;
    }
    const days = [...new Set([rOld && r.d, sOld && sl.d].filter(Boolean))];
    for (const d of days) {
      const hasRep = rOld && r.d === d;
      const e = { d, end: Date.now(), rep: hasRep ? histRep(r) : {}, sales: sOld && sl.d === d ? sl.list.map(histSale) : [], text: hasRep ? r.text || repText(r, repFem()) : '' };
      // день сменился сам, без «Закрыть смену» – лиды и чаты досчитает repAuto
      if (!all) Object.assign(e, { fix: 1 }, hasRep && r.text != null ? { own: 1 } : {});
      const mk = jget(MINE_KEY, {});
      e.mine = mk.d === d ? !!mk.v : !!all;
      const ok = histPush(e);
      if (!ok) return false;   // не влезло – ничего не стираем
    }
    if (rOld || r.d !== today) jset(REP_KEY, { d: today });
    if (sOld || sl.d !== today) jset(SALES_KEY, { d: today, list: [] });
    return true;
  }
  function salesSet(list) { jset(SALES_KEY, { d: ddmm(new Date()), list }); }
  function sumAdd(x) {
    if (!x) return;
    const r = repSaved();
    jset(REP_KEY, Object.assign(r, { sum: Math.max(0, Math.round((+r.sum || 0) + x)) }));
    const i = document.querySelector('#bsRep input[data-k="sum"]');
    if (i) { i.value = +repSaved().sum || 0; i.dispatchEvent(new Event('input', { bubbles: true })); }
  }
  // название тарифа для отчёта: своё из 4-го столбца или собранное из слов; у брони – месяц покупки
  function tarName(t) {
    const tags = tarTags(t.k).tags;
    const subj = tags.has('комбо') ? 'Математика + Русский язык' : tags.has('баз') ? 'Базовая математика' : tags.has('рус') ? 'Русский язык' : tags.has('мат') ? 'Математика' : '';
    const cur = tags.has('сам') ? ' (самоподготовка)' : tags.has('кур') ? ' (с куратором)' : '';
    const name = t.n || ('Годовой курс ЕГЭ' + (subj ? ' | ' + subj + cur : ''));
    return name + (tags.has('бронь') ? ' | ' + MONTHS[new Date().getMonth()] : '');
  }
  // теги клиента из карточки справа (запасной вариант – теги активного чата в списке)
  function clientTags() {
    let items = [...document.querySelectorAll('#customer-data .tag-selectize-item')];
    if (!items.length) items = [...document.querySelectorAll('.dialogs_list_item.active .tags span')];
    return items.map(e => { const c = e.cloneNode(true); c.querySelectorAll('a,.remove').forEach(x => x.remove()); return c.textContent.replace(/×/g, '').trim(); }).filter(Boolean);
  }
  const joinMops = m => m.length < 3 ? m.join(' и ') : m.join(', ');
  function saleText(x) {
    const who = [x.email, x.fio, x.nick].map(v => (v || '').trim()).filter(Boolean);
    return [
      'https://bluesales.ru/app/messenger/?dialogId=' + x.dlg,
      x.name,
      rub(saleTotal(x)) + ' рублей' + (saleDisc(x) ? ' (скидка ' + rub(saleDisc(x)) + ' ₽)' : ''),
      'МОП: ' + joinMops(x.mops),
      who.join('\n'),
      'Источник: ' + (x.src || ''),
      '"' + (x.quote || '').trim() + '"',
    ].filter(Boolean).join('\n\n');
  }
  const saleDone = x => !!((x.email || '').trim() && (x.fio || '').trim());
  // «я» – выбирается один раз при первом заходе (bsMe); продажа без меня в МОП идёт только текстом в ТГ, в смену не считается
  const meName = () => (MANAGERS.find(m => m[0] === meId()) || [])[1];
  const meSet = () => MANAGERS.some(m => m[0] === localStorage.getItem(ME_KEY));
  const saleMine = x => !meSet() || !x.mops.length || x.mops.includes(meName());
  // доля, которая идёт в отчёт: продажа не на меня (cnt === false) хранится в списке, но не считается
  const saleShare = s => s && s.cnt !== false ? s.share : 0;
  // скидка: число – в рублях, «10%» – процент от цены; итог = цена − скидка, от итога считается отчёт
  function saleDisc(s) {
    const p = +s.price || 0, d = String(s.disc || '').replace(',', '.').trim();
    const v = /%$/.test(d) ? p * (parseFloat(d) || 0) / 100 : parseFloat(d) || 0;
    return Math.round(Math.min(p, Math.max(0, v)));
  }
  const saleTotal = s => Math.max(0, (+s.price || 0) - saleDisc(s));
  // доля 0.33 / 0.67 – это ровно ⅓ / ⅔: сумму и премию делим на число менеджеров, а не умножаем на 0,33
  const shareX = s => Math.abs(s * 3 - Math.round(s * 3)) < 0.02 ? Math.round(s * 3) / 3 : +s || 0;
  const shareHow = s => { if (!(s > 0)) return ''; const n = Math.round(1 / s); return n === 1 ? '' : Math.abs(1 / n - shareX(s)) < 1e-9 ? ' ÷ ' + n : ' × ' + r2s(s); };
  const salePart = s => s ? Math.round(saleTotal(s) * shareX(saleShare(s))) : 0;
  // один раз: суммы смен, посчитанные раньше как × 0,33, переводим на ÷ 3 (история и текущая смена)
  try {
    if (!localStorage.getItem('bsShareFix')) {
      const fix = list => (list || []).reduce((a, x) => a + (x && x.cnt !== false ? salePart(x) - Math.round(saleTotal(x) * (+x.share || 0)) : 0), 0);
      const h = jget(HIST_KEY, []);
      let ch = 0;
      h.forEach(e => { const d = fix(e.sales); if (d && e.rep && e.rep.sum != null) { e.rep.sum = Math.max(0, (+e.rep.sum || 0) + d); ch = 1; } });
      if (ch) jset(HIST_KEY, h);
      const r = jget(REP_KEY, {}), sl = jget(SALES_KEY, {}), d = r.d && r.d === sl.d ? fix(sl.list) : 0;
      if (d && r.sum != null) jset(REP_KEY, Object.assign(r, { sum: Math.max(0, (+r.sum || 0) + d) }));
      localStorage.setItem('bsShareFix', '1');
    }
  } catch (e) {}
  // закрыли окно совсем – раскрытую смену истории не запоминаем (её держит только переход «смена → продажа/отчёт → назад»)
  function closeSale() { const o = document.getElementById('bsSaleWrap'); if (o) o.remove(); histKeep = null; }
  // id – открыть сохранённую продажу; без id – новая в текущем чате
  // fromList – открыли из списка продаж: есть «Назад», после сохранения/удаления – обратно в список
  function openSale(id, fromList) {
    closeSale();
    const list = salesGet(), old = id ? list.find(x => x.id === id) : null;
    const dlg = old ? old.dlg : curDialog();
    if (!dlg) return tarHint('Сначала открой чат клиента');
    const tars = jget(TAR_KEY, []);
    const tags = clientTags();
    const x = old ? Object.assign({}, old) : {
      id: Date.now().toString(36), dlg, t: Date.now(), tar: '', name: '', price: '',
      mops: MANAGERS.map(m => m[1]).filter(n => tags.some(t => norm(t) === norm(n))),
      email: '', fio: '', nick: '',
      src: tags.filter(t => /^источник\s*:/i.test(t)).map(t => t.replace(/^источник\s*:\s*/i, '')).join(', '),
      quote: '',
      who: ((document.querySelector('.dialogs_list_item.active .dialogs_list_person_name') || {}).textContent || '').trim(),
    };
    if (!old) x.share = shareFor(x.mops.length);
    // новую продажу можно отнести к прошлому дню – тогда она уйдёт в смену этого дня в истории, а не в текущую
    const curD = repSaved().d || ddmm(new Date());
    let day = curD;
    const past = () => day !== curD;
    // по этому чату уже есть продажа – в текущей смене или в истории: подсказываем, чтобы не посчитать дважды
    // (доплата/бронь – это нормально, тогда просто заполняем дальше). Новые сверху
    const twins = old ? [] : list.filter(s => s.dlg === dlg).map(s => ({ s, d: curD })).reverse().concat(
      histGet().map((e, hi) => ({ e, hi })).reverse().flatMap(({ e, hi }) => (e.sales || []).map((s, si) => ({ s, d: e.d, hi, end: e.end, si })).filter(o => o.s.dlg === dlg).reverse()));
    const twinBtn = o => o.hi == null ? '<button data-a="twin" data-id="' + o.s.id + '">Открыть</button>' : '<button data-a="htwin" data-hi="' + o.hi + '" data-end="' + o.end + '" data-si="' + o.si + '">Открыть</button>';
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const field = (k, label, ph, tag) => '<label><span>' + label + '</span>' + (tag === 'ta' ? '<textarea data-k="' + k + '" rows="2" placeholder="' + (ph || '') + '"></textarea>' : '<input data-k="' + k + '" placeholder="' + (ph || '') + '"' + (k === 'price' ? ' type="number" min="0"' : '') + '>') + '</label>';
    wrap.innerHTML =
      '<div id="bsSale"><div class="bs-rep-head"><b>' + (old ? 'Продажа' : 'Новая продажа') + (x.who ? ' – ' + esc(x.who) : '') + '</b><i title="Закрыть">×</i></div>' +
      (twins.length ? '<div class="bs-sale-dup bs-sale-dups"><span>По этому чату уже ' + (twins.length > 1 ? 'есть продажи' : 'есть продажа') + '. Если это та же оплата – открой её, чтобы не посчитать дважды. Доплату или бронь заполняй здесь.</span>' +
        twins.slice(0, 3).map(o => '<p><span><b>' + (o.d === curD ? 'сегодня' : o.d.slice(0, 5)) + '</b> – ' + esc(o.s.name || 'без тарифа') + ' · ' + rub(saleTotal(o.s)) + ' ₽</span>' + twinBtn(o) + '</p>').join('') +
        (twins.length > 3 ? '<p><span>и ещё ' + (twins.length - 3) + ' – в «Истории»</span></p>' : '') + '</div>' : '') +
      '<div class="bs-sale-cols"><div class="bs-sale-form">' +
      (old ? '' : '<label><span>Дата продажи</span><input data-k="day" type="date" value="' + isoOf(dmyDate(curD)) + '" max="' + isoOf(new Date()) + '"></label>') +
      '<label><span>Тариф</span><select data-k="tar"><option value="">– выбери –</option>' + tars.map((t, i) => '<option value="' + i + '">' + esc(t.k) + (t.p ? ' · ' + rub(t.p) : '') + '</option>').join('') + '<option value="own">другой (впишу сам)</option></select></label>' +
      field('name', 'Название в отчёте', 'Годовой курс ЕГЭ | …') + field('price', 'Цена, ₽', '0') + field('disc', 'Скидка', '0 – в рублях или 10%') +
      '<label><span>МОП</span><div class="bs-chips" data-g="mops">' + MANAGERS.map(m => '<em data-v="' + m[1] + '">' + m[1] + '</em>').join('') + '</div></label>' +
      '<label class="bs-sale-share"><span>Доля продажи</span><div class="bs-chips" data-g="share">' + SHARES.map(([v, t]) => '<em data-v="' + v + '">' + t + '</em>').join('') + '</div></label>' +
      payChips() + field('email', 'Почта', 'когда пришлёт') + field('fio', 'Имя и фамилия', 'когда пришлёт') + field('nick', 'Ник', '@…') +
      field('src', 'Источник', 'из тегов или вручную') + field('quote', 'Откуда узнал о нас', 'своими словами клиента', 'ta') +
      '</div><div class="bs-sale-prev"><span>Текст для Telegram</span><textarea readonly spellcheck="false"></textarea><div class="bs-sale-note"></div></div></div>' +
      '<div class="bs-rep-btns">' + (old ? '<button data-a="del" class="bs-sale-del">Удалить</button>' : '') + '<span class="bs-tar-st"></span>' + (fromList ? '<button data-a="back">Назад</button>' : '') + '<button data-a="save">Сохранить</button><button data-a="copy" class="bs-main">Сохранить и скопировать</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsSale'), prev = box.querySelector('.bs-sale-prev textarea'), note = box.querySelector('.bs-sale-note');
    const inp = k => box.querySelector('[data-k="' + k + '"]');
    ['name', 'price', 'disc', 'email', 'fio', 'nick', 'src', 'quote'].forEach(k => { inp(k).value = x[k] == null ? '' : x[k]; });
    inp('tar').value = x.tar;
    const paint = () => {
      box.querySelectorAll('[data-g="mops"] em').forEach(e => e.classList.toggle('bs-on', x.mops.includes(e.dataset.v)));
      box.querySelectorAll('[data-g="share"] em').forEach(e => e.classList.toggle('bs-on', +e.dataset.v === x.share));
      prev.value = saleText(x);
      const mine = saleMine(x);
      box.querySelector('.bs-sale-share').hidden = !mine;
      payPaint(box, x, mine);
      premPaint(box, x, old, ymOf(day), mine);
      if (!mine) return void (note.textContent = 'Продажа не на тебя (' + meName() + ') – будет в списке продаж, чтобы дописать данные, но в «Продано» и сумму не пойдёт.');
      const part = Math.round(saleTotal(x) * shareX(x.share));
      note.textContent = (meSet() ? '' : 'Не выбрано, кто ты («Продажи за смену» → «Я: …») – считаю продажу твоей. ') + (past() ? 'В смену ' + day.slice(0, 5) + ' в истории' : 'В отчёт смены') + ': продано +' + String(x.share).replace('.', ',') + ', сумма +' + rub(part) + ' ₽' + (saleDone(x) ? '' : ' · почту и имя можно дописать потом');
    };
    box.addEventListener('input', ev => {
      const k = ev.target.dataset.k;
      if (!k || k === 'tar') return;
      if (k === 'day') {
        const v = ev.target.value && new Date(ev.target.value + 'T00:00');
        day = v && !isNaN(v) && v <= new Date() ? ddmm(v) : curD;
        box.querySelector('[data-a="copy"]').textContent = past() ? 'Добавить в ' + day.slice(0, 5) + ' и скопировать' : 'Сохранить и скопировать';
        return paint();
      }
      x[k] = ev.target.value;
      paint();
    });
    inp('tar').addEventListener('change', ev => {
      x.tar = ev.target.value;
      const t = tars[+x.tar];
      if (t && x.tar !== 'own') { x.name = tarName(t); x.price = t.p; inp('name').value = x.name; inp('price').value = x.price; }
      else if (x.tar === 'own') inp('name').focus();
      paint();
    });
    const save = () => {
      const same = twins.filter(o => o.d === day || Math.abs(saleTotal(o.s) - saleTotal(x)) < 1);
      if (same.length && !confirm('По этому чату уже есть ' + (same.length > 1 ? 'продажи' : 'продажа') + ':\n' + same.map(o => '• ' + o.d.slice(0, 5) + ' – ' + (o.s.name || 'без тарифа') + ' · ' + rub(saleTotal(o.s)) + ' ₽').join('\n') +
        '\n\nЕсли это та же оплата – нажми «Отмена» и открой её. Добавить ещё одну (доплата, бронь)?')) return false;
      if (past()) {
        x.cnt = saleMine(x);
        premSave(x, null, ymOf(day));
        if (!histAddDay(day, [x])) return false;
        box.querySelector('.bs-tar-st').textContent = 'Добавлено в ' + day.slice(0, 5);
        return true;
      }
      const all = salesGet(), i = all.findIndex(s => s.id === x.id), was = i >= 0 ? all[i] : null;
      x.cnt = saleMine(x);
      premSave(x, was, ymOf(day));
      const dShare = r2(saleShare(x) - saleShare(was));
      if (dShare) soldAdd(dShare);
      sumAdd(salePart(x) - salePart(was));
      if (i >= 0) all[i] = x; else all.push(x);
      salesSet(all);
      box.querySelector('.bs-tar-st').textContent = 'Сохранено';
      return true;
    };
    const saved = () => past() ? '✓ Продажа добавлена в смену ' + day.slice(0, 5) + ' (История)' : '✓ Продажа сохранена';
    box.addEventListener('click', ev => {
      const em = ev.target.closest('em'), a = ev.target.dataset.a;
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      if (em) {
        const g = em.parentNode.dataset.g, v = em.dataset.v;
        if (g === 'mops') {
          x.mops = x.mops.includes(v) ? x.mops.filter(m => m !== v) : MANAGERS.map(m => m[1]).filter(n => n === v || x.mops.includes(n));
          x.share = shareFor(x.mops.length);   // доля – от числа МОП, потом можно поправить вручную
        } else if (g === 'pay') x.pay = v;
        else x.share = +v;
        paint();
      } else if (a === 'back') openSales();
      else if (a === 'twin') openSale(ev.target.dataset.id, fromList);
      else if (a === 'htwin') openHistSale(+ev.target.dataset.hi, ev.target.dataset.end, +ev.target.dataset.si);
      else if (a === 'save') { if (!x.name) return inp('tar').focus(); if (!save()) return; fromList ? openSales() : closeSale(); tarHint(saved(), true); }
      else if (a === 'copy') {
        if (!x.name) return inp('tar').focus();
        if (!save()) return;
        navigator.clipboard.writeText(prev.value).then(() => { closeSale(); tarHint(x.cnt ? saved() + ', текст скопирован' : '✓ Сохранено без учёта в сумме, текст скопирован', true); });
      } else if (a === 'del') {
        if (!confirm('Удалить эту продажу? Доля и сумма уйдут из отчёта смены.')) return;
        saleDel(x.id);
        fromList ? openSales() : closeSale();
      }
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
    paint();
  }
  // список продаж за сегодня – клик открывает продажу, чтобы дописать данные
  function saleDel(id) {
    const all = salesGet(), was = all.find(s => s.id === id);
    if (was) { if (saleShare(was)) soldAdd(-saleShare(was)); sumAdd(-salePart(was)); salesSet(all.filter(s => s.id !== id)); }
  }
  // новая смена: обнуляем отчёт (продано, сумма, ссылки, правки текста) и список продаж
  function newShift() {
    histRoll(true);
    jset(REP_KEY, { d: ddmm(new Date()) });
    salesSet([]);
    paintSold(); paintLinks();
  }
  // закрыть смену: досчитываем лиды и чаты за день, собираем отчёт – смена вместе с ним уходит в историю
  async function countDay(d, m) {
    const form = await clientsForm();
    const [leads, blocks, chats] = await Promise.all([
      countClients(form, 'psFirstContact', d, d, ST_ALL, m),
      countClients(form, 'psFirstContact', d, d, ST_BLOCK, m),
      countClients(form, 'psLastContact', d, d, ST_ALL, m),
    ]);
    return { leads, blocks, chats };
  }
  // отчёт сам: пока открыта CRM, цифры дня обновляются в фоне, а смену, закрытую сменой даты, досчитываем.
  // Лиды и блоки за прошлый день считаются точно; чаты задним числом занижаются (у клиента уже новый «последний контакт»),
  // поэтому для чатов берём большее из последнего фонового подсчёта и пересчёта
  const AUTO_KEY = 'bsRepAuto', AUTO_EVERY = 25 * 60e3;
  let autoBusy = false, autoFail = 0;
  async function repAuto() {
    if (autoBusy || Date.now() - autoFail < 5 * 60e3) return;
    autoBusy = true;
    try {
      const e = histGet().find(x => x.fix);
      if (e) {
        const got = await countDay(e.d, meId());
        const h = histGet(), e2 = h.find(x => x.fix && x.end === e.end && x.d === e.d);
        if (e2) {
          Object.assign(e2.rep, { leads: got.leads, blocks: got.blocks, chats: Math.max(+e2.rep.chats || 0, got.chats) });
          if (e2.rep.rem == null) e2.rep.rem = 0;
          if (!e2.own) e2.text = repText(e2.rep, repFem());
          delete e2.fix; delete e2.own;
          histSave(h);
        }
      }
      const tabOpen = () => !!document.querySelector('.bs-tab #bsRep');   // вкладка «Отчёт» считает сама
      if (Date.now() - (jget(AUTO_KEY, {}).at || 0) >= AUTO_EVERY && !tabOpen()) {
        jset(AUTO_KEY, { at: Date.now() });   // сразу – чтобы другая вкладка CRM не считала то же самое
        const d = repSaved().d, got = await countDay(d, meId());
        const r = repSaved();   // перечитываем: пока считали, могли добавить ссылку или продажу
        if (r.d === d && !tabOpen()) { Object.assign(r, got); if (r.rem == null) r.rem = 0; jset(REP_KEY, r); }
      }
    } catch (err) { autoFail = Date.now(); }
    autoBusy = false;
  }
  async function closeShift(btn) {
    if (btn) { btn.disabled = true; btn.textContent = 'Считаю отчёт…'; }
    const d = repSaved().d, m = meId();
    let got = null;
    try { got = await countDay(d, m); } catch (e) {}
    // перечитываем: пока считали, могли нажать «+» у ссылок или добавить продажу
    const r = repSaved();
    if (got) Object.assign(r, got);
    if (r.rem == null) r.rem = 0;
    jset(REP_KEY, r);
    const before = histGet().length;
    newShift();
    const h = histGet(), e = h[h.length - 1];
    tarHint('✓ Смена закрыта, отчёт сохранён в истории', true);
    if (h.length > before && e.d === d) return openHistReport(h.length - 1, e.end, got ? '' : 'Лиды и чаты не посчитались – поправь их в тексте вручную', true);
    openSales('hist');
  }
  // отчёт закрытой смены: текст можно поправить (сохраняется в истории) и скопировать
  // send – сразу после «Закрыть смену»: продажи с моей долей уходят в таблицу (если подключена)
  function openHistReport(hi, end, warn, send) {
    const h = histGet(), e = h[hi];
    if (!e || String(e.end) !== String(end)) return openSales('hist');
    closeSale();
    histKeep = hi + ':' + end;
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-sales bs-hrep"><div class="bs-rep-head"><b>Отчёт за ' + e.d + '</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-rep-status"></div><div class="bs-hrep-sheet" hidden></div><div class="bs-hrep-sheet bs-hrep-team" hidden></div><textarea spellcheck="false"></textarea>' +
      '<div class="bs-rep-btns"><button data-a="back">К истории</button><button data-a="copy" class="bs-main">Скопировать</button></div></div>';
    document.body.appendChild(wrap);
    const ta = wrap.querySelector('textarea'), status = wrap.querySelector('.bs-rep-status');
    if (warn) { status.dataset.st = 'err'; status.innerHTML = '<i></i><span></span>'; status.querySelector('span').textContent = warn; }
    ta.value = e.text || repText(e.rep || {}, repFem());
    const sl = wrap.querySelector('.bs-hrep-sheet'), tl = wrap.querySelector('.bs-hrep-team');
    let wait = Promise.resolve();
    if (send && sheetUrl() && e.sales.some(toSheet)) {
      sl.hidden = false; sl.textContent = 'Переношу продажи в таблицу…';
      wait = sheetSend(hi, end).then(st => { sl.textContent = 'Таблица: ' + sheetMsg(st); sl.dataset.st = st.err.length ? 'err' : 'ok'; })
        .catch(err => { sl.textContent = 'В таблицу не ушло: ' + err.message + '. Потом – «В таблицу» в истории.'; sl.dataset.st = 'err'; });
    }
    // цифры дня – в таблицу отдела (после своей таблицы: скрипт один)
    if (send && teamOn()) {
      tl.hidden = false; tl.textContent = 'Пишу в таблицу отдела…';
      wait.then(() => teamCloseDay(e.d)).then(m => { tl.textContent = 'Отдел: ' + m; tl.dataset.st = /⚠|не тронул|нет столбца|формула/.test(m) ? 'err' : 'ok'; })
        .catch(err => { tl.textContent = 'В таблицу отдела не ушло: ' + err.message + '. Потом – «В отдел» в истории.'; tl.dataset.st = 'err'; });
    }
    ta.addEventListener('input', () => {
      const h2 = histGet(), e2 = h2[hi];
      if (e2 && String(e2.end) === String(end)) { e2.text = ta.value; if (e2.fix) e2.own = 1; histSave(h2); }
    });
    wrap.addEventListener('click', ev => {
      const t = ev.target, a = t.dataset.a;
      if (t.matches('.bs-rep-head i')) return closeSale();
      if (a === 'back') return openSales('hist');
      if (a === 'copy') navigator.clipboard.writeText(ta.value).then(() => {
        t.textContent = 'Скопировано ✓';
        setTimeout(() => { t.textContent = 'Скопировать'; }, 1500);
      });
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  // ---------- Окно «Смена»: вкладки «Сегодня» (продажи текущей смены), «Отчёт» (за день) и «История» (архив смен) ----------
  const dmyDate = d => { const [a, b, c] = String(d).split('.'); return new Date(+c, b - 1, +a); };
  const isoOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fromIso = s => { const [y, m, d] = String(s).split('-'); return y && m && d ? new Date(+y, m - 1, +d) : null; };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const r2s = n => String(Math.round((+n || 0) * 100) / 100).replace('.', ',');
  // доли продаж дробью: 0,5 → ½, 23,33 → 23⅓; что не похоже на дробь – числом
  const FRACS = [[0.25, '¼'], [0.33, '⅓'], [0.5, '½'], [0.67, '⅔'], [0.75, '¾']];
  const frac = n => {
    n = Math.round((+n || 0) * 100) / 100;
    let w = Math.floor(n), f = Math.round((n - w) * 100) / 100;
    if (f >= 0.98) { w++; f = 0; }
    if (!f) return String(w);
    const hit = FRACS.find(([v]) => Math.abs(v - f) < 0.015);
    return hit ? (w || '') + hit[1] : r2s(n);
  };
  // период истории помнится, пока открыта страница
  const histPer = { p: '7', from: null, to: null };
  function histRange() {
    const t = new Date(); t.setHours(0, 0, 0, 0);
    const back = n => new Date(t.getFullYear(), t.getMonth(), t.getDate() - n);
    if (histPer.p === '7') return [back(6), t];
    if (histPer.p === '30') return [back(29), t];
    if (histPer.p === 'month') return [new Date(t.getFullYear(), t.getMonth(), 1), t];
    if (histPer.p === 'all') return [null, null];
    return [histPer.from, histPer.to];
  }
  // все смены (архив + текущая), новые сверху
  function histAll() {
    const cur = repSaved(), curSales = salesGet();
    const all = histGet().map((e, hi) => Object.assign({ hi }, e));
    if (repHas(cur) || curSales.length || curMine() != null) all.push(Object.assign({ d: ddmm(new Date()), now: true, end: Date.now(), rep: histRep(cur), sales: curSales }, curMine() != null ? { mine: curMine() } : {}));
    return all.sort((a, b) => dmyDate(b.d) - dmyDate(a.d) || b.end - a.end);
  }
  function histSave(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); return true; } catch (e) { alert('Не хватило места в браузере – скачай резервную копию и удали старые смены.'); return false; }
  }
  // продажи за прошлую дату – в смену этой даты в архиве (если её нет – создаём)
  const histAddDay = (d, xs) => histAddDays([[d, xs]]);
  // то же сразу за несколько дат: [[дата, продажи], …] – одним сохранением
  function histAddDays(days) {
    const h = histGet();
    days.forEach(([d, xs]) => {
      let e = h.filter(x => x.d === d).pop();
      if (!e) { e = { d, end: dmyDate(d).getTime() + 86399000, rep: {}, sales: [] }; h.push(e); }
      xs.forEach(x => {
        e.sales.push(histSale(x));
        e.rep.bought = Math.round(((+e.rep.bought || 0) + saleShare(x)) * 100) / 100;
        e.rep.sum = (+e.rep.sum || 0) + salePart(x);
      });
    });
    return histSave(h);
  }
  const statsHtml = a => '<div class="bs-stats">' + a.map(([k, v]) => '<div><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>';
  const SHIFT_TABS = [['shift', 'Сегодня'], ['rep', 'Отчёт'], ['hist', 'История']];
  function openSales(tab) {
    const keep = histKeep;
    closeSale();
    histKeep = tab === 'hist' ? keep : null;
    tab = SHIFT_TABS.some(x => x[0] === tab) ? tab : 'shift';
    premAll();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-sales"><div class="bs-rep-head"><b>Смена' + (tab === 'shift' ? '<small class="bs-head-d">' + WD[new Date().getDay()] + ', ' + ddmm(new Date()).slice(0, 5) + '</small>' : '') + '</b>' +
      '<span class="bs-seg">' + SHIFT_TABS.map(([k, t]) => '<em data-tab="' + k + '"' + (tab === k ? ' class="on"' : '') + '>' + t + '</em>').join('') + '</span>' +
      '<i title="Закрыть">×</i></div><div class="bs-tab"></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('.bs-tab');
    ({ shift: paintShift, rep: paintReport, hist: paintHist })[tab](box);
    // KPI из таблицы ОКК пришёл новый – перерисовать премию
    okkPaint = () => { if (!box.isConnected) return; if (tab === 'shift') paintShift(box); if (tab === 'hist') histPaint(); };
    okkSync();
    wrap.addEventListener('mouseover', ev => {
      const pm = ev.target.closest && ev.target.closest('.bs-pm'), tip = pm && pm.querySelector('.bs-ptip');
      if (!tip) return;
      const r = pm.getBoundingClientRect(), h = tip.offsetHeight, w = tip.offsetWidth;
      tip.style.left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8)) + 'px';
      tip.style.top = (r.bottom + 6 + h < innerHeight - 8 ? r.bottom + 6 : Math.max(8, r.top - h - 6)) + 'px';
    });
    wrap.addEventListener('click', ev => {
      const t = ev.target;
      if (t.matches('.bs-rep-head i')) return closeSale();
      if (t.dataset.tab && t.dataset.tab !== tab) return openSales(t.dataset.tab);
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  // цель на месяц – сколько продаж (доли считаются); помнится по месяцам, новый месяц берёт прошлую цель
  const GOAL_KEY = 'bsGoal';
  const ymNow = () => { const d = new Date(); return d.getFullYear() * 100 + d.getMonth() + 1; };
  const goalGet = () => { const g = jget(GOAL_KEY, {}); return +(g.m && g.m[ymNow()]) || +g.n || 0; };
  const goalSet = n => { const g = jget(GOAL_KEY, {}); g.m = g.m || {}; g.m[ymNow()] = n; g.n = n; jset(GOAL_KEY, g); };
  // верх вкладки «Сегодня»: кольцо цели месяца, твоя доля за сегодня, справа – месяц
  // коэффициенты к премии за месяц (как в таблице, перемножаются): за качество – KPI из таблицы ОКК (bsKpi – последнее, что прочитали),
  // за выполнение плана – продано за месяц / цель месяца в помощнике
  const KPI_KEY = 'bsKpi';
  const goalFor = ym => { const g = jget(GOAL_KEY, {}); return +(g.m && g.m[ym]) || +g.n || 0; };
  const kpiGet = ym => { const v = jget(KPI_KEY, {})[ym]; return v == null ? null : +v; };
  const kq = n => String(n).replace('.', ',');
  function premK(ym) {
    const kpi = kpiGet(ym), goal = goalFor(ym);
    const sold = Math.round(histAll().filter(e => ymOf(e.d) === ym).reduce((a, e) => a + (+e.rep.bought || 0), 0) * 100) / 100;
    const plan = goal ? Math.round(sold / goal * 1000) / 10 : null;
    const q = kpi == null ? 1 : kpi < 70 ? 0.9 : kpi < 97 ? 1 : 1.1, pl = plan == null ? 1 : plan < 80 ? 0.9 : plan < 150 ? 1 : 1.1;
    return { kpi, plan, sold, goal, q, p: pl, k: Math.round(q * pl * 100) / 100 };
  }
  // премия за месяц: посчитанная помощником (p = premSum) × коэффициенты и из таблицы (N1) – если обе, сверяем
  // (в таблице коэффициенты появляются в конце месяца – сходится и без них)
  function premMonHtml(p, tab, lbl, ym) {
    if (!p && tab == null) return '';
    const c = p && premK(ym), v = p && Math.round(p.v * c.k * 100) / 100;
    const okF = p && tab != null && Math.abs(v - tab) < 0.5, okB = p && tab != null && !okF && Math.abs(p.v - tab) < 0.5;
    const bad = p && tab != null && !okF && !okB;
    if (!p) return '<div title="В твоей таблице (ячейка N1)"><span>' + lbl + '</span><b class="bs-ok">' + rubK(tab) + ' ₽</b></div>';
    // подсказка – своя карточка (не серый title): строки «что – сколько», коэффициенты цветом
    const cls = x => x > 1 ? 'up' : x < 1 ? 'down' : '', row = (a, b, c) => '<p' + (c ? ' class="' + c + '"' : '') + '><i>' + a + '</i><em>' + b + '</em></p>';
    const pl = c.plan == null ? 'цель не задана' : Math.floor(c.plan) + '% (' + frac(c.sold) + ' из ' + c.goal + (ym === ymNow() ? ', месяц идёт' : '') + ')';
    const tip = '<section class="bs-ptip">' + row('По продажам', rubK(p.v) + ' ₽') +
      (p.miss ? '<p class="bs-pt-n">без премии ещё ' + p.miss + ' ' + plural(p.miss, 'продажа', 'продажи', 'продаж') + '</p>' : '') +
      row('Качество · ' + (c.kpi != null ? 'KPI ' + kq(c.kpi) + '%' : 'KPI нет'), '×' + kq(c.q), 'bs-pt-k ' + cls(c.q)) +
      (c.kpi == null ? '<p class="bs-pt-n">' + (okkOn() ? 'в таблице ОКК нет KPI за этот месяц' : 'подключи таблицу ОКК в «Таблицах»') + '</p>' : '') +
      row('План · ' + pl, '×' + kq(c.p), 'bs-pt-k ' + cls(c.p)) +
      (c.plan == null ? '<p class="bs-pt-n">задай цель – клик по кольцу во вкладке «Сегодня»</p>' : '') +
      row('Итого', rubK(v) + ' ₽', 'bs-pt-t') +
      (tab != null ? row('В таблице (N1)', rubK(tab) + ' ₽', 'bs-pt-tab') +
        '<p class="bs-pt-n ' + (bad ? 'bad' : 'ok') + '">' + (okF ? '✓ сходится' : okB ? '✓ сходится без коэффициентов – их ставят в конце месяца' : '≠ не сходится') + '</p>' : '') + '</section>';
    const chip = (t, x, none) => '<em class="' + (none ? 'no' : cls(x)) + '">' + t + (none ? ' ?' : ' ×' + kq(x)) + '</em>';
    return '<div class="bs-pm"><span>' + lbl + '</span><b class="' + (bad || p.miss ? 'bs-warn' : 'bs-ok') + '">' + rubK(v) + ' ₽' + (bad ? ' ≠' : p.miss ? ' ?' : '') + '</b>' +
      '<small class="bs-kpi">' + chip('KPI', c.q, c.kpi == null) + chip('план', c.p, c.plan == null) + '</small>' + tip + '</div>';
  }
  function heroHtml(r) {
    const now = new Date(), mon = MONTHS[now.getMonth()];
    const month = histAll().filter(e => { const x = dmyDate(e.d); return x.getFullYear() === now.getFullYear() && x.getMonth() === now.getMonth(); });
    const mb = Math.round(month.reduce((a, e) => a + (+e.rep.bought || 0), 0) * 100) / 100, ms = month.reduce((a, e) => a + (+e.rep.sum || 0), 0);
    const goal = goalGet(), p = goal ? Math.min(1, mb / goal) : 0, C = 2 * Math.PI * 34, left = Math.max(0, Math.round((goal - mb) * 100) / 100);
    const pm = sheetUrl() && sheetTab && sheetTab.months && sheetTab.months.find(m => m.y === now.getFullYear() && m.m === now.getMonth() + 1 && m.prem != null);
    const on = premOn(), pd = premSum(salesGet()), pmo = premSum([].concat(...month.map(e => e.sales || [])));
    return '<div class="bs-hero"><button data-a="goal" class="bs-goal" title="' + (goal ? 'Продано за ' + mon + ': ' + frac(mb) + ' из ' + goal + '. Нажми, чтобы поменять цель' : 'Задать цель на месяц – сколько продаж') + '">' +
        '<svg viewBox="0 0 80 80" width="80" height="80"><circle cx="40" cy="40" r="34"/>' + (p ? '<circle cx="40" cy="40" r="34" class="bs-goal-on" stroke-dasharray="' + (C * p).toFixed(1) + ' ' + C.toFixed(1) + '" transform="rotate(-90 40 40)"/>' : '') + '</svg>' +
        '<b>' + (goal ? Math.floor(p * 100) + '%' : '–') + '</b><small>' + (goal ? 'цели' : 'цель?') + '</small></button>' +
      '<div class="bs-hero-m"><b title="Твоя доля с продаж за сегодня">' + rub(+r.sum || 0) + ' ₽</b>' +
        (on ? '<span class="bs-hero-p" title="Твоя часть премии с продаж за сегодня' + (pd.miss ? '. Без премии ' + pd.miss + ' – открой их и впиши вручную' : '') + '">премия <i>+' + rubK(pd.v) + ' ₽</i>' + (pd.miss ? ' <b class="bs-prem-q">+ ? ×' + pd.miss + '</b>' : '') + '</span>' : '') +
        '<span>продано <i>' + frac(r.bought) + '</i> · ссылок <i>' + (+r.links || 0) + '</i></span>' +
        '<span class="bs-hero-g">' + (!goal ? 'цель на ' + mon + ' не задана' : left ? 'до цели <i>' + frac(left) + '</i> ' + plural(Math.ceil(left), 'продажа', 'продажи', 'продаж') : 'цель на ' + mon + ' выполнена') + '</span></div>' +
      '<div class="bs-hero-r"><div><span>за ' + mon + '</span><b>' + rub(ms) + ' ₽</b></div>' +
        premMonHtml(on ? pmo : null, pm ? pm.prem : null, 'премия за ' + mon, ymNow()) + '</div></div>';
  }
  function paintShift(box) {
    const list = salesGet(), r = repSaved(), now = new Date(), mine = curMine();   // null – не отмечена
    box.innerHTML =
      heroHtml(r) +
      (list.length ? '<div class="bs-sales-list">' + list.map(x =>
        '<div class="bs-sales-row" data-id="' + x.id + '"><b>' + esc(x.who || x.fio || 'чат ' + x.dlg) + (x.mops || []).map(m => '<s class="bs-mop" data-m="' + esc(m) + '">' + esc(m) + '</s>').join('') + '</b><span>' + esc(x.name) + '</span>' +
        '<em>' + rub(saleTotal(x)) + ' ₽ · ' + (x.cnt === false ? '0' : r2s(x.share)) + '</em>' + premTag(x) + (saleDone(x) ? '' : '<u>не заполнено</u>') +
        '<i class="bs-sales-del" title="Удалить продажу">×</i></div>').join('') + '</div>'
        : '<div class="bs-empty">Продаж пока нет.<br>Открой чат клиента и нажми на круг «продано» справа<br>или перенеси продажи из Telegram – кнопка со значком самолётика внизу.</div>') +
      '<div class="bs-foot"><button data-a="me" class="bs-ghost" title="Кто ты – на тебя считаются продажи и отчёт">' + ico(ICO.user) + ' ' + (meSet() ? esc(meName()) : 'Кто я?') + '</button>' +
      '<button data-a="mine" class="bs-ghost bs-mine" data-st="' + (mine == null ? 'wait' : mine ? 'on' : 'off') + '" title="Твоя сегодня смена или нет – отметка для «Истории» (твоя продажа может закрыться и в чужую смену). ' +
        (mine == null ? 'Пока не отмечена: «Закрыть смену» отметит её твоей, а если день закроется сам – не твоей. ' : 'Сохранится, даже если день закроется сам. ') + 'Нажми, чтобы ' + (mine == null ? 'отметить твоей' : 'поменять') + '">' +
        '<i class="bs-sw"></i>Моя смена</button><span></span>' +
      '<button data-a="imp" class="bs-icon" title="Импорт из Telegram – вставить тексты продаж, свои доли попадут в отчёт">' + ico(ICON.send, 16) + '</button>' +
      '<button data-a="shift" class="bs-main" title="Посчитается и сохранится отчёт за день, смена уйдёт в «Историю», а «Продано», сумма, ссылки и список обнулятся">Закрыть смену</button></div>';
    box.onclick = ev => {
      const t = ev.target, a = (t.closest('[data-a]') || t).dataset.a;
      if (a === 'me') return askMe();
      if (a === 'goal') {
        const g = box.querySelector('.bs-hero-g');
        if (g.querySelector('input')) return;
        g.innerHTML = 'цель на месяц <input type="number" min="1" max="999" value="' + (goalGet() || '') + '" placeholder="63"> продаж <button data-a="goalok">ок</button>';
        const inp = g.querySelector('input');
        inp.focus(); inp.select();
        inp.onkeydown = e => { if (e.key === 'Enter') g.querySelector('button').click(); if (e.key === 'Escape') { e.stopPropagation(); paintShift(box); } };
        return;
      }
      if (a === 'goalok') {
        const n = Math.round(+box.querySelector('.bs-hero-g input').value);
        if (n > 0) goalSet(n);
        return paintShift(box);
      }
      if (a === 'mine') { jset(MINE_KEY, { d: ddmm(new Date()), v: mine == null ? true : !mine }); return paintShift(box); }
      if (a === 'imp') return openImport();
      if (a === 'shift') {
        if (!confirm('Закрыть смену? Посчитается отчёт за день, смена с отчётом сохранится в «Истории», а «Продано», сумма, «Ссылки» и список продаж обнулятся.' +
          (teamOn() ? '\n\nЦифры дня (лиды, чаты, ссылки, продано, сумма) запишутся в таблицу отдела – только в пустые клетки.' : ''))) return;
        return closeShift(t);
      }
      const row = t.closest('.bs-sales-row');
      if (row && t.matches('.bs-sales-del')) {
        const x = salesGet().find(s => s.id === row.dataset.id);
        if (!x || !confirm('Удалить продажу «' + (x.who || x.name) + '»? Доля и сумма уйдут из отчёта смены.')) return;
        saleDel(x.id); return openSales();
      }
      if (row) openSale(row.dataset.id, true);
    };
  }
  // перенос смены на другую дату; если в истории уже есть смена этой даты – сливаем в неё
  function histMove(h, i, d) {
    const e = h[i], j = h.findIndex((x, k) => k !== i && x.d === d);
    if (j < 0) { e.d = d; return; }
    const t = h[j];
    Object.keys(Object.assign({}, t.rep, e.rep)).forEach(k => { t.rep[k] = Math.round(((+t.rep[k] || 0) + (+e.rep[k] || 0)) * 100) / 100; });
    t.sales = (t.sales || []).concat(e.sales || []);
    if (shiftMine(e)) t.mine = true;   // хоть одна из двух – моя
    h.splice(i, 1);
  }
  // дата из поля ввода – только целиком набранная (пока год печатается, там 0002, 0020…)
  const dateOk = s => { const d = fromIso(s); return d && d.getFullYear() >= 2000 && d <= new Date() ? d : null; };
  // цифры отчёта смены в раскрытой строке истории; чего не считали (старые смены) – прочерк
  function histRepHtml(r) {
    const v = k => r[k] == null || r[k] === '' ? '–' : k === 'sum' ? rub(+r[k] || 0) + ' ₽' : k === 'bought' ? frac(r[k]) : +r[k] || 0;
    return '<div class="bs-hist-rep">' + [['Лиды', v('leads') + (r.blocks ? ' <small>(' + r.blocks + ' блок.)</small>' : '')], ['Чаты', v('chats')], ['Ссылки', v('links')],
      ['Продано', v('bought')], ['Сумма', v('sum')], ['Напоминания', v('rem')]].map(([k, x]) => '<span>' + k + '<b>' + x + '</b></span>').join('') + '</div>';
  }
  function paintHist(box) {
    const today = isoOf(new Date());
    // шапка с периодом рисуется один раз – иначе поле даты теряет ввод посреди набора года
    box.innerHTML =
      '<div class="bs-hist-per"><span class="bs-seg">' + [['7', '7 дней'], ['30', '30 дней'], ['month', 'Месяц'], ['all', 'Всё']]
        .map(([v, t]) => '<em data-p="' + v + '">' + t + '</em>').join('') + '</span>' +
      '<span class="bs-range"><input type="date" data-r="from" max="' + today + '"><span>–</span><input type="date" data-r="to" max="' + today + '"></span></div>' +
      '<div class="bs-hist-body"></div>' +
      '<div class="bs-foot"><button data-a="bak" class="bs-ghost" title="Сохранить все данные помощника в файл или загрузить из файла">' + ico(ICO.box) + 'Резервная копия</button>' +
      '<button data-a="sheetset" class="bs-ghost" title="Своя Google Таблица для зарплаты и таблица отдела' + (sheetUrl() ? ' – подключено: ' + (teamOn() ? 'обе' : 'своя') : '') + '">' + ico(ICO.grid) + 'Таблицы' +
        (sheetUrl() ? '<i class="bs-dot" data-st="ok"></i>' : '') + '</button><span></span>' +
      '<button data-a="add" class="bs-main" title="Вставить отчёты из Telegram за прошлый день – они попадут в историю">+ Продажи за дату</button></div>';
    const body = box.querySelector('.bs-hist-body'), fromInp = box.querySelector('[data-r=from]'), toInp = box.querySelector('[data-r=to]');
    const paintPer = () => {
      const [from, to] = histRange();
      box.querySelectorAll('.bs-hist-per em').forEach(em => em.classList.toggle('on', em.dataset.p === histPer.p));
      box.querySelector('.bs-range').classList.toggle('on', histPer.p === 'custom');
      if (document.activeElement !== fromInp) fromInp.value = from ? isoOf(from) : '';
      if (document.activeElement !== toInp) toInp.value = to ? isoOf(to) : '';
    };
    const paintBody = () => {
      const [from, to] = histRange();
      const inR = d => { const x = dmyDate(d); return (!from || x >= from) && (!to || x <= to); };
      const shifts = histAll().filter(e => inR(e.d));
      // лиды, чаты, ссылки – только за мои смены (в чужую смену CRM могла что-то насчитать); продажи и сумма – за все
      const WORK = ['leads', 'blocks', 'chats', 'links'];
      const tot = k => shifts.reduce((a, e) => a + (WORK.includes(k) && !shiftMine(e) ? 0 : +e.rep[k] || 0), 0);
      const bought = Math.round(tot('bought') * 100) / 100, sum = tot('sum');
      const open = new Set([...body.querySelectorAll('.bs-hist-row.open')].map(r => r.dataset.k)), sheetOn = !!sheetUrl();
      if (histKeep) { open.add(histKeep); histKeep = null; }
      // сверка со строками таблицы: что есть только там – к своему дню (дня нет в истории – отдельной строкой)
      const tab = sheetOn && sheetTab && sheetTab.rows ? sheetTab : null, tm = tab ? tabMatch() : null;
      const ms = new Set(tab ? tab.months.filter(m => m.sheet).map(m => m.y * 100 + m.m) : []);
      const onlyBy = {};
      if (tab) tm.only.forEach(r => { if (r.d && inR(r.d)) (onlyBy[r.d] = onlyBy[r.d] || []).push(r); });
      const list = shifts.slice(), seen = new Set(shifts.map(e => e.d));
      Object.keys(onlyBy).forEach(d => { if (!seen.has(d)) list.push({ d, tab: 1, end: dmyDate(d).getTime() + 86399000, rep: {}, sales: [] }); });
      list.sort((a, b) => dmyDate(b.d) - dmyDate(a.d) || b.end - a.end);
      // у дня: чего нет в таблице, что там записано по-другому, что есть только там; премия за день – у первой смены даты
      // imp – сколько оплат «только в таблице» можно забрать (в идущую смену не добавляем)
      const cnt = { miss: 0, bad: 0, only: 0, imp: 0 }, given = new Set(), givenT = new Set();
      // таблица отдела: по дням периода – что дописать или перезаписать, и дни с цифрами, которых нет в истории
      const team = teamOn() && teamTab && teamTab.days ? teamTab.days : null, hh = histGet(), tcnt = { put: [], over: [], fresh: [] };
      if (team) Object.keys(team).filter(inR).forEach(d => {
        const c = teamCells(d, team[d], hh);
        tcnt.put.push(...c.put); tcnt.over.push(...c.over);
        if (typeof team[d].leads === 'number' && d !== ddmm(new Date()) && !hh.some(e => e.d === d)) tcnt.fresh.push(d);
      });
      const info = list.map(e => {
        const first = !given.has(e.d), firstT = !e.now && !e.tab && !givenT.has(e.d);
        given.add(e.d);
        if (firstT) givenT.add(e.d);
        const on = tab && ms.has(ymOf(e.d)), only = first && onlyBy[e.d] || [];
        const xs = on && !e.now ? e.sales.map((x, si) => ({ x, k: e.hi + ':' + si })).filter(o => toSheet(o.x)) : [];
        const o = { only, on, team: firstT && team && team[e.d] ? teamCells(e.d, team[e.d], hh) : null, prem: first && tab && tab.days[e.d] != null ? tab.days[e.d] : null,
          miss: xs.filter(o => !tm.pair.has(o.k)).length, bad: xs.filter(o => tm.pair.has(o.k) && shBad(o.x)).length, any: xs.length + only.length };
        cnt.miss += o.miss; cnt.bad += o.bad; cnt.only += only.length;
        if (!e.now) cnt.imp += only.length;
        return o;
      });
      const prem = tab ? Object.keys(tab.days).filter(inR).reduce((a, d) => a + tab.days[d], 0) : null;
      // премия, посчитанная помощником: за период и по дням (за день сверяем с таблицей – там она у первой продажи дня)
      const pOn = premOn(), ps = premSum([].concat(...shifts.map(e => e.sales || []))), pDay = {};
      shifts.forEach(e => { const p = premSum(e.sales), d = pDay[e.d] = pDay[e.d] || { v: 0, miss: 0 }; d.v = Math.round((d.v + p.v) * 100) / 100; d.miss += p.miss; });
      const premCell = (e, f) => {
        if (!pOn) return '<span class="bs-hist-prem" title="Премия за день – из таблицы (столбец N в строке с датой)">' + (f.prem ? '+' + rub(f.prem) + ' ₽' : '') + '</span>';
        const p = e.tab ? null : premSum(e.sales), d = pDay[e.d] || { v: 0, miss: 0 }, t = f.prem, bad = t != null && Math.abs(d.v - t) >= 0.5;
        const tip = (p ? 'Премия за смену – посчитана помощником: ' + rubK(p.v) + ' ₽' + (p.miss ? '. Без премии ' + p.miss + ' – раскрой день и открой их' : '') : 'Смены нет в помощнике') +
          (t != null ? '\nВ таблице за день: ' + rubK(t) + ' ₽' + (p ? bad ? ' – не сходится (у помощника за день ' + rubK(d.v) + ' ₽)' : ' – сходится' : '') : '');
        // список продаж не вёлся (старые смены) – премию за день показываем из таблицы
        if (!p || !e.sales.length) return '<span class="bs-hist-prem" title="' + (p ? 'Список продаж за смену не вёлся – премия за день из таблицы' : tip) + '">' + (t ? '+' + rubK(t) + ' ₽' : '') + '</span>';
        const txt = p.v || p.miss ? '+' + rubK(p.v) + ' ₽' + (bad ? ' ≠' : p.miss ? ' ?' : '') : '';
        return '<span class="bs-hist-prem' + (bad || p.miss ? ' bs-warn' : '') + '" title="' + tip + '">' + txt + '</span>';
      };
      body.innerHTML =
        statsHtml([['Смен', shifts.length + (shifts.some(e => !shiftMine(e)) ? '<small> · моих ' + shifts.filter(shiftMine).length + '</small>' : '')], ['Лиды', tot('leads')], ['Чаты', tot('chats')], ['Продано', frac(bought)], ['Сумма', rub(sum) + ' ₽'], ['Ср. чек', bought ? rub(Math.round(sum / bought)) + ' ₽' : '–']]
          .concat(pOn ? [['Премия', '<i title="Посчитано помощником по продажам' + (ps.miss ? ', без премии ' + ps.miss + ' – их надо вписать вручную' : '') + (tab ? '\nВ таблице за эти дни: ' + rubK(prem) + ' ₽' : '') + '">' + rubK(ps.v) + ' ₽' + (ps.miss ? '<small class="bs-prem-q"> ?' + ps.miss + '</small>' : '') + '</i>']] :
            tab ? [['Премия', rub(prem) + ' ₽']] : [])) +
        syncCard(from, to, cnt, tcnt) +
        (list.length ? '<div class="bs-hist-list' + (tab || pOn ? ' bs-prem' : '') + '">' + list.map((e, li) => {
          const k = e.now ? 'now' : e.tab ? 'tab:' + e.d : e.hi + ':' + e.end, f = info[li];
          const zero = !+e.rep.bought && !+e.rep.sum && !f.only.length && !f.prem;
          const issues = f.miss + f.bad + f.only.length;
          const mark = !f.on || !f.any ? '' : issues ? '<i class="bs-hist-tabm bs-warn" title="С таблицей не сходится: ' + esc([f.miss && 'нет в таблице ' + f.miss, f.bad && 'в таблице записано по-другому ' + f.bad, f.only.length && 'только в таблице ' + f.only.length].filter(Boolean).join(', ')) + ' – раскрой день">табл. ' + issues + '</i>' :
            '<i class="bs-hist-tabm" title="Всё, что за этот день в помощнике, есть в таблице, и наоборот">табл.</i>';
          const tw = f.team ? f.team.put.length + f.team.over.length : 0;
          const tmark = tw ? '<i class="bs-hist-tabm bs-warn" title="В таблице отдела не так, как в помощнике – раскрой день">отдел</i>' : '';
          const chip = e.tab ? '<i class="bs-hist-mine bs-warn">нет смены в истории</i>' :
            '<i class="bs-hist-mine' + (e.now && e.mine == null ? '' : shiftMine(e) ? ' on' : '') + '">' + (e.now && e.mine == null ? 'не отмечена' : shiftMine(e) ? 'моя' : 'не моя') + '</i>';
          return '<div class="bs-hist-row' + (open.has(k) ? ' open' : '') + (zero ? ' bs-hist-zero' : '') + '" data-k="' + k + '"><b>' + e.d.slice(0, 5) + '<span>' + WD[dmyDate(e.d).getDay()] + (e.now ? ' · сейчас' : '') + '</span>' + chip + mark + tmark + '</b>' +
            '<em><span>' + (zero || e.tab ? '–' : frac(e.rep.bought) + ' прод.') + '</span><span>' + (zero || e.tab ? '–' : rub(+e.rep.sum || 0) + ' ₽') + '</span>' +
            (tab || pOn ? premCell(e, f) : '') +
            '<span>' + (+e.rep.links ? +e.rep.links + ' ссыл.' : '') + '</span></em>' +
            (e.now || e.tab ? '<s></s>' : '<i class="bs-hist-del" title="Удалить смену из истории">×</i>') +
            '<div class="bs-hist-sales">' + (e.tab ? '' : histRepHtml(e.rep) + (e.sales.length ? e.sales.map((x, si) =>
              '<div class="bs-hist-s' + (x.cnt === false ? ' bs-hist-other' : '') + '" ' + (e.now ? 'data-id="' + x.id + '"' : 'data-si="' + si + '"') + ' title="Открыть и поправить"><span>' + esc(x.who || x.fio || 'чат ' + x.dlg) + ' – ' + esc(x.name) + '</span><span>' + rub(saleTotal(x)) + ' ₽ · ' + (x.cnt === false ? 'не моя' : frac(x.share)) + premTag(x) + '</span>' +
              (e.now || !sheetOn ? '' : !toSheet(x) ? '<b class="bs-hist-sh"></b>' : shBad(x) ? '<button data-a="sheetfix" data-si="' + si + '" class="bs-hist-sh bs-warn" title="В таблице записано по-другому: ' + esc(shDiff(x).join('; ')) + '. Нажми, чтобы исправить в таблице">↻ табл.</button>' :
                x.sh ? '<b class="bs-hist-sh" title="Эта продажа есть в Google Таблице">✓ табл.</b>' :
                x.shAlso ? '<button data-a="sheet1" data-si="' + si + '" class="bs-hist-sh bs-warn" title="Этой продажи нет в таблице, но у этого человека там уже есть оплата (' + esc(x.shAlso) + ') – проверь, не ошибка ли. Нажми, чтобы отправить">⚠ в табл.</button>' :
                '<button data-a="sheet1" data-si="' + si + '" class="bs-hist-sh" title="Этой продажи нет в Google Таблице – отправить только её">+ в табл.</button>') +
              (e.now ? '' : '<i class="bs-hist-sdel" data-si="' + si + '" title="Удалить продажу из этой смены">×</i>') + '</div>').join('') : f.only.length ? '' : '<div><span>Список продаж не вёлся</span></div>')) +
            onlyHtml(e, f.only) +
            (e.tab ? '' : histActHtml(e, f, today)) +
            '</div></div>';
        }).join('') + '</div>' : '<div class="bs-empty">За этот период смен нет.<br>Закрытые смены попадают сюда сами, а прошлые дни можно добавить кнопкой «+ Продажи за дату».</div>');
    };
    const repaint = () => { paintPer(); paintBody(); };
    histPaint = () => { if (body.isConnected) paintBody(); };
    // сама сверяет с таблицей смены за период: строки оплат листов этих месяцев против продаж в истории
    // (строки могли удалить или дописать руками). Старый скрипт строк не отдаёт – тогда как раньше, только текущий месяц
    // lazy – при открытии истории и смене периода: тот же период сверяли меньше минуты назад – не дёргаем таблицу снова
    const autoCheck = lazy => {
      if (!sheetUrl()) return;
      const [from, to] = histRange(), now = new Date();
      const key = [from && isoOf(from), to && isoOf(to), sheetUrl(), teamOn() && JSON.stringify(teamCfg())].join('|');
      if (lazy && sheetLast && sheetLast.key === key && Date.now() - sheetLast.t < 60000) return;
      sheetLast = { key, t: Date.now() };
      if (!lazy) { okkLast = 0; okkSync(); }
      const tok = ++sheetTok;
      // таблица отдела – после своей таблицы (скрипт один, запросы всё равно идут по очереди)
      teamBusy = teamOn();
      const team = () => !teamBusy ? null : teamFetch(from, to).catch(err => { teamTab = { err: err.message }; })
        .then(() => { if (tok !== sheetTok) return; teamBusy = false; histPaint(); });
      const keys = new Set(histGet().map((e, hi) => ({ e, k: hi + ':' + e.end })).filter(({ e }) => {
        const d = dmyDate(e.d);
        return (!from || d >= from) && (!to || d <= to) && e.sales.some(toSheet);
      }).map(o => o.k));
      sheetBusy = keys;
      paintBody();
      const old = () => {
        const list = histGet().map((e, hi) => ({ hi, end: e.end, e })).filter(({ e }) => {
          const d = dmyDate(e.d);
          return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() &&
            (!from || d >= from) && (!to || d <= to) && e.sales.some(toSheet);
        }).map(({ hi, end }) => ({ hi, end }));
        return list.length ? sheetCheck(list).then(st => { if (st.err.length) sheetAutoErr = { keys, msg: st.err.join('; ') }; }) : null;
      };
      sheetAutoErr = null;
      tabFetch(from, to).then(ok => { if (!ok) { sheetTab = { old: 1 }; return old(); } })
        .catch(err => { sheetTab = { err: err.message }; sheetAutoErr = { keys, msg: err.message }; })
        .then(() => { if (tok !== sheetTok) return; sheetBusy = null; histPaint(); return team(); });
    };
    repaint();
    autoCheck(1);
    const find = row => { const [hi, end] = row.dataset.k.split(':'), h = histGet(); return h[+hi] && String(h[+hi].end) === end ? { h, i: +hi } : null; };
    box.onclick = ev => {
      const t = ev.target, a = t.dataset.a;
      if (a === 'bak') return openBackup();
      if (a === 'sheetset') return openSheet();
      if (a === 'add') return openImport(isoOf(new Date(Date.now() - 864e5)));
      if (t.dataset.p) { histPer.p = t.dataset.p; repaint(); return autoCheck(1); }
      if (a === 'tabsync') return autoCheck();
      // за весь период: оплаты «только в таблице» – в историю по своим дням
      if (a === 'tabimp') {
        const [from, to] = histRange(), nowD = histAll().some(e => e.now) ? ddmm(new Date()) : null;
        const inR = d => { const x = dmyDate(d); return (!from || x >= from) && (!to || x <= to); };
        const rs = sheetTab && sheetTab.rows ? tabMatch().only.filter(r => r.d && r.d !== nowD && inR(r.d)) : [];
        if (!rs.length) return paintBody();
        const by = {};
        rs.forEach(r => (by[r.d] = by[r.d] || []).push(r));
        const ds = Object.keys(by).sort((a, b) => dmyDate(a) - dmyDate(b)), had = new Set(histGet().map(e => e.d));
        const fresh = ds.filter(d => !had.has(d)).length;
        if (!confirm('Забрать из таблицы ' + rs.length + ' ' + plural(rs.length, 'оплату', 'оплаты', 'оплат') + ' на ' + rub(rs.reduce((a, r) => a + r.sum, 0)) + ' ₽ за ' + ds.length + ' ' + plural(ds.length, 'день', 'дня', 'дней') +
          ' (' + ds[0].slice(0, 5) + (ds.length > 1 ? ' – ' + ds[ds.length - 1].slice(0, 5) : '') + ')?\n\nКаждая встанет продажей в смену своего дня' +
          (fresh ? ', ' + fresh + ' ' + plural(fresh, 'смена создастся', 'смены создадутся', 'смен создастся') + ' (отметь потом, твои ли они)' : '') + '. В таблице ничего не меняется.')) return;
        if (histAddDays(ds.map(d => [d, by[d].map(tabSale)]))) tarHint('✓ Из таблицы в историю: ' + rs.length + ' за ' + ds.length + ' ' + plural(ds.length, 'день', 'дня', 'дней'), true);
        return repaint();
      }
      // за весь период: продажи, которых нет в таблице, – туда, смена за сменой
      if (a === 'tabexp') {
        const [from, to] = histRange(), h = histGet();
        const list = h.map((e, hi) => ({ hi, end: e.end, d: e.d, n: e.sales.filter(x => toSheet(x) && !x.sh).length }))
          .filter(o => { const x = dmyDate(o.d); return o.n && (!from || x >= from) && (!to || x <= to); });
        if (!list.length) return paintBody();
        const n = list.reduce((a, o) => a + o.n, 0);
        if (!confirm('Отправить в таблицу ' + n + ' ' + plural(n, 'продажу', 'продажи', 'продаж') + ' из ' + list.length + ' ' + plural(list.length, 'смены', 'смен', 'смен') + '?\n\nПовторы помощник не запишет, а если у человека в таблице уже есть оплата – спросит.')) return;
        t.disabled = true;
        const all = { add: 0, dup: 0, skip: 0, late: 0, err: [] };
        return list.reduce((p, o, k) => p.then(() => {
          t.textContent = 'Отправляю ' + (k + 1) + '/' + list.length + '…';
          return sheetSend(o.hi, o.end).then(st => { ['add', 'dup', 'skip', 'late'].forEach(f => all[f] += st[f]); all.err.push(...st.err.map(m => o.d.slice(0, 5) + ': ' + m)); })
            .catch(err => { all.err.push(o.d.slice(0, 5) + ': ' + err.message); });
        }), Promise.resolve()).then(() => {
          const ok = !all.err.length && !all.skip && !all.late;
          tarHint((ok ? '✓ ' : '') + 'Таблица: ' + sheetMsg(Object.assign({ n, rows: [] }, all)), ok);
          autoCheck();
        });
      }
      // таблица отдела: «Забрать смены» – дни с цифрами, которых нет в истории (лиды, чаты, ссылки; продажи – из своей таблицы);
      // «В отдел» – продано и сумма (и пустые лиды, чаты, ссылки) из помощника, со списком перед записью; в раскрытой смене – за один день
      if (a === 'teamimp' || a === 'teamexp') {
        const [from, to] = histRange(), h = histGet(), days = teamTab && teamTab.days || {};
        const inR = d => { const x = dmyDate(d); return (!from || x >= from) && (!to || x <= to); };
        // у кнопки в раскрытой смене – только её день
        const one = t.dataset.d, ds = one ? (days[one] ? [one] : []) : Object.keys(days).filter(inR).sort((a, b) => dmyDate(a) - dmyDate(b));
        if (a === 'teamimp') {
          const add = ds.filter(d => typeof days[d].leads === 'number' && d !== ddmm(new Date()) && !h.some(e => e.d === d));
          if (!add.length) return paintBody();
          if (!confirm('В таблице отдела у тебя есть цифры за ' + add.length + ' ' + plural(add.length, 'день', 'дня', 'дней') + ', которых нет в истории:\n' + add.map(d => d.slice(0, 5)).join(', ') +
            '\n\nСоздать эти смены (моими) с лидами, чатами и ссылками из таблицы отдела? Продажи в них – кнопкой «Забрать» из своей таблицы.')) return;
          add.forEach(d => {
            const rep = {};
            ['leads', 'chats', 'links'].forEach(k => { if (typeof days[d][k] === 'number') rep[k] = days[d][k]; });
            h.push({ d, end: dmyDate(d).getTime() + 86399000, rep, sales: [], mine: true });
          });
          if (histSave(h)) tarHint('✓ Из таблицы отдела в историю: ' + add.length + ' ' + plural(add.length, 'смена', 'смены', 'смен'), true);
          return repaint();
        }
        const put = [], over = [];
        ds.forEach(d => { const c = teamCells(d, days[d], h); put.push(...c.put); over.push(...c.over); });
        if (!put.length && !over.length) return paintBody();
        const p1 = put.length ? 'Запишу в таблицу отдела (там пусто или «выходной», а оплаты были):\n' + teamList(put) : '';
        let cells = put;
        if (over.length) {
          const p2 = 'Там другие цифры – перезапишу цифрами помощника:\n' + teamList(over, 1);
          if (confirm([p1, p2].filter(Boolean).join('\n\n') + '\n\nОК – записать всё' + (put.length ? '. Отмена – выбрать: только пустые или ничего' : ''))) cells = put.concat(over);
          else if (!put.length || !confirm('Тогда записать только в пустые клетки и вместо «выходного» (' + put.length + '), а другие цифры не трогать?\n\n' + teamList(put))) return;
        } else if (!confirm(p1 + '\n\nЗаписать?')) return;
        t.disabled = true; t.textContent = 'Пишу…';
        return teamWrite(cells).then(st => { const ok = st.ok === cells.length; tarHint((ok ? '✓ ' : '') + 'Таблица отдела: ' + teamMsg(st), ok); autoCheck(); })
          .catch(err => { tarHint('В таблицу отдела не ушло: ' + err.message); paintBody(); });
      }
      const row = t.closest('.bs-hist-row');
      if (!row) return;
      // оплата есть только в таблице – добавить её продажей в смену того дня (дня нет – создастся)
      if (a === 'tabadd') {
        const only = sheetTab && sheetTab.rows ? tabMatch().only : [];
        const rs = only.filter(r => t.dataset.r ? r.sheet + ':' + r.row === t.dataset.r : r.d === t.dataset.d);
        if (!rs.length) return paintBody();
        const d = rs[0].d;
        if (!confirm((rs.length > 1 ? 'Добавить ' + rs.length + ' оплаты из таблицы' : 'Добавить оплату из таблицы (' + (rs[0].name || 'без продукта') + ', ' + rub(rs[0].sum) + ' ₽)') +
          ' в смену ' + d + '? Продано и сумма этой смены вырастут. ФИО и тариф потом можно поправить в продаже.')) return;
        if (histAddDay(d, rs.map(tabSale))) tarHint('✓ Добавлено в смену ' + d + ': ' + rs.length, true);
        return repaint();
      }
      if (a === 'sheet' || a === 'sheet1') {
        const f = find(row);
        if (!f) return paintBody();
        t.disabled = true; t.textContent = a === 'sheet' ? 'Переношу…' : '…';
        return sheetSend(f.i, f.h[f.i].end, a === 'sheet1' ? +t.dataset.si : null).then(st => { const ok = !st.err.length && !st.skip && !st.late; tarHint((ok ? '✓ ' : '') + 'Таблица: ' + sheetMsg(st), ok); if (st.add) autoCheck(); else paintBody(); })
          .catch(err => { tarHint('В таблицу не ушло: ' + err.message); paintBody(); });
      }
      if (a === 'sheetfix') {
        const f = find(row);
        if (!f) return paintBody();
        t.disabled = true; t.textContent = t.dataset.si ? '…' : 'Исправляю…';
        return sheetFix(f.i, f.h[f.i].end, t.dataset.si ? +t.dataset.si : null).then(st => { const ok = !st.err.length && !st.gone; tarHint((ok ? '✓ ' : '') + 'Таблица: ' + fixMsg(st), ok); paintBody(); })
          .catch(err => { tarHint('Исправить не вышло: ' + err.message); paintBody(); });
      }
      if (a === 'sheetchk') {
        const f = find(row);
        if (!f) return paintBody();
        t.disabled = true; t.textContent = 'Сверяю…';
        return sheetCheck([{ hi: f.i, end: f.h[f.i].end }]).then(st => { if (sheetAutoErr) sheetAutoErr.keys.delete(f.i + ':' + f.h[f.i].end); return st; }).then(st => { tarHint((st.err.length || st.here < st.n || st.mops ? '' : '✓ ') + 'Таблица: ' + checkMsg(st), !st.err.length && st.here === st.n && !st.mops); paintBody(); })
          .catch(err => { tarHint('Сверить не вышло: ' + err.message); paintBody(); });
      }
      if (a === 'moveask') return void row.querySelector('.bs-hist-act').classList.toggle('mv');
      if (a === 'mine') {
        const v = t.dataset.v === '1';
        if (row.dataset.k === 'now') jset(MINE_KEY, { d: ddmm(new Date()), v });
        else {
          const f = find(row);
          if (!f) return paintBody();
          f.h[f.i].mine = v;
          if (!histSave(f.h)) return;
        }
        return repaint();
      }
      if (a === 'hrep') {
        if (row.dataset.k === 'now') return openSales('rep');
        const f = find(row);
        return f ? openHistReport(f.i, f.h[f.i].end) : paintBody();
      }
      if (a === 'move' || t.matches('.bs-hist-del,.bs-hist-sdel')) {
        const f = find(row);
        if (!f) return paintBody();
        const e = f.h[f.i];
        if (a === 'move') {
          const d = dateOk(row.querySelector('.bs-hist-mv input').value);
          if (!d) return alert('Дата не подходит – нужна полная дата не позже сегодня.');
          const nd = ddmm(d);
          if (nd === e.d) return;
          const twin = f.h.some((x, k) => k !== f.i && x.d === nd);
          if (!confirm(twin ? 'За ' + nd + ' в истории уже есть смена. Объединить смену ' + e.d + ' с ней? Продажи и цифры сложатся.' : 'Перенести смену ' + e.d + ' на ' + nd + '?')) return;
          histMove(f.h, f.i, nd);
          // чтобы смена была видна после переноса, расширяем период до новой даты
          const [from, to] = histRange();
          if ((from && d < from) || (to && d > to)) Object.assign(histPer, { p: 'custom', from: from && d < from ? d : from, to: to && d > to ? d : to });
          if (histSave(f.h)) tarHint(twin ? '✓ Смены объединены' : '✓ Смена перенесена на ' + nd, true);
          return repaint();
        }
        if (t.matches('.bs-hist-del')) {
          if (!confirm('Удалить смену ' + e.d + ' из истории? Отчёт и продажи за сегодня это не трогает.')) return;
          f.h.splice(f.i, 1);
        } else {
          const x = e.sales[+t.dataset.si];
          if (!x || !confirm('Удалить из смены ' + e.d + ' продажу «' + (x.who || x.fio || x.name) + '»? Продано и сумма этой смены уменьшатся.')) return;
          e.sales.splice(+t.dataset.si, 1);
          e.rep.bought = Math.max(0, Math.round(((+e.rep.bought || 0) - saleShare(x)) * 100) / 100);
          e.rep.sum = Math.max(0, (+e.rep.sum || 0) - salePart(x));
        }
        histSave(f.h);
        return paintBody();
      }
      const sd = t.closest('.bs-hist-s:not(.bs-hist-only)');
      if (sd) {
        if (sd.dataset.id) return openSale(sd.dataset.id, true);
        const f = find(row);
        return f ? openHistSale(f.i, f.h[f.i].end, +sd.dataset.si) : paintBody();
      }
      if (!t.closest('.bs-hist-sales')) row.classList.toggle('open');
    };
    // период «с–по»: пересчитываем только список, поля ввода не трогаем
    const onRange = ev => {
      const r = ev.target.dataset.r;
      if (!r) return;
      const d = dateOk(ev.target.value);
      if (!d) return;
      const [f0, t0] = histRange();
      let f = r === 'from' ? d : f0, to2 = r === 'to' ? d : t0;
      // «с» позже «по» – подтягиваем вторую границу к введённой дате, а не меняем местами
      if (f && to2 && f > to2) { if (r === 'from') to2 = f; else f = to2; }
      Object.assign(histPer, { p: 'custom', from: f, to: to2 });
      paintPer(); paintBody();
    };
    box.oninput = onRange;
    box.onchange = onRange;
    fromInp.onblur = toInp.onblur = paintPer;
  }
  // правка продажи из прошлой смены: цифры смены пересчитываются на разницу
  let histKeep = null;   // какую смену оставить раскрытой после возврата в «Историю»
  function openHistSale(hi, end, si) {
    const h = histGet(), e = h[hi];
    if (!e || String(e.end) !== String(end) || !e.sales[si]) return openSales('hist');
    closeSale();
    histKeep = hi + ':' + end;
    const old = e.sales[si], x = Object.assign({}, old, { mops: (old.mops || []).slice() });
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const field = (k, t, ph) => '<label><span>' + t + '</span><input data-k="' + k + '" placeholder="' + (ph || '') + '"></label>';
    wrap.innerHTML = '<div id="bsSale" class="bs-hedit"><div class="bs-rep-head"><b>Продажа за ' + e.d + '</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-sale-form">' + field('fio', 'Имя и фамилия') + field('name', 'Тариф') +
      '<div class="bs-hedit-2">' + field('price', 'Цена, ₽') + field('disc', 'Скидка', '₽ или 10%') + '</div>' +
      '<label><span>Менеджеры</span><div class="bs-chips" data-g="mops">' + MANAGERS.map(m => '<em data-v="' + m[1] + '">' + m[1] + '</em>').join('') + '</div></label>' +
      '<label class="bs-sale-share"><span>Доля продажи</span><div class="bs-chips" data-g="share">' + SHARES.map(([v, t]) => '<em data-v="' + v + '">' + t + '</em>').join('') + '</div></label>' +
      payChips() + field('email', 'Почта') + '<div class="bs-sale-note"></div>' +
      (x.dlg ? '<a class="bs-hedit-chat" href="/app/messenger/?dialogId=' + encodeURIComponent(x.dlg) + '" target="_blank">Открыть чат ↗</a>' : '') + '</div>' +
      '<div class="bs-rep-btns"><button data-a="del" class="bs-sale-del">Удалить</button><span class="bs-tar-st"></span><button data-a="back">Назад</button><button data-a="save" class="bs-main">Сохранить</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsSale'), note = box.querySelector('.bs-sale-note');
    ['fio', 'name', 'price', 'disc', 'email'].forEach(k => { box.querySelector('[data-k="' + k + '"]').value = x[k] == null ? '' : x[k]; });
    const paint = () => {
      // «моя» – если я среди менеджеров (как при импорте); менеджеров нет (пришла из таблицы) – как была
      x.cnt = x.mops.length ? !meSet() || x.mops.includes(meName()) : old.cnt !== false;
      box.querySelectorAll('[data-g="mops"] em').forEach(m => m.classList.toggle('bs-on', x.mops.includes(m.dataset.v)));
      box.querySelectorAll('[data-g="share"] em').forEach(m => m.classList.toggle('bs-on', +m.dataset.v === +x.share));
      box.querySelector('.bs-sale-share').hidden = !x.cnt;
      payPaint(box, x, x.cnt);
      premPaint(box, x, old, ymOf(e.d), x.cnt);
      const dB = Math.round((saleShare(x) - saleShare(old)) * 100) / 100, dS = salePart(x) - salePart(old);
      note.textContent = (x.cnt ? 'Твоя: ' + rub(saleTotal(x)) + ' ₽' + (shareHow(x.share) || ' × 1') + ' = ' + rub(salePart(x)) + ' ₽' : 'Не твоя – в «Продано» и сумму не идёт') +
        (dB || dS ? ' · смена: продано ' + (dB >= 0 ? '+' : '') + r2s(dB) + ', сумма ' + (dS >= 0 ? '+' : '−') + rub(Math.abs(dS)) + ' ₽' : '') +
        (x.sh ? ' · уже в таблице: сумму, почту и число менеджеров там поправишь кнопкой «↻ табл.»' : '');
    };
    paint();
    box.addEventListener('input', ev => { const k = ev.target.dataset.k; if (k) { x[k] = ev.target.value; paint(); } });
    // в истории могли что-то поменять в другой вкладке – перечитываем и сверяем перед записью
    const fresh = () => { const h2 = histGet(), e2 = h2[hi]; return e2 && String(e2.end) === String(end) && e2.sales[si] ? { h2, e2 } : null; };
    box.addEventListener('click', ev => {
      const em = ev.target.closest('.bs-chips em'), a = ev.target.dataset.a;
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      if (em) {
        const v = em.dataset.v;
        if (em.parentNode.dataset.g === 'mops') {
          x.mops = x.mops.includes(v) ? x.mops.filter(m => m !== v) : MANAGERS.map(m => m[1]).filter(n => n === v || x.mops.includes(n));
          x.share = shareFor(x.mops.length);
        } else if (em.parentNode.dataset.g === 'pay') x.pay = v;
        else x.share = +v;
        return paint();
      }
      if (a === 'back') return openSales('hist');
      if (a !== 'save' && a !== 'del') return;
      const f = fresh();
      if (!f) { alert('Эта смена изменилась – открой продажу заново.'); return openSales('hist'); }
      const r = f.e2.rep;
      if (a === 'del') {
        if (!confirm('Удалить продажу из смены ' + e.d + '? Продано и сумма этой смены уменьшатся.')) return;
        f.e2.sales.splice(si, 1);
        x.cnt = false; x.price = 0;   // новая «продажа» – пустая, разница = минус старая
      } else {
        x.price = String(x.price).replace(/\s/g, '');
        x.who = x.fio || x.who;
        premSave(x, old, ymOf(e.d));
        f.e2.sales[si] = histSale(x);
      }
      r.bought = Math.max(0, Math.round(((+r.bought || 0) + saleShare(x) - saleShare(old)) * 100) / 100);
      r.sum = Math.max(0, (+r.sum || 0) + salePart(x) - salePart(old));
      if (!histSave(f.h2)) return;
      openSales('hist');
      tarHint(a === 'del' ? '✓ Продажа удалена из смены ' + e.d : '✓ Продажа за ' + e.d + ' сохранена', true);
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  // ---------- Своя таблица продаж (Google Таблицы): продажи с моей долей дописываются через веб-приложение Apps Script ----------
  // Код для таблицы – bluesales-sheet.gs в репозитории. Ссылка …/exec хранится только в этом браузере (bsSheet).
  const SHEET_KEY = 'bsSheet', SHEET_RX = /^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/;
  const SHEET_CODE = 'https://raw.githubusercontent.com/Misha-Burtsev/bluesales-tools/beta/bluesales-sheet.gs';
  const sheetUrl = () => jget(SHEET_KEY, {}).url || '';
  // «Оплата» (столбец F): сама угадывается по тарифу и сумме, можно поменять в продаже
  // [что пишется в F (как в выпадашке таблицы), подпись]
  const PAYS = [['Месяц', 'Месяц'], ['Год', 'Год'], ['Высшая математика', 'Высшая'], ['Летняя школа', 'Летняя школа'], ['Бронь', 'Бронь'],
    ['Доплата на лучш тариф (месяц)', 'Доплата мес.'], ['Доплата на лучш тариф (год)', 'Доплата год'],
    ['ВЫЧЕТ ЛШ: 1 предмет куратор', 'Вычет ЛШ 1 кур.'], ['ВЫЧЕТ ЛШ: 1 предмет самоподготовка', 'Вычет ЛШ 1 сам.'],
    ['ВЫЧЕТ ЛШ: комбо куратор', 'Вычет ЛШ комбо кур.'], ['ВЫЧЕТ ЛШ: комбо самоподготовка', 'Вычет ЛШ комбо сам.']];
  const payGuess = x => /высш/i.test(x.name) ? PAYS[2][0] : /летн/i.test(x.name) ? PAYS[3][0] : saleTotal(x) >= 15000 ? PAYS[1][0] : PAYS[0][0];
  const salePay = x => PAYS.some(p => p[0] === x.pay) ? x.pay : payGuess(x);
  const saleKind = x => /высш/i.test(x.name) ? 'Высшая' : /комбо|математика \+ русский/i.test(x.name) ? 'Комбо' : '1 предмет';
  const payChips = () => '<label class="bs-sale-pay"><span>Оплата <small>(для таблицы и премии)</small></span><div class="bs-chips" data-g="pay">' + PAYS.map(([v, t]) => '<em data-v="' + v + '" title="' + v + '">' + t + '</em>').join('') + '</div></label>' +
    '<label class="bs-sale-prem"><span>Премия за продажу <small></small></span><input data-k="premIn" inputmode="decimal"></label>';
  function payPaint(box, x, mine) {
    const l = box.querySelector('.bs-sale-pay');
    l.hidden = !mine;
    l.querySelectorAll('em').forEach(e => e.classList.toggle('bs-on', e.dataset.v === salePay(x)));
  }
  // ---------- Премия: как столбец N своей таблицы – по ставкам и ценам из справочника листа месяца (T1:T4, P3:R8) ----------
  // Посчитанная премия запоминается в продаже (prem – вся, до деления) и сама не пересчитывается, даже если в таблице
  // поменяются цены или ставки: заново – только если в продаже поменяли сумму или оплату. premM – вписана руками.
  // prem === null – сумма нестандартная (доплата, скидка), премию надо вписать руками; undefined – ещё не считали (нет ставок)
  const PREM_KEY = 'bsPremCfg';   // { ГГГГММ: { t: [T1, T2, T3, T4], p: [[продукт, за месяц, за курс] × 6] } }
  const premCfgs = () => jget(PREM_KEY, {});
  const premOn = () => Object.keys(premCfgs()).length > 0;
  // ставки месяца продажи; листа за этот месяц не видели – ближайшего прошлого, иначе самого раннего
  const premCfgFor = ym => {
    const c = premCfgs(), ks = Object.keys(c).map(Number).sort((a, b) => a - b);
    return c[ym] || (ks.length ? c[ks.filter(k => k <= ym).pop() || ks[0]] : null);
  };
  const rubK = n => { const v = Math.round((+n || 0) * 100); return rub(Math.floor(v / 100)) + (v % 100 ? ',' + ('0' + v % 100).slice(-2) : ''); };
  // формула N: Месяц, Высшая, доплата за месяц – сумма × T1; Год – цена за месяц (H) × T2; Летняя школа – H × T1;
  // доплата за год – T3; бронь – T4; вычет ЛШ – цена тарифа за месяц × T2. H – цена за месяц по сумме оплаты (столбец H), не нашлась – нестандарт
  function premCalc(x, c) {
    if (!c || !c.t || !c.p || c.p.length < 6) return undefined;
    const g = saleTotal(x), t = c.t.map((v, i) => i < 2 && v > 1 ? v / 100 : +v || 0), p = c.p, ege = p.slice(2);
    // «за месяц» от 15 000 ₽ (как в угадывании оплаты) – это не месяц (например, годовая доплата): считать вручную
    const big = g >= 15000;
    const h = !g ? null : g === p[0][1] ? p[0][2] : g === p[1][1] ? p[1][2] : (ege.find(r => g === r[2]) || ege.find(r => g === r[1]) || [])[1];
    const v = {
      'Месяц': !big && g * t[0], 'Высшая математика': g * t[0], 'Год': h && h * t[1], 'Летняя школа': h && h * t[0],
      'Доплата на лучш тариф (год)': t[2], 'Доплата на лучш тариф (месяц)': !big && g * t[0], 'Бронь': t[3],
      'ВЫЧЕТ ЛШ: 1 предмет куратор': p[2][1] * t[1], 'ВЫЧЕТ ЛШ: 1 предмет самоподготовка': p[3][1] * t[1],
      'ВЫЧЕТ ЛШ: комбо куратор': p[4][1] * t[1], 'ВЫЧЕТ ЛШ: комбо самоподготовка': p[5][1] * t[1],
    }[salePay(x)];
    return v > 0 ? Math.round(v * 100) / 100 : null;
  }
  const premKey = x => saleTotal(x) + '|' + salePay(x);
  // какая премия будет у продажи после сохранения: вписанная руками, прежняя (сумма и оплата не менялись) или посчитанная заново
  function premNext(x, was, ym) {
    const s = String(x.premIn != null ? x.premIn : x.premM ? x.prem : '').replace(/\s/g, '').replace(',', '.');
    if (s !== '' && isFinite(+s)) return { v: Math.round(+s * 100) / 100, man: 1 };
    if (was && !was.premM && was.prem !== undefined && premKey(was) === premKey(x)) return { v: was.prem };
    return { v: premCalc(x, premCfgFor(ym)) };
  }
  function premSave(x, was, ym) {
    const n = premNext(x, was, ym);
    delete x.premIn; delete x.premM; delete x.prem;
    if (n.man) x.premM = 1;
    if (n.v !== undefined) x.prem = n.v;
  }
  // всем продажам без премии – посчитать и запомнить (ставки пришли позже продажи, импорт, старые смены)
  function premAll() {
    if (!premOn()) return;
    // один раз (1.56.2): пересчитать авто-премии «за месяц» – раньше большая сумма с оплатой «Месяц» считалась × 10%
    const redo = !localStorage.getItem('bsPremFix'), monthy = x => /^(Месяц|Доплата на лучш тариф \(месяц\))$/.test(salePay(x));
    const h = histGet(), s = salesGet(), todo = x => !x.premM && (x.prem === undefined || redo && x.prem != null && monthy(x));
    let ch = false;
    h.forEach(e => (e.sales || []).forEach(x => { if (todo(x)) { premSave(x, null, ymOf(e.d)); ch = ch || x.prem !== undefined; } }));
    if (ch) histSave(h);
    if (s.some(todo)) { const ym = ymOf(repSaved().d || ddmm(new Date())); s.forEach(x => { if (todo(x)) premSave(x, null, ym); }); salesSet(s); }
    if (redo) try { localStorage.setItem('bsPremFix', '1'); } catch (e) {}
  }
  // моя часть премии (по доле); null – не посчитана
  const premPart = x => x.cnt === false ? 0 : x.prem == null ? null : Math.round(x.prem * shareX(saleShare(x)) * 100) / 100;
  const premHow = x => shareHow(x.share);
  // премия по продажам: v – сумма моих частей, miss – сколько моих продаж без премии
  const premSum = sales => (sales || []).reduce((a, x) => { const p = premPart(x); if (p == null) a.miss++; else a.v = Math.round((a.v + p) * 100) / 100; return a; }, { v: 0, miss: 0 });
  const premWhy = x => x.prem === null ? 'сумма не по тарифу (доплата, скидка…) – открой продажу и впиши премию вручную' : 'ещё нет ставок из таблицы – подключи свою таблицу и открой «Историю»';
  // метка у продажи в списках: моя часть премии или «премия?»
  const premTag = x => {
    if (x.cnt === false || !premOn() && x.prem === undefined) return '';
    const p = premPart(x);
    return p == null ? '<b class="bs-prem-q" title="Премия не рассчитана: ' + premWhy(x) + '">премия?</b>' :
      '<b class="bs-prem-v" title="Премия' + (x.premM ? ' (вписана вручную)' : '') + ': ' + rubK(x.prem) + ' ₽' + premHow(x) + '">+' + rubK(p) + ' ₽</b>';
  };
  // поле «Премия» в форме продажи: пусто – считается сама (подсказка в placeholder), вписал – вручную
  function premPaint(box, x, was, ym, mine) {
    const l = box.querySelector('.bs-sale-prem'), i = l.querySelector('input'), sm = l.querySelector('small');
    l.hidden = !mine;
    if (!mine) return;
    if (document.activeElement !== i && x.premIn == null) i.value = x.premM ? String(x.prem).replace('.', ',') : '';
    const n = premNext(x, was, ym), auto = n.man ? premNext(Object.assign({}, x, { premIn: '', premM: 0 }), was, ym) : n;
    i.placeholder = auto.v ? 'сама: ' + rubK(auto.v) : auto.v === null ? 'не считается – впиши' : 'нет ставок из таблицы';
    sm.className = n.v == null ? 'bs-prem-q' : '';
    sm.textContent = n.v == null ? '(' + (n.v === null ? 'сумма не по тарифу – впиши вручную' : 'посчитается, когда будут ставки из таблицы') + ')' :
      '(твоя: ' + rubK(Math.round(n.v * shareX(x.share) * 100) / 100) + ' ₽' + (n.man ? ', вписана вручную' : '') + ')';
  }
  // в таблицу идут только продажи с моей долей
  const toSheet = x => x.cnt !== false && saleShare(x) > 0;
  // менеджеров для таблицы – из доли (0.5 → 2)
  const saleMops = x => Math.max(1, Math.round(1 / (+x.share || 1)));
  // shT – что стоит в строке таблицы (по последней сверке/отправке): {sum, email, mops}. Чем отличается от продажи
  const shDiff = x => {
    const t = x.sh && x.shT;
    if (!t) return [];
    const mail = (x.email || '').trim();
    return [t.sum !== saleTotal(x) && 'сумма ' + rub(t.sum) + ' ₽ → ' + rub(saleTotal(x)) + ' ₽',
      t.email.toLowerCase() !== mail.toLowerCase() && 'почта ' + (t.email || 'пусто') + ' → ' + (mail || 'пусто'),
      t.mops !== saleMops(x) && 'менеджеров ' + t.mops + ' → ' + saleMops(x)].filter(Boolean);
  };
  const shBad = x => shDiff(x).length > 0;
  // найденная в таблице строка: отметка ✓ и что в ней записано (старый скрипт этого не отдаёт)
  const shTab = r => r.sum != null ? { sum: +r.sum || 0, email: String(r.email || '').trim(), mops: +r.mops || 0 } : null;
  const shHere = (x, r) => { x.sh = 1; delete x.shAlso; delete x.shM; const t = shTab(r); if (t) x.shT = t; };
  const shSent = x => ({ sum: saleTotal(x), email: (x.email || '').trim(), mops: saleMops(x) });
  const sheetSale = (d, x) => ({
    d, dlg: x.dlg, name: x.name, kind: saleKind(x), pay: salePay(x), sum: saleTotal(x), email: (x.email || '').trim(),
    mops: saleMops(x), link: 'https://bluesales.ru/app/messenger/?dialogId=' + x.dlg,
    // сумма в таблице, если продажу потом поправили – по ней скрипт найдёт строку
    was: x.sh && x.shT && x.shT.sum !== saleTotal(x) ? x.shT.sum : undefined,
  });
  async function sheetPost(body, url) {
    url = url || sheetUrl();
    if (!url) throw new Error('таблица не подключена («История» → «Таблицы»)');
    let r;
    // text/plain – простой запрос, Google отвечает без предварительной проверки CORS
    try { r = await fetch(url, { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'text/plain;charset=utf-8' } }); }
    catch (e) { throw new Error('таблица не ответила – проверь интернет, ссылку и что в развёртывании доступ «Все»'); }
    let j; try { j = await r.json(); } catch (e) {}
    if (!j) throw new Error('таблица ответила не так (' + r.status + ') – проверь ссылку …/exec');
    if (!j.ok) throw new Error(j.msg || 'ошибка в таблице');
    return j;
  }
  // неотправленные продажи смены из истории – в таблицу; отправленные (и найденные там повторы) помечаем sh
  // only – номер одной продажи (кнопка «+ в табл.» у продажи)
  // строки таблицы с тем же человеком (чат или почта): в этом месяце – с другой суммой, в прошлом месяце – любые
  const alsoTxt = also => (also || []).map(a => (a.sheet ? a.sheet + ', ' : '') + 'стр. ' + a.row + (a.d ? ', ' + a.d : '') + ' – ' + rub(a.sum) + ' ₽').join('; ');
  // отправленные (✓) – вперёд: в таблице им достаются строки, остальным – что останется
  const shOrder = (list, get) => list.filter(o => get(o).sh).concat(list.filter(o => !get(o).sh));
  async function sheetSend(hi, end, only) {
    const e = histGet()[hi];
    if (!e || String(e.end) !== String(end)) throw new Error('смена изменилась – открой историю заново');
    let idx = e.sales.map((x, i) => i).filter(i => toSheet(e.sales[i]) && !e.sales[i].sh && (only == null || i === only));
    const st = { n: idx.length, add: 0, dup: 0, err: [], rows: [], skip: 0, late: 0 };
    if (!idx.length) return st;
    const h = histGet(), e2 = h[hi], same = e2 && String(e2.end) === String(end);
    const mark = (i, f) => { const x = same && e2.sales[i]; if (x && x.dlg === e.sales[i].dlg && x.name === e.sales[i].name) f(x); };
    // сначала смотрим, что уже есть: повторы не шлём, а про того же человека – спрашиваем.
    // Сверяем всю смену, отправленные первыми: две оплаты в одном чате на одну сумму – это две строки таблицы
    const all = shOrder(e.sales.map((x, i) => i).filter(i => toSheet(e.sales[i])), i => e.sales[i]);
    const f = await sheetPost({ find: all.map(i => sheetSale(e.d, e.sales[i])) }), warn = [];
    const checked = Array.isArray(f.res) && f.res.length === all.length;
    if (checked) {
      idx = idx.filter(i => {
        const r = f.res[all.indexOf(i)];
        if (r.st === 'dup') { st.dup++; mark(i, x => shHere(x, r)); return false; }
        if (r.also && r.also.length) warn.push({ i, t: alsoTxt(r.also) });
        return true;
      });
      if (warn.length) {
        const who = w => { const x = e.sales[w.i]; return '• ' + (x.who || x.fio || 'чат ' + x.dlg) + ' (' + rub(saleTotal(x)) + ' ₽): ' + w.t; };
        const rest = idx.length - warn.length;
        if (!confirm('У этого человека в таблице уже есть оплата – проверь, не ошибка ли:\n\n' + warn.map(who).join('\n') +
          '\n\nОК – всё равно отправить' + (rest ? ', Отмена – отправить только остальные (' + rest + ')' : ', Отмена – не отправлять'))) {
          const off = new Set(warn.map(w => w.i));
          st.skip = off.size;
          idx = idx.filter(i => !off.has(i));
        }
      }
    }
    if (idx.length) {
      // force – уже сверили: это отдельная оплата, даже если в чате есть строка на ту же сумму
      const j = await sheetPost({ sales: idx.map(i => Object.assign(sheetSale(e.d, e.sales[i]), checked ? { force: 1 } : {})) });
      idx.forEach((i, k) => {
        const r = (j.res || [])[k] || { st: 'err', msg: 'нет ответа' };
        if (r.st === 'err') return void st.err.push(r.msg);
        st[r.st === 'dup' ? 'dup' : 'add']++;
        if (r.st === 'add') st.rows.push(r.sheet + ', стр. ' + r.row);
        // тот же человек пришёл в этой же отправке – заранее не спросили
        if (r.also && r.also.length && !warn.some(w => w.i === i)) st.late++;
        mark(i, x => shHere(x, r.st === 'add' ? shSent(x) : r));
      });
    }
    if (same) histSave(h);
    return st;
  }
  // сверка с таблицей: какие продажи смены там правда есть (строки могли удалить руками) – правим отметки sh
  // list – смены [{hi, end}]; одним запросом
  async function sheetCheck(list) {
    const h0 = histGet(), items = [];
    list.forEach(({ hi, end }) => {
      const e = h0[hi];
      if (!e || String(e.end) !== String(end)) throw new Error('смена изменилась – открой историю заново');
      shOrder(e.sales.map((x, i) => ({ hi, end, i, x, d: e.d })).filter(o => toSheet(o.x)), o => o.x).forEach(o => items.push(o));
    });
    const st = { n: items.length, here: 0, gone: 0, miss: 0, also: 0, mops: 0, nosheet: '', err: [] };
    if (!items.length) return st;
    const j = await sheetPost({ find: items.map(o => sheetSale(o.d, o.x)) });
    if (!Array.isArray(j.res) || j.res.length !== items.length) throw new Error('обнови код скрипта в таблице («Таблицы» → «Скопировать код», потом Новая версия развёртывания)');
    const h = histGet();
    let ch = false;
    items.forEach((o, k) => {
      const r = j.res[k], e2 = h[o.hi], x = e2 && String(e2.end) === String(o.end) && e2.sales[o.i];
      const ok = x && x.dlg === o.x.dlg && x.name === o.x.name;
      if (r.st === 'err') return void st.err.push(r.msg);
      // листа за тот месяц в таблице уже нет – отметку оставляем как была
      if (r.st === 'nosheet') return void (st.nosheet = r.msg);
      if (r.st === 'dup') {
        st.here++;
        if (ok) { const was = JSON.stringify([x.sh, x.shAlso, x.shT]); shHere(x, r); if (JSON.stringify([x.sh, x.shAlso, x.shT]) !== was) ch = true; }
        const t = shTab(r);
        if (t && shBad(Object.assign({}, o.x, { sh: 1, shT: t }))) st.mops++;
        return;
      }
      if (o.x.sh) st.gone++; else st.miss++;
      const also = alsoTxt(r.also);
      if (also) st.also++;
      if (ok && (x.sh || (x.shAlso || '') !== also)) { delete x.sh; delete x.shT; if (also) x.shAlso = also; else delete x.shAlso; ch = true; }
    });
    if (ch) histSave(h);
    return st;
  }
  // ---------- Сверка «История ↔ таблица» по строкам: скрипт отдаёт строки оплат и премию за месяцы периода ----------
  // sheetTab – последний ответ: { months: [{y, m, sheet, prem (N1) | err}], rows, days: {дата: премия за день} }; old – скрипт старый; err – не сверилась
  let sheetTab = null;
  const ymOf = d => { const x = dmyDate(d); return x.getFullYear() * 100 + x.getMonth() + 1; };
  // строки за месяцы периода и прошлый месяц (там ищем «этот человек уже платил»), не больше года; false – скрипт старый
  async function tabFetch(from, to) {
    const h = histGet(), now = new Date();
    to = to || now;
    from = from || (h.length ? new Date(Math.min(...h.map(e => +dmyDate(e.d)))) : now);
    const cap = new Date(to.getFullYear(), to.getMonth() - 12, 1);
    let a = new Date(from.getFullYear(), from.getMonth() - 1, 1);
    if (a < cap) a = cap;
    const j = await sheetPost({ rows: { from: ddmm(a), to: ddmm(to) } });
    if (!Array.isArray(j.rows)) return false;
    sheetTab = { months: j.months || [], rows: j.rows, days: j.days || {} };
    const pc = premCfgs();
    let pch = false;
    sheetTab.months.forEach(m => { if (m.cfg && m.cfg.t) { pc[m.y * 100 + m.m] = m.cfg; pch = true; } });
    if (pch) { jset(PREM_KEY, pc); premAll(); }
    tabMatch(true);
    return true;
  }
  // каждой продаже – её строка, как в скрипте: тот же чат на листе месяца продажи, сначала сумма из таблицы (продажу могли
  // поправить), потом своя; отправленные (✓) – вперёд. Строки без пары – «только в таблице».
  // persist – по строкам обновить отметки у продаж в истории (✓, что записано в таблице, «у человека уже есть оплата»)
  function tabMatch(persist) {
    const t = sheetTab, res = { pair: new Map(), only: [] };
    if (!t || !t.rows) return res;
    const ms = new Set(t.months.filter(m => m.sheet).map(m => m.y * 100 + m.m)), h = histGet(), items = [], today = ddmm(new Date());
    // pair – по ключу «номер смены:номер продажи» (у сегодняшних – «now:номер»)
    h.forEach((e, hi) => { const ym = ymOf(e.d); if (ms.has(ym)) e.sales.forEach((x, si) => { if (toSheet(x)) items.push({ x, ym, k: hi + ':' + si }); }); });
    // сегодняшние ещё не отправлены, но если строку уже вписали руками – она не «только в таблице»
    if (ms.has(ymOf(today))) salesGet().forEach((x, si) => { if (toSheet(x)) items.push({ x, ym: ymOf(today), now: 1, k: 'now:' + si }); });
    const used = new Set();
    shOrder(items, o => o.x).forEach(o => {
      const c = t.rows.filter(r => !used.has(r) && r.ym === o.ym && r.dlg === String(o.x.dlg || ''));
      const was = o.x.sh && o.x.shT ? o.x.shT.sum : null;
      const r = (was != null && c.find(r => r.sum === was)) || c.find(r => r.sum === saleTotal(o.x));
      if (r) { used.add(r); res.pair.set(o.k, r); }
    });
    res.only = t.rows.filter(r => !used.has(r));
    if (!persist) return res;
    let ch = false;
    items.forEach(o => {
      if (o.now) return;
      const x = o.x, r = res.pair.get(o.k), was = JSON.stringify([x.sh, x.shAlso, x.shT]);
      if (r) shHere(x, r);
      else {
        delete x.sh; delete x.shT;
        const mail = (x.email || '').trim().toLowerCase(), prev = o.ym % 100 === 1 ? o.ym - 89 : o.ym - 1;
        const also = t.rows.filter(r => (r.ym === o.ym || r.ym === prev) && (r.dlg && r.dlg === String(x.dlg) || mail && r.email.toLowerCase() === mail))
          .map(r => ({ row: r.row, sum: r.sum, d: r.d.slice(0, 5), sheet: r.ym === o.ym ? '' : r.sheet }));
        if (also.length) x.shAlso = alsoTxt(also); else delete x.shAlso;
      }
      if (JSON.stringify([x.sh, x.shAlso, x.shT]) !== was) ch = true;
    });
    if (ch) histSave(h);
    return res;
  }
  // маленькие иконки линией – вместо смайликов
  const ico = (d, n) => '<svg viewBox="0 0 24 24" width="' + (n || 14) + '" height="' + (n || 14) + '" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + d + '</svg>';
  const ICO = { box: '<path d="M21 8v13H3V8M1 3h22v5H1zM10 12h4"/>', grid: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M3 15h18M9 3v18"/>',
    sync: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>', back: '<path d="M15 18l-6-6 6-6"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>' };
  // строка карточки сверки: точка-статус, что за таблица, как дела, кнопки
  const syncRow = (lbl, st, txt, btns) => '<div class="bs-sync-r"><i class="bs-dot" data-st="' + st + '"></i><b>' + lbl + '</b><span>' + txt + '</span>' + (btns || '') + '</div>';
  // карточка над списком смен: своя таблица и таблица отдела – по строке, справа премия за месяц (N1) и «обновить».
  // Пока идёт сверка, показываем прошлый результат, крутится только значок – без мигания текста
  function syncCard(from, to, cnt, tcnt) {
    if (!sheetUrl()) return '';
    let mine, prem = '';
    if (!sheetTab) mine = syncRow('Своя таблица', 'wait', 'сверяю…');
    else if (sheetTab.old) mine = syncRow('Своя таблица', 'warn', 'обнови код скрипта («Таблицы» → «Скопировать код», потом новая версия развёртывания) – тогда будет премия и сверка всех строк');
    else if (sheetTab.err) mine = syncRow('Своя таблица', 'err', 'не сверилась: ' + esc(sheetTab.err));
    else {
      const lo = from ? from.getFullYear() * 100 + from.getMonth() + 1 : 0, hi = to ? to.getFullYear() * 100 + to.getMonth() + 1 : 1e9;
      const months = sheetTab.months.filter(m => m.y * 100 + m.m >= lo && m.y * 100 + m.m <= hi && (from || m.sheet));
      const nos = months.filter(m => !m.sheet).map(m => MONTHS[m.m - 1]);
      prem = months.filter(m => m.sheet && m.prem != null).map(m => premMonHtml(premOn() ? premSum([].concat(...histAll().filter(e => ymOf(e.d) === m.y * 100 + m.m).map(e => e.sales || []))) : null,
        m.prem, 'премия за ' + MONTHS[m.m - 1], m.y * 100 + m.m)).join('');
      const bad = [cnt.miss && 'не отправлено ' + cnt.miss, cnt.bad && 'расходится ' + cnt.bad, cnt.only && 'только в таблице ' + cnt.only].filter(Boolean);
      mine = syncRow('Своя таблица', bad.length || nos.length ? 'warn' : 'ok', (bad.length ? bad.join(' · ') : 'всё сходится') + (nos.length ? ' · нет листа за ' + nos.join(', ') : ''),
        (cnt.imp ? '<button data-a="tabimp" title="Все оплаты за период, которых нет в помощнике, – в историю, каждую в смену своего дня">Забрать ' + cnt.imp + '</button>' : '') +
        (cnt.miss ? '<button data-a="tabexp" title="Все продажи за период, которых нет в таблице, – в таблицу">Отправить ' + cnt.miss + '</button>' : ''));
    }
    return '<div class="bs-sync' + (sheetBusy || teamBusy ? ' busy' : '') + '"><div class="bs-sync-l">' + mine + (teamOn() ? teamRow(tcnt) : '') + '</div>' +
      (prem ? '<div class="bs-sync-p">' + prem + '</div>' : '') +
      '<button data-a="tabsync" class="bs-sync-btn" title="Заново прочитать таблицы и сверить с историей">' + ico(ICO.sync, 15) + '</button></div>';
  }
  // строка таблицы → продажа в историю (уже записана в таблице – сразу ✓). ФИО и тариф потом можно поправить
  const tabSale = (r, n) => ({ id: Date.now().toString(36) + r.row + 'r' + (n || 0), dlg: r.dlg, name: r.name, price: r.sum, disc: '', mops: [], share: shareFor(r.mops || 1), cnt: true,
    fio: '', who: '', email: r.email, pay: PAYS.some(p => p[0] === r.pay) ? r.pay : undefined, sh: 1, shT: shTab(r) });
  // оплаты дня, которые есть только в таблице
  function onlyHtml(e, rs) {
    if (!rs.length) return '';
    const add = !e.now;   // в идущую смену не добавляем – она ещё не в истории
    return '<div class="bs-hist-onlyh"><span>Только в таблице – в помощнике этих оплат нет</span>' + (add && rs.length > 1 ? '<button data-a="tabadd" data-d="' + e.d + '" class="bs-hist-sh">+ все</button>' : '') + '</div>' +
      rs.map(r => '<div class="bs-hist-s bs-hist-only" title="' + esc(r.sheet + ', стр. ' + r.row + (r.email ? ', ' + r.email : '')) + '"><span>' + esc(r.name || 'без продукта') + (r.dlg ? '' : ' <small>(без ссылки на чат)</small>') + '</span>' +
        '<span>' + rub(r.sum) + ' ₽ · ' + frac(shareFor(r.mops || 1)) + '</span>' +
        (add ? '<button data-a="tabadd" data-r="' + esc(r.sheet + ':' + r.row) + '" class="bs-hist-sh bs-warn" title="Добавить эту оплату продажей в смену ' + e.d + '">+ сюда</button>' : '<b class="bs-hist-sh" title="Добавишь, когда закроешь смену">табл.</b>') + '<s class="bs-hist-sgap"></s></div>').join('');
  }
  // сумма, почта и число менеджеров в таблице – как в продаже (поправили в помощнике после отправки). only – одна продажа.
  // Шлём всю смену в том же порядке, что и сверка, – тогда каждой продаже достаётся её строка
  async function sheetFix(hi, end, only) {
    const e = histGet()[hi];
    if (!e || String(e.end) !== String(end)) throw new Error('смена изменилась – открой историю заново');
    const all = shOrder(e.sales.map((x, i) => i).filter(i => toSheet(e.sales[i])), i => e.sales[i]);
    const want = i => shBad(e.sales[i]) && (only == null || i === only);
    const st = { n: all.filter(want).length, fix: 0, gone: 0, err: [] };
    if (!st.n) return st;
    const j = await sheetPost({ fix: all.map(i => Object.assign(sheetSale(e.d, e.sales[i]), want(i) ? { fix: 1 } : {})) });
    if (!Array.isArray(j.res) || j.res.length !== all.length) throw new Error('обнови код скрипта в таблице («Таблицы» → «Скопировать код», потом Новая версия развёртывания)');
    const h = histGet(), e2 = h[hi];
    if (!e2 || String(e2.end) !== String(end)) throw new Error('смена изменилась – открой историю заново');
    all.forEach((i, k) => {
      if (!want(i)) return;
      const r = j.res[k], x = e2.sales[i], ok = x && x.dlg === e.sales[i].dlg && x.name === e.sales[i].name;
      if (r.st === 'fix') { st.fix++; if (ok) shHere(x, r); return; }
      if (r.st === 'err' || r.st === 'nosheet') return void st.err.push(r.msg);
      // строки уже нет – значит, и отметка ✓ неверна
      st.gone++;
      if (ok) { delete x.sh; delete x.shT; }
    });
    histSave(h);
    return st;
  }
  const fixMsg = st => [st.fix && 'исправил в таблице: ' + st.fix, st.gone && 'не нашёл в таблице ' + st.gone + ' – отправь заново',
    st.err.length && 'не вышло ' + st.err.length + ': ' + st.err.join('; ')].filter(Boolean).join(' · ') || 'исправлять нечего';
  // сверка при открытии истории: какие смены сейчас сверяются и чем кончилась прошлая
  let sheetBusy = null, sheetAutoErr = null, sheetTok = 0, sheetLast = null, histPaint = () => {};
  const checkMsg = st => [!st.nosheet && st.here + ' из ' + st.n + ' в таблице', st.gone && 'пропали из таблицы ' + st.gone,
    st.nosheet && st.nosheet + ' – отметки оставил как были',
    st.err.length && 'не вышло ' + st.err.length + ': ' + st.err.join('; '), st.gone + st.miss > 0 && 'чего нет – отправь кнопкой «+ в табл.» или «Отправить»',
    st.also && '⚠ у ' + st.also + ' человек в таблице уже есть оплата – перепроверь',
    st.mops && '⚠ у ' + st.mops + ' продаж в таблице записано не то, что в помощнике (сумма, почта или менеджеры) – нажми «↻ табл.» или «Исправить»'].filter(Boolean).join(' · ');
  const sheetMsg = st => !st.n ? 'новых продаж для таблицы нет' :
    [st.add && 'добавлено ' + st.add + (st.rows.length ? ' (' + st.rows.join('; ') + ')' : ''), st.dup && 'уже были в таблице ' + st.dup, st.skip && 'не отправил ' + st.skip + ' – перепроверь', st.late && '⚠ у ' + st.late + ' человек в таблице теперь несколько оплат – перепроверь', st.err.length && 'не вышло ' + st.err.length + ': ' + st.err.join('; ')].filter(Boolean).join(' · ');
  // низ раскрытой смены: сколько продаж уже в таблице – чипом (нажал – сверить), и кнопки «Исправить» / «Отправить»
  function sheetLine(e) {
    const xs = e.sales.filter(toSheet);
    if (e.now || !sheetUrl() || !xs.length) return ['', ''];
    const done = xs.filter(x => x.sh).length, bad = xs.filter(shBad).length;
    const err = sheetAutoErr && sheetAutoErr.keys.has(e.hi + ':' + e.end) ? sheetAutoErr.msg : '';
    const tip = (done === xs.length ? 'Все продажи смены есть в таблице' : 'В таблице ' + done + ' из ' + xs.length) + (bad ? '. У ' + bad + ' там записано не то, что тут' : '') +
      (err ? '. Не сверилась: ' + err : '') + '. Нажми – сверить эту смену с таблицей';
    return ['<button data-a="sheetchk" class="bs-chip" data-st="' + (err ? 'err' : bad || done < xs.length ? 'warn' : 'ok') + '" title="' + esc(tip) + '">таблица ' + done + '/' + xs.length + '</button>',
      (bad ? '<button data-a="sheetfix" title="Записать в таблицу сумму, почту и число менеджеров как в продажах">Исправить' + (bad > 1 ? ' ' + bad : '') + '</button>' : '') +
      (done < xs.length ? '<button data-a="sheet" title="Отправить все продажи без отметки">Отправить' + (xs.length - done > 1 ? ' ' + (xs.length - done) : '') + '</button>' : '')];
  }
  // низ раскрытой смены одной строкой: моя / не моя, чипы таблиц, действия; «Перенести» раскрывает поле даты
  function histActHtml(e, f, today) {
    const unset = e.now && e.mine == null;
    const tip = [e.mine == null && (e.now ? 'Не отмечена: «Закрыть смену» отметит твоей, а если день закроется сам – не твоей' : 'Угадано по работе за день'),
      !unset && !shiftMine(e) && 'Лиды, чаты и ссылки чужой смены не идут в итог'].filter(Boolean).join('. ');
    const [sChip, sBtns] = sheetLine(e), tm = f.team ? teamDayHtml(e.d, f.team) : ['', ''];
    return '<p class="bs-hist-act"><span class="bs-seg"' + (tip ? ' title="' + esc(tip) + '"' : '') + '>' +
      [[1, 'моя'], [0, 'не моя']].map(([v, t]) => '<em data-a="mine" data-v="' + v + '"' + (!unset && +shiftMine(e) === v ? ' class="on"' : '') + '>' + t + '</em>').join('') + '</span>' +
      '<span class="bs-hist-st">' + sChip + tm[0] + '</span>' +
      '<button data-a="hrep" title="Отчёт за день' + (e.now ? ' – смена ещё идёт' : '') + '">Отчёт</button>' + sBtns + tm[1] +
      (e.now ? '' : '<button data-a="moveask" title="Поменять дату смены">Перенести</button>') + '</p>' +
      (e.now ? '' : '<p class="bs-hist-mv"><span>Новая дата смены</span><input type="date" value="' + isoOf(dmyDate(e.d)) + '" max="' + today + '"><button data-a="move" class="bs-main">Перенести</button><button data-a="moveask">Отмена</button></p>');
  }
  function openSheet() {
    closeSale();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-backup bs-sheet"><div class="bs-rep-head"><i data-a="back" class="bs-back" title="Назад к истории">' + ico(ICO.back, 18) + '</i><b>Таблицы</b><i title="Закрыть">×</i></div>' +
      '<section><h4>Своя таблица</h4><p class="bs-sheet-sub">Продажи с твоей долей уходят туда сами, когда закрываешь смену.</p>' +
      '<details' + (sheetUrl() ? '' : ' open') + '><summary>Как подключить</summary><ol class="bs-tar-help"><li>В таблице: Расширения → Apps Script.</li>' +
      '<li>Сотри всё и вставь код <button data-a="code">Скопировать код</button> (или <a href="' + SHEET_CODE + '" target="_blank">открой текстом</a>), сохрани.</li>' +
      '<li>Развернуть → Новое развёртывание → «Веб-приложение»: от имени «меня», доступ «Все».</li><li>Вставь сюда ссылку, которая кончается на /exec.</li></ol></details>' +
      '<label><span>Ссылка на скрипт</span><input data-k="url" placeholder="https://script.google.com/macros/s/…/exec" spellcheck="false"></label>' +
      '<div class="bs-sale-note"></div>' +
      '<div class="bs-rep-btns">' + (sheetUrl() ? '<button data-a="off" class="bs-sale-del">Отключить</button>' : '') + '<span class="bs-sp"></span><button data-a="check" class="bs-main">Сохранить</button></div></section>' +
      '<section class="bs-team-set"><h4>Таблица отдела <small>необязательно</small></h4><p class="bs-sheet-sub">Оттуда – лиды, чаты и ссылки для старых смен, туда – продано и сумма.</p>' +
      '<details><summary>Подробнее</summary><div class="bs-tar-help">По твоему блоку помощник отмечает «моя / не моя» (цифры – моя, «выходной» – нет). В пустые клетки пишет сразу, поверх чужих цифр – только после твоего «ок». ' +
      'Чужие блоки и формулы не трогает. Работает через тот же скрипт – если он старый, обнови код и сделай новую версию развёртывания.</div></details>' +
      '<label><span>Ссылка на таблицу</span><input data-k="turl" placeholder="https://docs.google.com/spreadsheets/d/…" spellcheck="false"></label>' +
      '<div class="bs-sheet-2"><label><span>Имя, как в столбце A</span><input data-k="tname" placeholder="Имя"></label>' +
      '<label title="Пусто – с месяца первой смены в истории"><span>Брать с</span><input data-k="tfrom" type="date"></label></div>' +
      '<div class="bs-sale-note bs-team-note"></div>' +
      '<div class="bs-rep-btns">' + (teamCfg().url ? '<button data-a="teamoff" class="bs-sale-del">Отключить</button>' : '') + '<span class="bs-sp"></span><button data-a="team" class="bs-main">Сохранить</button></div></section>' +
      '<section class="bs-team-set"><h4>Таблица ОКК <small>необязательно</small></h4><p class="bs-sheet-sub">Оттуда – KPI за месяц: премия умножается на 0,9 / 1 / 1,1. Хватит доступа на просмотр.</p>' +
      '<details><summary>Подробнее</summary><div class="bs-tar-help">Помощник ищет лист с твоим именем: месяцы – в шапке, KPI – в строке «KPI за день». Если такого листа нет – берёт KPI за текущий месяц со сводного листа (имя в столбце A). ' +
      'Ничего туда не пишет. Работает через тот же скрипт – если он старый, обнови код и сделай новую версию развёртывания.</div></details>' +
      '<label><span>Ссылка на таблицу</span><input data-k="ourl" placeholder="https://docs.google.com/spreadsheets/d/…" spellcheck="false"></label>' +
      '<label><span>Имя, как в таблице ОКК</span><input data-k="oname" placeholder="Имя"></label>' +
      '<div class="bs-sale-note bs-okk-note"></div>' +
      '<div class="bs-rep-btns">' + (okkCfg().url ? '<button data-a="okkoff" class="bs-sale-del">Отключить</button>' : '') + '<span class="bs-sp"></span><button data-a="okk" class="bs-main">Сохранить</button></div></section></div>';
    document.body.appendChild(wrap);
    const inp = wrap.querySelector('[data-k=url]'), note = wrap.querySelector('.bs-sale-note');
    const tUrl = wrap.querySelector('[data-k=turl]'), tName = wrap.querySelector('[data-k=tname]'), tNote = wrap.querySelector('.bs-team-note');
    inp.value = sheetUrl();
    const tFrom = wrap.querySelector('[data-k=tfrom]');
    tUrl.value = teamCfg().url || ''; tName.value = teamCfg().name || ''; tFrom.value = teamCfg().from || '';
    const oUrl = wrap.querySelector('[data-k=ourl]'), oName = wrap.querySelector('[data-k=oname]'), oNote = wrap.querySelector('.bs-okk-note');
    oUrl.value = okkCfg().url || ''; oName.value = okkCfg().name || '';
    wrap.addEventListener('click', async ev => {
      const t = ev.target, a = t.dataset.a;
      if (a === 'back') return openSales('hist');
      if (t.matches('.bs-rep-head i')) return closeSale();
      if (a === 'code') {
        t.disabled = true;
        try {
          const r = await fetch(SHEET_CODE, { cache: 'no-store' });
          if (!r.ok) throw 0;
          await navigator.clipboard.writeText(await r.text());
          t.textContent = 'Скопировано ✓';
        } catch (err) { t.textContent = 'Не вышло – открой текстом'; }
        t.disabled = false;
        return;
      }
      if (a === 'off') {
        if (!confirm('Отключить таблицу? Ссылка удалится из помощника, сама таблица и скрипт останутся.')) return;
        localStorage.removeItem(SHEET_KEY);
        return openSales('hist');
      }
      if (a === 'teamoff') {
        if (!confirm('Отключить таблицу отдела? Ссылка и имя удалятся из помощника, сама таблица останется.')) return;
        localStorage.removeItem(TEAM_KEY);
        teamTab = null;
        return openSales('hist');
      }
      if (a === 'okkoff') {
        if (!confirm('Отключить таблицу ОКК? Ссылка и имя удалятся из помощника, KPI в премии больше не учитывается.')) return;
        localStorage.removeItem(OKK_KEY);
        localStorage.removeItem(KPI_KEY);
        return openSales('hist');
      }
      if (a === 'okk') {
        const surl = SHEET_RX.test(inp.value.trim()) ? inp.value.trim() : sheetUrl(), url = oUrl.value.trim(), name = oName.value.trim();
        if (!surl) return void (oNote.textContent = 'Сначала подключи свою таблицу выше – ОКК читается через тот же скрипт');
        if (!/\/spreadsheets\/d\/[\w-]{20,}/.test(url)) return void (oNote.textContent = 'Нужна ссылка вида https://docs.google.com/spreadsheets/d/…');
        if (!name) return void (oNote.textContent = 'Впиши имя, как оно стоит в таблице ОКК (название листа)');
        t.disabled = true; oNote.textContent = 'Проверяю…';
        try {
          const j = await okkRead({ url, name }, surl);
          jset(OKK_KEY, { url, name });
          const ms = Object.keys(j.months).sort();
          oNote.textContent = '✓ Подключено. Лист «' + j.sheet + '», KPI: ' + (ms.length ? ms.map(k => MONTHS[k % 100 - 1] + ' ' + kq(j.months[k]) + '%').join(', ') : 'пока нет');
        } catch (err) { oNote.textContent = 'Не вышло: ' + err.message; }
        t.disabled = false;
        return;
      }
      if (a === 'team') {
        const surl = SHEET_RX.test(inp.value.trim()) ? inp.value.trim() : sheetUrl(), url = tUrl.value.trim(), name = tName.value.trim();
        if (!surl) return void (tNote.textContent = 'Сначала подключи свою таблицу выше – отдел работает через тот же скрипт');
        if (!/\/spreadsheets\/d\/[\w-]{20,}/.test(url)) return void (tNote.textContent = 'Нужна ссылка вида https://docs.google.com/spreadsheets/d/…');
        if (!name) return void (tNote.textContent = 'Впиши имя, как оно стоит в столбце A таблицы отдела');
        t.disabled = true; tNote.textContent = 'Проверяю…';
        try {
          const now = new Date(), j = await sheetPost({ team: { url, name, from: ddmm(now), to: ddmm(now) } }, surl);
          if (!j.days) throw new Error('обнови код скрипта (кнопка «Скопировать код» выше) и сделай новую версию развёртывания');
          jset(TEAM_KEY, Object.assign({ url, name }, /^\d{4}-\d\d-\d\d$/.test(tFrom.value) ? { from: tFrom.value } : {}));
          teamTab = null;
          const miss = TEAM_K.filter(([k]) => !(j.rows || []).includes(k)).map(x => x[1]);
          tNote.textContent = '✓ Подключено. Лист «' + j.sheet + '», нашёл строки: ' + TEAM_K.filter(([k]) => (j.rows || []).includes(k)).map(x => x[1]).join(', ') +
            (miss.length ? ' (нет: ' + miss.join(', ') + ')' : '') + (j.days[ddmm(now)] ? '' : '. Столбца за сегодня пока нет') +
            (teamStart() ? '. Беру с ' + ddmm(teamStart()) : '');
        } catch (err) { tNote.textContent = 'Не вышло: ' + err.message; }
        t.disabled = false;
        return;
      }
      if (a !== 'check') return;
      const url = inp.value.trim();
      if (!SHEET_RX.test(url)) return void (note.textContent = 'Нужна ссылка вида https://script.google.com/macros/s/…/exec');
      t.disabled = true; note.textContent = 'Проверяю…';
      try {
        const j = await sheetPost({ ping: 1 }, url);
        if (!(j.sheets || []).length) throw new Error('скрипт работает, но не нашёл лист продаж – нужна шапка «Продукт» в A1 и «Дата» в O1');
        jset(SHEET_KEY, { url });
        note.textContent = '✓ Подключено. Листы продаж: ' + j.sheets.join(', ');
      } catch (err) { note.textContent = 'Не вышло: ' + err.message; }
      t.disabled = false;
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  // ---------- Таблица ОКК: KPI за месяц для премии. Только читаем, через тот же скрипт ----------
  // Ссылка и имя – только в этом браузере (bsOkk). Прочитанное – в bsKpi {гггг*100+мм: KPI в %}: KPI меняется по ходу месяца,
  // перечитываем при открытии «Смены» не чаще раза в 10 минут
  const OKK_KEY = 'bsOkk';
  const okkCfg = () => jget(OKK_KEY, {});
  const okkOn = () => !!(sheetUrl() && okkCfg().url && okkCfg().name);
  let okkPaint = () => {}, okkLast = 0, okkBusy = false;
  async function okkRead(c, url) {
    const j = await sheetPost({ okk: { url: c.url, name: c.name } }, url);
    if (!j.months) throw new Error('обнови код скрипта в таблице («Таблицы» → «Скопировать код», потом новая версия развёртывания)');
    jset(KPI_KEY, j.months);
    return j;
  }
  function okkSync() {
    if (!okkOn() || okkBusy || Date.now() - okkLast < 6e5) return;
    okkBusy = true; okkLast = Date.now();
    const was = localStorage.getItem(KPI_KEY);
    okkRead(okkCfg()).catch(() => {}).then(() => { okkBusy = false; if (localStorage.getItem(KPI_KEY) !== was) okkPaint(); });
  }
  // ---------- Таблица отдела (общая): свой блок по дням – лиды, чаты, ссылки, продано, сумма. Через тот же скрипт ----------
  // Ссылка на таблицу отдела и имя в ней – только в этом браузере (bsTeam). Лиды, чаты и ссылки там – правда (их вписывают руками):
  // ими дополняем старые смены. Продано и сумма – правда в помощнике: их пишем в отдел (в пустые клетки сразу, поверх цифр – после «ок»)
  const TEAM_KEY = 'bsTeam', TEAM_K = [['leads', 'лиды'], ['chats', 'чаты'], ['links', 'ссылки'], ['bought', 'продано'], ['sum', 'сумма']];
  const teamCfg = () => jget(TEAM_KEY, {});
  // с какого дня брать таблицу отдела: из настроек, иначе – с 1-го числа месяца первой смены в истории (раньше – не нужно)
  function teamStart() {
    const f = teamCfg().from;
    if (f) return new Date(f + 'T00:00');
    const ds = histGet().map(e => dmyDate(e.d)).filter(d => !isNaN(d));
    if (!ds.length) return null;
    const m = new Date(Math.min(...ds));
    return new Date(m.getFullYear(), m.getMonth(), 1);
  }
  const teamOn = () => !!(sheetUrl() && teamCfg().url && teamCfg().name);
  // teamTab – последнее чтение: { days: {дата: {leads, …}}, sheet, got – скольким сменам дописали } | { err }
  let teamTab = null, teamBusy = false;
  const teamOff = v => typeof v === 'string' && /выход/.test(v);
  const teamV = (k, v) => v == null ? 'пусто' : typeof v === 'string' ? '«' + v + '»' : k === 'sum' ? rub(v) + ' ₽' : k === 'bought' ? r2s(v) : v;
  const teamLbl = k => TEAM_K.find(x => x[0] === k)[1];
  async function teamRead(from, to) {
    const c = teamCfg(), j = await sheetPost({ team: { url: c.url, name: c.name, from: from ? ddmm(from) : '', to: ddmm(to) } });
    if (!j.days) throw new Error('обнови код скрипта в таблице («Таблицы» → «Скопировать код», потом новая версия развёртывания)');
    return j;
  }
  async function teamWrite(cells) {
    const c = teamCfg(), j = await sheetPost({ teamPut: { url: c.url, name: c.name, cells } });
    if (!Array.isArray(j.res) || j.res.length !== cells.length) throw new Error('обнови код скрипта в таблице');
    const st = { ok: 0, changed: 0, formula: 0, nocol: 0, norow: 0 };
    j.res.forEach(r => { st[r] = (st[r] || 0) + 1; });
    return st;
  }
  const teamMsg = st => [st.ok && 'записал ' + st.ok + ' ' + plural(st.ok, 'клетку', 'клетки', 'клеток'), st.changed && '⚠ ' + st.changed + ' не тронул – там уже вписали другое, сверь заново',
    st.formula && st.formula + ' – там формула, не трогал', st.nocol && st.nocol + ' – нет столбца этой даты', st.norow && st.norow + ' – нет такой строки в блоке'].filter(Boolean).join(' · ') || 'записывать нечего';
  // за период (весь – с teamStart): читаем свой блок и дополняем им историю
  async function teamFetch(from, to) {
    const st = teamStart();
    const j = await teamRead(st && (!from || from < st) ? st : from, to || new Date());
    teamTab = { days: j.days, sheet: j.sheet, got: teamApply(j.days) };
  }
  // смены, которые уже есть: «моя / не моя» (если не отмечена) – по блоку: цифры – моя, «выходной» – не моя;
  // лиды, чаты и ссылки – если в смене их нет. Возвращает, скольким сменам что-то дописали
  function teamApply(days) {
    const h = histGet();
    let n = 0;
    Object.keys(days).forEach(d => {
      const t = days[d], es = h.filter(e => e.d === d), num = typeof t.leads === 'number', off = teamOff(t.leads);
      if (!es.length || !num && !off) return;
      let ch = false;
      es.forEach(e => { e.rep = e.rep || {}; if (e.mine == null) { e.mine = num; ch = true; } });
      const e = num && es.filter(shiftMine).pop();
      if (e) ['leads', 'chats', 'links'].forEach(k => { if (typeof t[k] === 'number' && (e.rep[k] == null || e.rep[k] === '')) { e.rep[k] = t[k]; ch = true; } });
      if (ch) n++;
    });
    if (n) histSave(h);
    return n;
  }
  // что записать в столбец дня. put – сразу: пустые клетки (лиды, чаты, ссылки – только в мою смену) и «выходной» в продано/сумме,
  // если в тот день были оплаты; over – там другие продано/сумма: только после «ок». Лиды, чаты, ссылки поверх цифр не пишем
  function teamCells(d, t, h) {
    const es = h.filter(e => e.d === d), res = { put: [], over: [] };
    if (!es.length || !t) return res;
    const mine = es.some(shiftMine);
    // продажи дня помощник знает, если в смене есть продажи или цифры продаж (смена из таблицы отдела – только лиды, чаты, ссылки)
    const sold = es.some(e => (e.sales || []).length || e.rep && (e.rep.bought != null || e.rep.sum != null));
    const total = k => Math.round(es.reduce((a, e) => a + (+(e.rep || {})[k] || 0), 0) * 100) / 100;
    const work = k => { const xs = es.filter(e => shiftMine(e) && e.rep && e.rep[k] != null && e.rep[k] !== ''); return xs.length ? xs.reduce((a, e) => a + (+e.rep[k] || 0), 0) : null; };
    TEAM_K.forEach(([k]) => {
      if (!(k in t)) return;   // такой строки в блоке нет
      const was = t[k], money = k === 'bought' || k === 'sum', v = money ? sold ? total(k) : null : mine ? work(k) : null;
      // 0 лидов или чатов в рабочий день – скорее не посчиталось, такое не пишем
      if (v == null || !v && (k === 'leads' || k === 'chats')) return;
      const c = { d, k, v, was };
      if (was == null) { if (mine || v > 0) res.put.push(c); }
      else if (typeof was === 'string') { if (money && v > 0) res.put.push(c); }
      else if (money && Math.abs(was - v) > 0.005) res.over.push(c);
    });
    return res;
  }
  // клетки списком по дням: «• 15.09: продано 2 → 3, сумма 10 000 ₽ → 13 000 ₽»
  const teamList = (cs, arrow) => {
    const by = {};
    cs.forEach(c => (by[c.d] = by[c.d] || []).push(c));
    return Object.keys(by).sort((a, b) => dmyDate(a) - dmyDate(b)).map(d => '• ' + d.slice(0, 5) + ': ' +
      by[d].map(c => teamLbl(c.k) + ' ' + (arrow || c.was != null ? teamV(c.k, c.was) + ' → ' : '') + teamV(c.k, c.v)).join(', ')).join('\n');
  };
  const teamDays = cs => new Set(cs.map(c => c.d)).size;
  // строка карточки сверки: что в таблице отдела не так, как в помощнике
  function teamRow(cnt) {
    if (!teamTab) return syncRow('Отдел', 'wait', 'читаю…');
    if (teamTab.err) return syncRow('Отдел', 'err', 'не прочиталась: ' + esc(teamTab.err));
    const put = teamDays(cnt.put), over = teamDays(cnt.over), all = teamDays(cnt.put.concat(cnt.over));
    const bad = [put && 'дописать ' + put + ' ' + plural(put, 'день', 'дня', 'дней'), over && 'расходится ' + over + ' ' + plural(over, 'день', 'дня', 'дней')].filter(Boolean);
    return syncRow('Отдел', bad.length ? 'warn' : 'ok', (bad.length ? bad.join(' · ') : 'всё сходится') +
      (teamTab.got ? ' · дописал ' + teamTab.got + ' ' + plural(teamTab.got, 'смене', 'сменам', 'сменам') : ''),
      (cnt.fresh.length ? '<button data-a="teamimp" title="Дни, где у тебя в таблице отдела цифры, а в помощнике смены нет, – в историю (лиды, чаты, ссылки)">Забрать смены ' + cnt.fresh.length + '</button>' : '') +
      (all ? '<button data-a="teamexp" title="Записать в таблицу отдела цифры помощника – перед записью покажу список">В отдел ' + all + '</button>' : ''));
  }
  // таблица отдела в раскрытой смене: чип (цифры дня – в подсказке) и кнопка «В отдел», если что-то не так
  function teamDayHtml(d, c) {
    const t = teamOn() && teamTab && teamTab.days && teamTab.days[d];
    if (!t) return ['', ''];
    const bad = c.put.concat(c.over);
    const nums = 'В таблице отдела: ' + TEAM_K.filter(([k]) => k in t).map(([k, l]) => l + ' ' + (t[k] == null ? '–' : typeof t[k] === 'string' ? t[k] : k === 'sum' ? rub(t[k]) + ' ₽' : k === 'bought' ? frac(t[k]) : t[k])).join(', ');
    const txt = c.over.length ? 'в отделе ' + c.over.map(x => teamLbl(x.k) + ' ' + teamV(x.k, x.was)).join(', ') : c.put.length ? 'в отделе пусто: ' + c.put.map(x => teamLbl(x.k)).join(', ') : 'отдел';
    return ['<i class="bs-chip" data-st="' + (bad.length ? 'warn' : 'ok') + '" title="' + esc(nums + (bad.length ? '\n\nНадо записать:\n' + teamList(bad) : '')) + '">' + esc(txt) + '</i>',
      bad.length ? '<button data-a="teamexp" data-d="' + d + '" title="Записать в таблицу отдела цифры этого дня – перед записью покажу список">В отдел</button>' : ''];
  }
  // после «Закрыть смену»: цифры дня – в пустые клетки его столбца (и вместо «выходного», если были оплаты)
  async function teamCloseDay(d) {
    const j = await teamRead(dmyDate(d), dmyDate(d)), t = j.days[d];
    if (!t) throw new Error('нет столбца ' + d.slice(0, 5) + ' – добавь его в таблицу отдела, потом «В отдел» в истории');
    const c = teamCells(d, t, histGet());
    const st = c.put.length ? await teamWrite(c.put) : null;
    return [c.put.length ? 'записал ' + teamList(c.put).replace(/^• /, '') : '', st && st.ok < c.put.length ? teamMsg(st) : '',
      c.over.length ? '⚠ там уже ' + c.over.map(x => teamLbl(x.k) + ' ' + teamV(x.k, x.was) + ', у тебя ' + teamV(x.k, x.v)).join('; ') + ' – поправь в «Истории» («В отдел»)' : ''].filter(Boolean).join(' · ') || 'всё уже вписано';
  }
  // ---------- Резервная копия: все данные помощника (ключи bs* в localStorage) в файл и обратно ----------
  const bakKeys = () => Object.keys(localStorage).filter(k => /^bs[A-Z]/.test(k));
  function backupSave() {
    const data = {};
    bakKeys().forEach(k => { data[k] = localStorage.getItem(k); });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ app: 'bluesales-helper', t: Date.now(), data }, null, 1)], { type: 'application/json' }));
    a.download = 'bluesales-helper-' + ddmm(new Date()) + '.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }
  function backupLoad(file) {
    file.text().then(t => {
      let j; try { j = JSON.parse(t); } catch (e) {}
      if (!j || j.app !== 'bluesales-helper' || !j.data) return alert('Это не файл копии помощника.');
      if (!confirm('Загрузить копию от ' + new Date(j.t).toLocaleString('ru-RU') + '? Текущие данные помощника (продажи, отчёт, черновики, напоминания, шаблоны) заменятся данными из файла.')) return;
      bakKeys().forEach(k => localStorage.removeItem(k));
      Object.keys(j.data).forEach(k => { if (/^bs[A-Z]/.test(k)) localStorage.setItem(k, j.data[k]); });
      location.reload();
    });
  }
  function openBackup() {
    closeSale();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-backup"><div class="bs-rep-head"><b>Резервная копия</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-tar-help">Данные помощника живут только в этом браузере: продажи и отчёт смены, черновики, закрепы, напоминания, тарифы, шаблоны, смайлики. Если почистить кэш или сесть за другой компьютер – их не будет. «Скачать» сохраняет всё в файл (в «Загрузки»), «Загрузить» – возвращает из файла.</div>' +
      '<input type="file" accept=".json,application/json" hidden>' +
      '<div class="bs-rep-btns"><button data-a="back">Назад</button><button data-a="load">Загрузить из файла</button><button data-a="save" class="bs-main">Скачать копию</button></div></div>';
    document.body.appendChild(wrap);
    const inp = wrap.querySelector('input[type=file]');
    inp.addEventListener('change', () => { if (inp.files[0]) backupLoad(inp.files[0]); });
    wrap.addEventListener('click', ev => {
      const a = ev.target.dataset.a;
      if (ev.target.matches('.bs-rep-head i')) closeSale();
      else if (a === 'back') openSales('hist');
      else if (a === 'load') inp.click();
      else if (a === 'save') { backupSave(); tarHint('✓ Копия скачана', true); }
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  // ---------- Импорт продаж других менеджеров из текста для Telegram ----------
  // Отчёт о продаже начинается со ссылки на чат (можно без https) – по ней режем вставку на продажи.
  // Ссылка на другую систему тоже начинает отчёт, но такой отчёт пропускаем. Дальше порядок строк любой:
  //  сумма – число с «р/руб/₽/к/тыс» («45 000 рублей», «45000р», «45к»), иначе число в конце строки
  //    («матем мес – 4990», «= 6490», «7 990 (промо)») или после «сумма/итог/оплата»; может стоять в строке тарифа;
  //  МОП – строка «МОП/Менеджер …», иначе строка только из имён менеджеров («Даша и Миша», «Даша, Бес»);
  //  тариф – текст перед суммой в той же строке, иначе первая строка, которая не сумма, не МОП и не данные клиента.
  const MOP_FORMS = { 'Миша': 'миша|михаил', 'Ксюша': 'ксюша|ксения', 'Даша': 'даша|дарья', 'Бес': 'бес' };
  const mopRe = n => new RegExp('(^|[^а-яё])(' + (MOP_FORMS[n] || norm(n)) + ')(?![а-яё])', 'i');
  const mopsIn = line => MANAGERS.map(m => m[1]).filter(n => mopRe(n).test(norm(line)));
  // строка только из имён менеджеров и связок – пустая строка после вычёркивания
  const onlyMops = line => mopsIn(line).length ? MANAGERS.map(m => m[1]).reduce((t, n) => t.replace(new RegExp(MOP_FORMS[n] || norm(n), 'gi'), ''), norm(line)).replace(/моп\S*|менеджер\S*|\sи\s|[\s,.;:+/&-]/gi, '') : 'x';
  const NUM = '(\\d{1,3}(?:[  ]\\d{3})+|\\d+)(?:[.,](\\d+))?';
  const CUR = '\\s*(к(?![а-яa-z])|тыс\\S*)?\\s*(р(?![а-яa-z])|р\\.|руб\\S*|₽)?';
  const numVal = m => { const d = m[1].replace(/\D/g, ''); return d.length > 7 ? 0 : parseFloat(d + (m[2] ? '.' + m[2] : '')) * (m[3] ? 1000 : 1); };
  // хвост строки с суммой: «– 4 990 руб. (промо)», «= 6490»
  const SUM_TAIL = new RegExp('[\\s–—=:-]*' + NUM + CUR + '\\s*(\\([^)]*\\))?\\s*$', 'i');
  // strong – сумма с валютой/«к»/словом «сумма», иначе только число в конце строки
  function sumIn(line, weak) {
    const l = norm(line);
    if (/@|https?:|www\.|^\+/.test(l) || /^скидк/.test(l)) return 0;
    for (const m of l.matchAll(new RegExp(NUM + CUR, 'gi'))) {
      const v = numVal(m);
      if ((m[3] || m[4]) && v >= 100) return Math.round(v);
    }
    if (/сумм|итог|оплат|цена|стоим/.test(l)) { const m = new RegExp(NUM).exec(l.replace(/^\D*/, '')); if (m && numVal(m) >= 100) return Math.round(numVal(m)); }
    if (weak) { const m = SUM_TAIL.exec(l); if (m && numVal(m) >= 100) return Math.round(numVal(m)); }
    return 0;
  }
  const isSrc = l => /^(источник|ист)(?![а-яё])/i.test(norm(l));
  const isInfo = l => /^(откуда|почта|ник|имя|фио|телефон)(?![а-яё])|\S+@\S+\.\S+|^@\w|^\+?\d[\d\s()-]{9,}$/i.test(norm(l));
  // слова, с которых не начинается имя: пометки менеджера, тарифы, рассказ «откуда узнал»
  const NOT_NAME = /^((жду|нет|через|вас|мне|он|она|о|об|из|от|в|на|и|ну|да|тг|вк|ник|сам|год|рус|лид|мама|папа|сын|брат|дочь|дочка|тик|тикток|ранее|давно|курс|курсы|школа|школе|школу|данные|данных)$|(узна|почт|источ|откуд|остальн|наверн|дубл|смотр|подпис|месяц|матем|комбо|бронь|апсейл|допла|куратор|тариф|высш|привет|спасиб|клиент|ученик|ребен|сестр|знаком|сентяб|октяб|ноябр|декаб|январ|феврал|март|апрел|ютуб|инст|самост|самопод|самопров|русск|язык|оплат|разделен|продл|фамил|при$))/;
  // ФИО из строки: убираем почту, ник, телефон, нумерацию «1.», подписи «Почта:», «ФИО ребенка», пометки в скобках
  function fioIn(line) {
    for (let seg of line.split(/[,;/|]|\s\.\s/)) {
      if (/^\s*(почт|e-?mail|ник|тг|телеф)/i.test(seg)) continue;
      seg = seg.replace(/\S*@.*$/, '').replace(/\+?\d[\d\s()-]{9,}/g, '').replace(/\([^)]*\)?/g, '')
        .replace(/^\s*\d+\s*[.)]\s*/, '').replace(/^\s*(имя( и)? фамилия|имя|фамилия|фио( ребенка| ученика)?|почта|ник|тг)(?![а-яё])\s*[:-]?\s*/i, '')
        .replace(/\s+и$/i, '').replace(/[\s.:!-]+$/, '').trim();
      const w = seg.split(/\s+/);
      if (!seg || w.length > 3 || w.some(x => !/^[а-яё]{2,}(-[а-яё]{2,})?$/i.test(x) || NOT_NAME.test(norm(x)))) continue;
      if (w.length === 1 && !/^[А-ЯЁ]/.test(seg) || w.some(x => x.length > 2 && x === x.toUpperCase())) continue;
      return w.map(x => x[0].toUpperCase() + x.slice(1)).join(' ');
    }
    return '';
  }
  // тот же человек: тот же чат или та же почта
  const mailOf = x => String(x.email || '').trim().toLowerCase();
  const samePerson = (s, x) => s.dlg === x.dlg || !!mailOf(s) && mailOf(s) === mailOf(x);
  function parseSales(text) {
    const parts = [];
    let cur = null;
    text.split('\n').forEach(raw => {
      const t = raw.trim();
      // шапка пересланного сообщения из ТГ: «Имя, [6 окт. 2026 г., 21:48:07]:»
      if (!t) return;
      if (/^[^\[\]]{1,60}, \[\d{1,2} [^\]]+\]:?$/.test(t)) { cur = null; return; }
      const d = /bluesales\.ru\/\S*?dialogId=(\d+)/i.exec(t);
      // вторая ссылка сразу за первой («… (папа дочки)») – тот же отчёт
      if (d && cur && !cur.lines.length) return;
      if (d) {
        cur = { dlg: d[1], lines: [] };
        parts.push(cur);
        const rest = t.replace(/\[[^\]]*\]\([^)]*\)|\S*dialogId=\d+\S*/gi, '').trim();
        if (rest) cur.lines.push(rest);
      } else if (/^(https?:\/\/|www\.)/i.test(t)) cur = null;
      else if (cur) cur.lines.push(t);
    });
    const res = parts.map(({ dlg, lines }) => {
      const x = { dlg, name: '', price: '', disc: '', mops: [], email: '', fio: '', nick: '', src: '', quote: '' };
      const iSrc = lines.findIndex(isSrc);
      // числа без валюты ищем только до «Источника» – дальше идут цитаты клиента
      let iSum = lines.findIndex(l => sumIn(l));
      if (iSum < 0) iSum = lines.findIndex((l, i) => (iSrc < 0 || i < iSrc) && !isInfo(l) && sumIn(l, true));
      let iMop = lines.findIndex(l => /^(моп|менеджер)/i.test(norm(l)) && mopsIn(l).length);
      if (iMop < 0) iMop = lines.findIndex((l, i) => i !== iSum && onlyMops(l) === '');
      if (iSum >= 0) {
        const d = /скидк\S*\s*[:-]?\s*(\d[\d\s ]*)(?![\d\s ]*%)/i.exec(lines[iSum]);
        x.disc = d && +d[1].replace(/\D/g, '') >= 100 ? String(+d[1].replace(/\D/g, '')) : '';
        x.price = String((sumIn(lines[iSum]) || sumIn(lines[iSum], true)) + (+x.disc || 0));
        // тариф в одной строке с суммой: «Апсейл русский с куратором 5 192 рубля»
        const rest = lines[iSum].replace(SUM_TAIL, '').replace(/[\s|–—=:-]+$/, '').trim();
        if (/[а-яёa-z]{3}/i.test(rest) && !/^(сумм|итог|оплат|цена|стоим)/i.test(norm(rest))) x.name = rest;
      }
      if (iMop >= 0) x.mops = mopsIn(lines[iMop]);
      // строки внутри кавычек – рассказ клиента, имён там не ищем
      let inQ = false;
      const quoted = lines.map(l => { const was = inQ || /^["«“]/.test(l); inQ = was && !/["»”]$/.test(l.length > 1 || !inQ ? l : ''); return was; });
      const skip = i => i === iSum || i === iMop || i === iSrc || quoted[i];
      const iFio = x.name && fioIn(x.name) ? iSum : lines.findIndex((l, i) => !skip(i) && fioIn(l));
      if (iFio >= 0) x.fio = iFio === iSum ? fioIn(x.name) : fioIn(lines[iFio]);
      if (iSrc >= 0) x.src = lines[iSrc].replace(/^(источник|ист)\S*\s*[:-]?\s*/i, '');
      if (!x.name) {
        const iName = lines.findIndex((l, i) => i !== iSum && i !== iMop && i !== iFio && (iSrc < 0 || i < iSrc) && !isInfo(l));
        if (iName >= 0) x.name = lines[iName];
      }
      lines.forEach((l, i) => {
        const e = /[^\s,;/()]+@\s?[^\s,;/()]+?\s?\.\s?[a-z]{2,}(?![a-z])/i.exec(l), n = /(^|[\s/,(-])@(\w{3,})/.exec(l);
        if (e && !x.email) x.email = e[0].replace(/\s/g, '');
        if (n && !x.nick && !quoted[i]) x.nick = '@' + n[2];
      });
      // ник без «@»: одно латинское слово на строке («darisshkis», «Ник в тг – Scorpex», «cat_with_sunglasses ник в тг»)
      if (!x.nick) lines.some((l, i) => {
        const t = l.replace(/(^|\s)(ник|тг|телеграм\S*|юз)\S*(\s+в\s+\S+)?(\s*[:-])?/gi, ' ').trim();
        if (skip(i) || !/^[a-z][\w.]{3,31}$/i.test(t) || /^(youtube|tiktok|telegram|vk|insta\w*|shorts)$/i.test(t)) return false;
        return (x.nick = '@' + t);
      });
      // цитата – в кавычках после «Источника»
      if (iSrc >= 0) { const q = lines.slice(iSrc + 1).join('\n'), m = /^["«“]([\s\S]*?)["»”]/.exec(q); x.quote = m ? m[1] : (lines[iSrc + 1] || ''); }
      if (!x.name) x.name = 'Продажа (тариф не указан)';
      x.bad = !x.price ? 'не нашёл сумму' : !x.mops.length ? 'не нашёл менеджера' : '';
      return x;
    });
    // одну продажу часто присылают дважды (исправленную или «докреплю») – берём нижнюю
    res.forEach((x, i) => { if (!x.bad && res.slice(i + 1).some(y => y.price === x.price && samePerson(y, x))) x.bad = 'повтор ниже'; });
    return res;
  }
  // day – 'ГГГГ-ММ-ДД': продажи за прошлый день уходят в «Историю», за сегодня – в текущую смену
  // та же продажа уже есть в списке: тот же чат и тариф или цена – тогда дописываем пустые поля (почту, имя…) из отчёта
  // другая сумма в том же чате – это вторая оплата, её добавляем отдельно
  const impSame = (s, x) => s.dlg === x.dlg && String(s.price) === x.price;
  const IMP_FILL = { email: 'почту', fio: 'имя', nick: 'ник', src: 'источник', quote: 'откуда узнал' };
  // today – продажа текущей смены (там хранится всё), иначе из истории (только почта и имя); put – записать
  function impFill(s, x, today, put) {
    const ks = (today ? Object.keys(IMP_FILL) : ['email', 'fio']).filter(k => !String(s[k] || '').trim() && String(x[k] || '').trim());
    if (put) ks.forEach(k => { s[k] = x[k]; if (k === 'fio' && !s.who) s.who = x.fio; });
    return ks;
  }
  function openImport(day) {
    closeSale();
    if (!meSet()) return askMe();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-imp"><div class="bs-rep-head"><b>Импорт продаж из Telegram</b><i title="Закрыть">×</i></div>' +
      '<label class="bs-imp-day"><span>Продажи за</span><input type="date" value="' + (day || isoOf(new Date())) + '" max="' + isoOf(new Date()) + '"><u></u></label>' +
      '<div class="bs-tar-help">Скопируй из ТГ отчёты о продажах за день (можно все разом) и вставь сюда. Каждый отчёт – со ссылки на чат, дальше в любом порядке тариф, сумма («45 000», «45000р», «45к») и менеджеры. Добавятся все продажи, но в «Продано» и сумму пойдут только те, где есть ' + esc(meName()) + ', – с твоей долей.</div>' +
      '<textarea class="bs-imp-in" spellcheck="false" placeholder="https://bluesales.ru/app/messenger/?dialogId=…"></textarea>' +
      '<div class="bs-imp-list"></div>' +
      '<div class="bs-rep-btns"><span class="bs-tar-st"></span><button data-a="back">Назад</button><button data-a="add" class="bs-main" disabled>Добавить</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsSale'), ta = box.querySelector('.bs-imp-in'), out = box.querySelector('.bs-imp-list'), btn = box.querySelector('[data-a="add"]');
    let found = [];
    const force = new Set();   // повторы, которые всё-таки добавить (клик по строке)
    const dayInp = box.querySelector('.bs-imp-day input');
    const target = () => { const d = fromIso(dayInp.value); return d && ddmm(d) !== ddmm(new Date()) ? ddmm(d) : ''; };
    const paint = () => {
      const td = target(), me = meName();
      box.querySelector('.bs-imp-day u').textContent = td ? 'прошлый день – продажи уйдут в «Историю»' : 'сегодня – в текущую смену';
      const have = td ? histGet().filter(e => e.d === td).flatMap(e => e.sales) : salesGet();
      // остальные продажи (другие дни истории, текущая смена) – там ищем повторы из ТГ и оплаты того же человека
      const now = ddmm(new Date());
      const prior = histGet().filter(e => e.d !== td).flatMap(e => e.sales.map(s => ({ s, d: e.d })))
        .concat(td ? salesGet().map(s => ({ s, d: now })) : [], have.map(s => ({ s, d: td || now })));
      const paid = o => o.d.slice(0, 5) + ' – ' + rub(saleTotal(o.s)) + ' ₽';
      found = parseSales(ta.value).map((x, i, all) => {
        const k = i + ':' + x.dlg + ':' + x.price, forced = force.has(k);
        // клик по строке («всё-таки добавить») – отдельная продажа, ничего не дописываем
        const twin = x.bad || forced ? null : have.find(s => impSame(s, x));
        Object.assign(x, { k, mine: !x.bad && x.mops.includes(me), dup: !!twin, twin: !!twin, fill: twin ? impFill(twin, x, !td) : [], seen: '', warn: '' });
        if (x.bad || twin) return x;
        // та же оплата уже внесена – скорее всего, в ТГ продублировали (ежемесячных оплат у нас нет)
        const same = prior.find(o => samePerson(o.s, x) && String(o.s.price) === x.price);
        if (same) { x.seen = 'уже есть ' + paid(same); x.dup = !forced; return x; }
        // тот же человек с другой суммой – добавим, но пусть перепроверят
        const other = prior.filter(o => samePerson(o.s, x)).map(paid).concat(all.filter(y => y !== x && !y.bad && samePerson(y, x)).map(y => 'в этом тексте – ' + rub(saleTotal(y)) + ' ₽'));
        if (other.length) x.warn = 'у человека уже есть оплата: ' + other.join(', ') + ' – перепроверь';
        return x;
      });
      const ok = found.filter(x => !x.bad && !x.dup), my = ok.filter(x => x.mine), fills = found.filter(x => x.fill.length);
      out.innerHTML = found.length ? found.map(x =>
        '<div class="bs-imp-row' + (!x.bad && !x.dup ? '' : ' bs-off') + '"' + (x.seen || x.twin ? ' data-k="' + esc(x.k) + '" title="' + (x.dup ? 'Если это другая оплата – нажми, добавлю отдельно' : 'Нажми, чтобы не добавлять') + '"' : '') + '><b>' + esc(x.fio || 'чат ' + x.dlg) + x.mops.map(m => '<s class="bs-mop" data-m="' + esc(m) + '">' + esc(m) + '</s>').join('') + '</b>' +
        '<em>' + (x.price ? rub(saleTotal(x)) + ' ₽' : '?') + ' · ' + (x.mine ? String(shareFor(x.mops.length)).replace('.', ',') : '0') + '</em><span>' + esc(x.name) + '</span>' +
        '<u' + (x.warn || x.seen ? ' class="bs-warn"' : '') + '>' + (x.bad ? x.bad + ' – пропущу' : x.seen ? x.seen + (x.dup ? ' – повтор, пропущу' : ' – добавлю ещё раз') : x.fill.length ? 'уже в списке – допишу ' + x.fill.map(k => IMP_FILL[k]).join(', ') + ' (другая оплата – нажми)' : x.dup ? 'уже в списке (другая оплата – нажми)' : [x.warn, !x.mine && 'не твоя – без учёта в сумме'].filter(Boolean).join(' · ')) + '</u></div>').join('')
        : (ta.value.trim() ? '<div class="bs-tar-help">Продаж не нашёл – в тексте должна быть ссылка на чат BlueSales.</div>' : '');
      btn.disabled = !ok.length && !fills.length;
      btn.textContent = (ok.length ? 'Добавить ' + ok.length + ' · твоих ' + my.length + ' · +' + rub(my.reduce((a, x) => a + saleTotal(x) * shareX(shareFor(x.mops.length)), 0)) + ' ₽' : 'Добавить') +
        (fills.length ? ' · дописать ' + fills.length : '');
    };
    ta.addEventListener('input', paint);
    dayInp.addEventListener('change', paint);
    paint();
    box.addEventListener('click', ev => {
      const a = ev.target.dataset.a, row = ev.target.closest('.bs-imp-row[data-k]');
      if (row) { const k = row.dataset.k; force.has(k) ? force.delete(k) : force.add(k); return paint(); }
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      if (a === 'back') return openSales(target() ? 'hist' : 'shift');
      if (a !== 'add') return;
      const td = target(), fills = found.filter(x => x.fill.length);
      const done = n => '✓ ' + [n && 'добавлено продаж: ' + n, fills.length && 'дописано: ' + fills.length].filter(Boolean).join(', ');
      if (td) {
        if (fills.length) {
          const h = histGet();
          h.filter(e => e.d === td).forEach(e => e.sales.forEach(sl => { const f = fills.find(x => impSame(sl, x)); if (f) impFill(sl, f, false, true); }));
          if (!histSave(h)) return;
        }
        const xs = found.filter(x => !x.bad && !x.dup).map(f => ({ dlg: f.dlg, name: f.name, price: f.price, disc: f.disc, mops: f.mops, share: shareFor(f.mops.length), fio: f.fio, who: f.fio, email: f.email, cnt: f.mine }));
        if (xs.length && !histAddDay(td, xs)) return;
        openSales('hist');
        return tarHint(done(xs.length) + ' (история за ' + td + ')', true);
      }
      const all = salesGet();
      all.forEach(sl => { const f = fills.find(x => impSame(sl, x)); if (f) impFill(sl, f, true, true); });
      let n = 0;
      found.filter(x => !x.bad && !x.dup).forEach(f => {
        const x = { id: Date.now().toString(36) + (n++), dlg: f.dlg, t: Date.now(), tar: 'own', name: f.name, price: f.price, disc: f.disc,
          mops: f.mops, share: shareFor(f.mops.length), email: f.email, fio: f.fio, nick: f.nick, src: f.src, quote: f.quote, who: f.fio, imp: 1, cnt: f.mine };
        // чужая продажа хранится в списке (cnt:false), но в «Продано» и сумму не идёт
        if (saleShare(x)) soldAdd(saleShare(x));
        sumAdd(salePart(x));
        all.push(x);
      });
      salesSet(all);
      openSales();
      tarHint(done(n), true);
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
    ta.focus();
  }

  // «кто я» выбирается кнопкой «Я: …» в «Продажах за смену»
  function askMe() {
    closeSale();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const cur = localStorage.getItem(ME_KEY);
    wrap.innerHTML = '<div id="bsSale" class="bs-me"><div class="bs-rep-head"><b>Кто ты?</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-tar-help">Выбери себя – на тебя будут считаться продажи и отчёт смены.</div>' +
      '<div class="bs-chips">' + MANAGERS.map(m => '<em data-v="' + m[0] + '"' + (m[0] === cur ? ' class="bs-on"' : '') + '>' + m[1] + '</em>').join('') + '</div></div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', ev => {
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      const em = ev.target.closest('.bs-chips em');
      if (!em) return;
      try { localStorage.setItem(ME_KEY, em.dataset.v); } catch (e) {}
      openSales();
      tarHint('✓ Привет, ' + em.textContent + '! Продажи и отчёт считаются на тебя', true);
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  function salesInit() {
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeSale(); });
    const st = document.createElement('style');
    st.textContent =
      '#bsSaleWrap{position:fixed;inset:0;z-index:3100;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}' +
      '#bsSale{width:760px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;box-sizing:border-box;padding:14px 16px;border-radius:14px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
      '#bsSale.bs-sales{width:880px}' +
      '.bs-sale-cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}@media (max-width:700px){.bs-sale-cols{grid-template-columns:1fr}}' +
      '.bs-sale-form{display:flex;flex-direction:column;gap:7px}' +
      '#bsSale label{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--bs-muted,#888)}' +
      '#bsSale input,#bsSale select,.bs-sale-form textarea{padding:5px 8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:transparent;color:var(--bs-text,#222);font:13px inherit;outline:none;resize:vertical;color-scheme:light dark}' +
      '#bsSale select option{background:var(--bs-panel,#fff);color:var(--bs-text,#222)}' +
      '#bsSale input:focus,#bsSale select:focus,.bs-sale-form textarea:focus{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-chips{display:flex;flex-wrap:wrap;gap:5px}' +
      '.bs-chips em{font-style:normal;padding:4px 11px;border-radius:8px;border:1px solid var(--bs-border,#D9E0E7);color:var(--bs-text,#222);font-size:12.5px;cursor:pointer;user-select:none}' +
      '.bs-chips em.bs-on{background:var(--bs-accent,#3b82f6);border-color:var(--bs-accent,#3b82f6);color:#fff}' +
      '.bs-sale-prev{display:flex;flex-direction:column;gap:3px;font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-sale-prev textarea{flex:1;min-height:300px;padding:9px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:var(--bs-hover,#f5f7fa);color:var(--bs-text,#222);font:12.5px/1.45 inherit;resize:none}' +
      '.bs-sale-note{font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-sale-del{color:#e04848!important;border-color:transparent!important}' +
      '.bs-sale-dup{display:flex;align-items:center;gap:10px;margin:0 0 10px;padding:8px 10px;border-radius:9px;background:rgba(245,158,11,.14);color:var(--bs-text,#222);font-size:12.5px;line-height:1.35}' +
      '.bs-sale-dup button{flex:none;padding:5px 12px;border:1px solid #f59e0b;border-radius:7px;background:none;color:inherit;font-size:12.5px;cursor:pointer}.bs-sale-dup button:hover{background:#f59e0b;color:#fff}' +
      '.bs-sale-dups{flex-direction:column;align-items:stretch;gap:6px}.bs-sale-dups p{display:flex;align-items:center;gap:10px;margin:0}.bs-sale-dups p span{flex:1}' +
      '#bsSale.bs-hist{width:560px}' +
      '.bs-rep-head .bs-seg{margin-right:12px}' +
      '.bs-seg{display:inline-flex;gap:2px;padding:2px;border-radius:9px;background:var(--bs-hover,rgba(0,0,0,.06))}' +
      '.bs-seg em{font-style:normal;padding:4px 12px;border-radius:7px;cursor:pointer;white-space:nowrap;font-size:12.5px;color:var(--bs-muted,#888)}.bs-seg em:hover{color:var(--bs-text,#222)}' +
      '.bs-seg em.on{background:var(--bs-panel,#fff);color:var(--bs-text,#222);font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,.18)}' +
      '.bs-hist-per{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px}' +
      '.bs-range{display:inline-flex;align-items:center;gap:5px;color:var(--bs-muted,#888)}#bsSale .bs-range input{padding:3px 6px;font-size:12.5px}#bsSale .bs-range.on input{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-stats{display:flex;border:1px solid var(--bs-border,#D9E0E7);border-radius:10px;margin-bottom:10px}' +
      '.bs-stats div{flex:1 1 0;min-width:0;display:flex;flex-direction:column;gap:2px;padding:7px 12px}' +
      '.bs-stats div+div{border-left:1px solid var(--bs-border,#D9E0E7)}.bs-stats span{font-size:11px;color:var(--bs-muted,#888);white-space:nowrap}' +
      '.bs-stats b{font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-variant-numeric:tabular-nums}' +
      '.bs-head-d{margin-left:10px;font-size:13px;font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-hero{display:flex;align-items:center;gap:18px;padding:0 2px 14px;margin-bottom:10px;border-bottom:1px solid var(--bs-border,#D9E0E7)}' +
      '.bs-hero i{font-style:normal;color:var(--bs-text,#222);font-weight:600}' +
      '.bs-goal{position:relative;flex:none;width:80px;height:80px;padding:0;border:0;background:none;cursor:pointer;color:var(--bs-text,#222);display:flex;flex-direction:column;align-items:center;justify-content:center}' +
      '.bs-goal svg{position:absolute;inset:0}.bs-goal circle{fill:none;stroke:var(--bs-border,#D9E0E7);stroke-width:7}.bs-goal circle.bs-goal-on{stroke:var(--bs-accent,#3b82f6);stroke-linecap:round;transition:stroke-dasharray .4s}' +
      '.bs-goal b{font-size:18px;font-weight:700;line-height:1;font-variant-numeric:tabular-nums}.bs-goal small{font-size:11px;color:var(--bs-muted,#888);margin-top:2px}.bs-goal:hover circle:first-child{stroke:var(--bs-hover,rgba(0,0,0,.1))}' +
      '.bs-hero-m{display:flex;flex-direction:column;gap:3px;min-width:0}.bs-hero-m b{font-size:26px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.3px;line-height:1.15}' +
      '.bs-hero-m span{font-size:13px;color:var(--bs-muted,#888)}.bs-hero-g input{width:54px;margin:0 4px;padding:2px 6px;border:1px solid var(--bs-border,#D9E0E7);border-radius:6px;background:none;color:var(--bs-text,#222);font:inherit}' +
      '.bs-hero-g button{margin-left:4px;padding:2px 10px;border:1px solid var(--bs-accent,#3b82f6);border-radius:6px;background:var(--bs-accent,#3b82f6);color:#fff;font:inherit;cursor:pointer}' +
      '.bs-hero-r{margin-left:auto;display:flex;gap:22px;text-align:right}.bs-hero-r div{display:flex;flex-direction:column;gap:2px}.bs-hero-r span{font-size:11.5px;color:var(--bs-muted,#888)}' +
      '.bs-kpi{display:flex;gap:4px;justify-content:flex-end;margin-top:2px;white-space:nowrap}.bs-kpi em{font-style:normal;font-size:10.5px;line-height:16px;padding:0 6px;border-radius:8px;background:rgba(127,127,127,.13);color:var(--bs-muted,#888)}' +
      '.bs-kpi em.up{background:rgba(22,163,74,.13);color:#16a34a}.bs-kpi em.down{background:rgba(217,119,6,.14);color:#d97706}.bs-kpi em.no{background:none;box-shadow:inset 0 0 0 1px var(--bs-border,#D9E0E7)}.bs-pm{cursor:default}' +
      '.bs-ptip{display:none;position:fixed;z-index:3200;width:270px;padding:10px 12px;border-radius:12px;pointer-events:none;text-align:left;background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 32px rgba(0,0,0,.2)}.bs-pm:hover>.bs-ptip{display:block}' +
      '.bs-ptip p{display:flex;gap:10px;justify-content:space-between;align-items:baseline;margin:0;padding:3px 0;font-size:12.5px;line-height:1.35}.bs-ptip i{font-style:normal;color:var(--bs-muted,#888)}.bs-ptip em{font-style:normal;font-weight:600;white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.bs-ptip .bs-pt-k.up em{color:#16a34a}.bs-ptip .bs-pt-k.down em{color:#d97706}.bs-ptip .bs-pt-t{margin-top:4px;padding-top:7px;border-top:1px solid var(--bs-border,#D9E0E7)}.bs-ptip .bs-pt-t i{color:inherit;font-weight:600}.bs-ptip .bs-pt-t em{font-size:14px}' +
      '.bs-ptip .bs-pt-tab{margin-top:4px}.bs-ptip .bs-pt-n{display:block;padding:0 0 3px;font-size:11.5px;color:var(--bs-muted,#888)}.bs-ptip .bs-pt-n.ok{color:#16a34a}.bs-ptip .bs-pt-n.bad{color:#d97706}' +
      '.bs-hero-r b{font-size:16px;font-weight:600;font-variant-numeric:tabular-nums}.bs-hero-r b.bs-ok{color:#16a34a}' +
      '.bs-sw{position:relative;display:inline-block;width:26px;height:15px;border-radius:8px;background:#c9ced6;margin-right:8px;vertical-align:-3px;transition:background .15s}' +
      '.bs-sw::after{content:"";position:absolute;left:2px;top:2px;width:11px;height:11px;border-radius:50%;background:#fff;transition:left .15s}' +
      '.bs-mine[data-st=on] .bs-sw{background:#22a55a}.bs-mine[data-st=on] .bs-sw::after{left:13px}.bs-mine[data-st=on]{color:var(--bs-text,#222)}' +
      '.bs-mine[data-st=wait] .bs-sw{background:none;box-shadow:inset 0 0 0 1.5px #9aa3af}.bs-mine[data-st=wait] .bs-sw::after{background:#9aa3af;left:2px;top:2px}' +
      '.bs-foot button.bs-icon{padding:6px 9px}.bs-foot button.bs-icon svg{margin:0;vertical-align:-3px}' +
      '.bs-empty{padding:26px 10px;text-align:center;font-size:12.5px;line-height:1.6;color:var(--bs-muted,#888)}' +
      '.bs-foot{display:flex;align-items:center;gap:8px;margin-top:12px}.bs-foot>span{flex:1}' +
      '.bs-foot button{padding:6px 12px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:none;color:var(--bs-text,#222);font-size:12.5px;cursor:pointer;white-space:nowrap}.bs-foot button:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}' +
      '.bs-foot button.bs-main{background:var(--bs-accent,#3b82f6);border-color:var(--bs-accent,#3b82f6);color:#fff}.bs-foot button.bs-main:hover{color:#fff;filter:brightness(1.1)}' +
      '.bs-foot button.bs-ghost{border-color:transparent;color:var(--bs-muted,#888);padding:6px 8px}.bs-foot button.bs-ghost:hover{border-color:transparent;color:var(--bs-text,#222);background:var(--bs-hover,rgba(0,0,0,.06))}' +
      '.bs-hist-list{display:flex;flex-direction:column;gap:6px}' +
      '.bs-hist-row{display:grid;grid-template-columns:1fr auto 22px;align-items:center;gap:4px 10px;padding:8px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:9px;cursor:pointer}.bs-hist-row:hover{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-hist-row>b span{margin-left:6px;font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-hist-row>b .bs-hist-mine{margin-left:6px;padding:0 6px;border-radius:6px;font-size:11px;font-weight:400;font-style:normal;color:var(--bs-muted,#888);background:var(--bs-hover,rgba(0,0,0,.06))}.bs-hist-row>b .bs-hist-mine.on{color:#16a34a;background:rgba(22,163,74,.1)}' +
      '.bs-foot button.bs-mine.on{color:#16a34a}.bs-stats small{font-size:12px;font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-hist-row em{display:grid;grid-template-columns:72px 104px 64px;font-style:normal;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.bs-hist-row em span:first-child,.bs-hist-row em span:last-child{color:var(--bs-muted,#888)}' +
      '.bs-prem .bs-hist-row em{grid-template-columns:72px 104px 104px 64px}.bs-hist-row em span.bs-hist-prem{color:#16a34a}' +
      '.bs-stats b i{font-style:normal}.bs-hist-row em span.bs-hist-prem.bs-warn,.bs-sync-p b.bs-warn,.bs-hero-r b.bs-warn{color:#d97706}' +
      '.bs-prem-v,.bs-prem-q{font-weight:500;font-size:11.5px;color:#16a34a;margin-left:6px;white-space:nowrap}.bs-prem-q,.bs-sale-prem small.bs-prem-q{color:#d97706}' +
      '.bs-sales-row .bs-prem-v,.bs-sales-row .bs-prem-q{grid-column:2;text-align:right;margin:0}' +
      '.bs-hero-m .bs-hero-p i{font-style:normal;color:#16a34a}.bs-hero-m .bs-hero-p b{font-size:12px;margin-left:2px}' +
      '.bs-hist-zero>b,.bs-hist-zero>em{opacity:.45}.bs-hist-zero.open>b,.bs-hist-zero:hover>b{opacity:1}' +
      '.bs-hist-row>b .bs-hist-tabm{margin-left:6px;font-size:11px;font-weight:400;font-style:normal;color:#16a34a}.bs-hist-row>b .bs-hist-tabm.bs-warn{color:#d97706}' +
      '.bs-hist-row>b .bs-hist-mine.bs-warn{color:#d97706;background:rgba(245,158,11,.12)}' +
      '.bs-hist-sales .bs-hist-onlyh{margin-top:4px;color:#d97706}.bs-hist-sales .bs-hist-only{cursor:default}.bs-hist-only small{color:var(--bs-muted,#888)}.bs-hist-sgap{flex:none;width:18px}' +
      '.bs-hist-sales{display:none;grid-column:1/-1;flex-direction:column;gap:3px;margin-top:4px;padding-top:6px;border-top:1px solid var(--bs-border,#D9E0E7);font-size:12px;cursor:default}.bs-hist-row.open .bs-hist-sales{display:flex}' +
      '.bs-hist-sales div{display:flex;align-items:center;gap:10px}.bs-hist-sales div span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bs-hist-sales div span+span{flex:none;font-variant-numeric:tabular-nums}' +
      '.bs-hist-other{color:var(--bs-muted,#888)}' +
      '#bsSale svg{pointer-events:none}.bs-foot button svg{vertical-align:-2px;margin-right:6px}' +
      '.bs-dot{display:inline-block;flex:none;width:7px;height:7px;border-radius:50%;background:#9aa3af}.bs-dot[data-st=ok]{background:#22a55a}.bs-dot[data-st=warn]{background:#f59e0b}.bs-dot[data-st=err]{background:#e04848}' +
      '.bs-dot[data-st=wait]{background:none;box-shadow:inset 0 0 0 1.5px #9aa3af}.bs-foot .bs-dot{margin:0 0 1px 7px}.bs-foot .bs-mine .bs-dot{margin:0 7px 1px 0}' +
      '.bs-sync{display:flex;align-items:center;gap:12px;margin:0 0 10px;padding:7px 6px 7px 12px;border:1px solid var(--bs-border,#D9E0E7);border-radius:10px}' +
      '.bs-sync-l{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}' +
      '.bs-sync-r{display:flex;align-items:center;gap:8px;min-height:24px;font-size:12.5px}.bs-sync-r b{flex:none;width:96px;font-weight:500}' +
      '.bs-sync-r span{flex:1;min-width:0;color:var(--bs-muted,#888);line-height:1.35}' +
      '.bs-sync-r button{flex:none;padding:2px 10px;white-space:nowrap;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:none;color:var(--bs-text,#222);font-size:12px;cursor:pointer}.bs-sync-r button:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}' +
      '.bs-sync-p{flex:none;display:flex;gap:16px;padding:0 4px 0 14px;border-left:1px solid var(--bs-border,#D9E0E7)}.bs-sync-p div{display:flex;flex-direction:column;align-items:flex-end;gap:1px}' +
      '.bs-sync-p span{font-size:11px;color:var(--bs-muted,#888);white-space:nowrap}.bs-sync-p b{font-size:15px;color:#16a34a;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      '.bs-sync-btn{flex:none;width:28px;height:28px;display:flex;align-items:center;justify-content:center;border:none;border-radius:8px;background:none;color:var(--bs-muted,#888);cursor:pointer}.bs-sync-btn:hover{background:var(--bs-hover,rgba(0,0,0,.06));color:var(--bs-text,#222)}' +
      '.bs-sync.busy .bs-sync-btn svg{animation:bsSpin 1s linear infinite}.bs-sync.busy .bs-sync-btn{color:var(--bs-accent,#3b82f6)}' +
      '.bs-hist-row>b .bs-hist-tabm::before{content:"";display:inline-block;width:6px;height:6px;margin-right:4px;border-radius:50%;background:currentColor;vertical-align:1px}' +
      '.bs-hist-sales p{margin:0}.bs-hist-act{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-top:8px!important;padding-top:8px;border-top:1px solid var(--bs-border,#D9E0E7)}' +
      '.bs-hist-act .bs-seg{flex:none}.bs-hist-act .bs-seg em{display:block;padding:2px 10px;font-size:12px;text-align:center}.bs-hist-st{flex:1;min-width:0;display:flex;flex-wrap:wrap;gap:6px}' +
      '.bs-hist-act button,.bs-hist-mv button{padding:3px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:none;color:var(--bs-text,#222);font-size:12px;cursor:pointer;white-space:nowrap}' +
      '.bs-hist-act button:hover,.bs-hist-mv button:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}.bs-hist-mv button.bs-main{background:var(--bs-accent,#3b82f6);border-color:var(--bs-accent,#3b82f6);color:#fff}' +
      '.bs-hist-act .bs-chip{display:inline-flex;align-items:center;gap:5px;max-width:100%;padding:2px 9px;border:none;border-radius:999px;background:var(--bs-hover,rgba(0,0,0,.06));color:var(--bs-muted,#888);font-size:11.5px;font-style:normal;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.bs-hist-act button.bs-chip:hover{color:var(--bs-text,#222)}.bs-chip::before{content:"";flex:none;width:6px;height:6px;border-radius:50%;background:#9aa3af}' +
      '.bs-chip[data-st=ok]::before{background:#22a55a}.bs-chip[data-st=warn]::before{background:#f59e0b}.bs-chip[data-st=err]::before{background:#e04848}.bs-chip[data-st=warn]{color:#b45309}' +
      '.bs-hist-mv{display:none;align-items:center;gap:6px;margin-top:6px!important;font-size:12px;color:var(--bs-muted,#888)}.bs-hist-act.mv+.bs-hist-mv{display:flex}.bs-hist-mv span{flex:1}#bsSale .bs-hist-mv input{padding:3px 6px;font-size:12px}' +
      '.bs-hist-del,.bs-hist-sdel{font-style:normal;text-align:center;color:var(--bs-muted,#888);border-radius:6px;cursor:pointer;opacity:0}.bs-hist-sdel{width:18px}' +
      '.bs-hist-sales .bs-hist-sh{flex:none;box-sizing:border-box;width:64px;font-size:11px;font-weight:400;text-align:center;white-space:nowrap}b.bs-hist-sh{color:#16a34a}button.bs-hist-sh{padding:1px 7px;border:1px dashed var(--bs-border,#D9E0E7);border-radius:6px;background:none;color:var(--bs-muted,#888);cursor:pointer}button.bs-hist-sh:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}button.bs-hist-sh.bs-warn{border-color:#f59e0b;color:#d97706}' +
      '.bs-hist-row:hover>.bs-hist-del,.bs-hist-sales div:hover .bs-hist-sdel{opacity:1}.bs-hist-del:hover,.bs-hist-sdel:hover{color:#e04848;background:rgba(224,72,72,.12)}' +
      '#bsSale.bs-hedit{width:440px}.bs-hedit-2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bs-hedit-chat{align-self:flex-start;font-size:12px;color:var(--bs-accent,#3b82f6);text-decoration:none}' +
      '.bs-hist-s{cursor:pointer;margin:0 -6px;padding:2px 6px;border-radius:6px}.bs-hist-s:hover{background:var(--bs-hover,rgba(0,0,0,.06))}' +
      '.bs-hist-sales .bs-hist-rep{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:6px;margin-bottom:6px}' +
      '.bs-hist-sales .bs-hist-rep span{flex:none!important;display:flex;flex-direction:column;gap:1px;padding:5px 8px;border-radius:8px;background:var(--bs-hover,#f5f7fa);color:var(--bs-muted,#888);font-size:11px;white-space:nowrap;overflow:hidden}' +
      '.bs-hist-rep b{font-size:13.5px;color:var(--bs-text,#222);font-variant-numeric:tabular-nums}.bs-hist-rep small{font-weight:400;color:var(--bs-muted,#888)}' +
      '#bsSale label.bs-imp-day{flex-direction:row;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px;color:var(--bs-text,#222)}.bs-imp-day u{text-decoration:none;color:var(--bs-muted,#888)}' +
      '.bs-backup{width:440px}.bs-backup .bs-tar-help{margin-bottom:6px}' +
      '.bs-sheet h4{margin:0;font-size:13.5px;font-weight:600}.bs-sheet h4 small{margin-left:6px;font-size:11.5px;font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-sheet-sub{margin:2px 0 8px;font-size:12.5px;line-height:1.45;color:var(--bs-muted,#888)}' +
      '.bs-sheet details{margin:0 0 10px;font-size:12px}.bs-sheet summary{width:max-content;cursor:pointer;color:var(--bs-accent,#3b82f6);user-select:none}.bs-sheet details .bs-tar-help{margin:6px 0 0}' +
      '.bs-sheet section label{margin-bottom:8px}.bs-sheet-2{display:grid;grid-template-columns:1fr 150px;gap:10px}' +
      '.bs-rep-head .bs-back{display:flex;margin:0 6px 0 -6px;padding:2px;border-radius:6px}.bs-rep-head .bs-back:hover{background:var(--bs-hover,rgba(0,0,0,.06));color:var(--bs-text,#222)}' +
      '.bs-sheet ol button{padding:1px 8px;border:1px solid var(--bs-accent,#3b82f6);border-radius:6px;background:none;color:var(--bs-accent,#3b82f6);font-size:11.5px;cursor:pointer}#bsSale.bs-sheet{width:480px}.bs-sheet ol.bs-tar-help{padding-left:18px}.bs-sheet ol a{color:var(--bs-accent,#3b82f6)}.bs-sheet .bs-sale-note{margin-top:6px;word-break:break-word}.bs-sheet .bs-sale-note:empty{display:none}.bs-sheet .bs-rep-btns{align-items:center}.bs-sheet .bs-sp{flex:1}.bs-team-set{margin-top:16px;padding-top:14px;border-top:1px solid var(--bs-border,#D9E0E7)}#bsSale.bs-sheet{max-height:90vh;overflow:auto}' +
      '.bs-sale-pay small{font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-hrep-sheet{margin-bottom:8px;padding:7px 10px;border-radius:8px;font-size:12.5px;background:var(--bs-hover,#f5f7fa);color:var(--bs-text,#222)}.bs-hrep-sheet[data-st=ok]{color:#22a55a}.bs-hrep-sheet[data-st=err]{color:#e04848}' +
      '.bs-sales-list{display:flex;flex-direction:column;gap:6px}' +
      '.bs-sales-row{display:grid;grid-template-columns:1fr auto 24px;gap:2px 10px;padding:8px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:9px;cursor:pointer}' +
      '.bs-sales-row:hover{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-mop{display:inline-block;margin-left:6px;padding:0 7px;border-radius:6px;font-size:10.5px;line-height:16px;font-weight:600;text-decoration:none;vertical-align:2px;color:#fff;background:#8a94a6}' +
      '.bs-mop[data-m="Бес"]{background:#e04848}.bs-mop[data-m="Даша"]{background:#f2b705;color:#3a2a00}.bs-mop[data-m="Миша"]{background:#2f9e44}.bs-mop[data-m="Ксюша"]{background:#e64990}' +
      '.bs-sales-row span{grid-column:1;font-size:12px;color:var(--bs-muted,#888)}.bs-sales-row em{grid-row:1;grid-column:2;font-style:normal;font-weight:600}' +
      '.bs-sales-row u{grid-column:2;text-decoration:none;font-size:11px;color:#e08a1e;text-align:right}' +
      '.bs-sales-del{grid-column:3;grid-row:1/span 2;align-self:center;font-style:normal;height:26px;display:flex;align-items:center;justify-content:center;border-radius:7px;color:var(--bs-muted,#888);font-size:17px}' +
      '.bs-sales-del:hover{background:rgba(224,72,72,.12);color:#e04848}' +
      '.bs-sales-foot{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}' +
      '#bsSale.bs-me{width:360px}#bsSale.bs-me .bs-tar-help{margin:6px 0 12px}#bsSale.bs-me .bs-chips em{padding:6px 14px;font-size:13.5px}' +
      '.bs-sales-foot button{padding:6px 12px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:none;color:var(--bs-text,#222);font-size:12.5px;cursor:pointer}' +
      '.bs-sales-foot button:hover{border-color:#e04848;color:#e04848}' +
      '#bsSale.bs-imp{width:560px}.bs-imp-in{width:100%;box-sizing:border-box;min-height:140px;margin:8px 0;padding:8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:transparent;color:var(--bs-text,#222);font:12px/1.4 inherit;resize:vertical;outline:none}' +
      '.bs-imp-in:focus{border-color:var(--bs-accent,#3b82f6)}.bs-imp-list{display:flex;flex-direction:column;gap:5px;max-height:40vh;overflow:auto}' +
      '.bs-imp-row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:7px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:9px}.bs-imp-row.bs-off{opacity:.5}' +
      '.bs-imp-row span{font-size:12px;color:var(--bs-muted,#888)}.bs-imp-row em{font-style:normal;font-weight:600;text-align:right}.bs-imp-row u{text-decoration:none;font-size:11px;color:#e08a1e;text-align:right}.bs-imp-row u.bs-warn{grid-column:1/-1;color:#dc2626}.bs-imp-row[data-k]{cursor:pointer}.bs-imp-row[data-k].bs-off{opacity:.65}' +
      '#bsSale button:disabled{opacity:.5;cursor:default}' +
      '.bs-sales-foot .bs-imp-btn:hover{border-color:var(--bs-accent,#3b82f6)!important;color:var(--bs-accent,#3b82f6)!important}' +
      '.bs-sales-foot .bs-me-btn{margin-right:auto}.bs-sales-foot .bs-me-btn:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}';
    document.head.appendChild(st);
  }
  document.addEventListener('DOMContentLoaded', salesInit);

  // ---------- Кнопка BlueSales над аккаунтом – на главную CRM ----------
  function homeInit() {
    const info = document.getElementById('infoPlace');
    if (!info || document.getElementById('bsHome')) return;
    const a = document.createElement('a');
    a.id = 'bsHome'; a.href = 'https://bluesales.ru/app'; a.textContent = 'BlueSales';
    info.parentNode.insertBefore(a, info);
    const st = document.createElement('style');
    st.textContent =
      // по ширине и краю совпадает с плашкой почты под ней
      '#bsHome{display:flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;width:' + (info.offsetWidth ? info.offsetWidth + 'px' : '100%') + ';height:26px;margin:8px 0 6px ' + Math.max(0, info.getBoundingClientRect().left - info.parentNode.getBoundingClientRect().left) + 'px;' +
      'border-radius:10px;font-size:12.5px;font-weight:600;text-decoration:none!important;background:var(--bs-accent,#3b82f6);color:#fff!important}' +
      '#bsHome::before{content:"";width:6px;height:6px;border-radius:50%;background:#fff}#bsHome:hover{filter:brightness(1.1)}';
    document.head.appendChild(st);
  }
  document.addEventListener('DOMContentLoaded', homeInit);

  // ---------- Поиск по быстрым фразам ----------
  // Ищет и по названию фразы, и по её полному тексту (он лежит в title ссылки).
  const norm = t => (t || '').toLowerCase().replace(/ё/g, 'е');
  function faqFilter() {
    const fc = document.getElementById('faqContent'), inp = document.getElementById('bsFaqSearch');
    if (!fc || !inp) return;
    const q = norm(inp.value.trim());
    fc.classList.toggle('bs-faq-searching', !!q);
    fc.querySelectorAll('p[id^="content_"]').forEach(p => {
      let found = 0;
      p.querySelectorAll('a').forEach(a => {
        const ok = !q || norm(a.textContent + ' ' + (a.title || a.dataset.bsTip || '')).includes(q);
        a.classList.toggle('bs-faq-hide', !ok);
        const br = a.nextElementSibling;
        if (br && br.tagName === 'BR') br.classList.toggle('bs-faq-hide', !ok);
        if (ok) found++;
      });
      const head = document.getElementById(p.id + '_filter');
      p.classList.toggle('bs-faq-hide', !!q && !found);
      if (head) head.classList.toggle('bs-faq-hide', !!q && !found);
    });
  }
  function faqInit() {
    const fc = document.getElementById('faqContent');
    if (!fc || document.getElementById('bsFaqSearch')) return;
    const inp = document.createElement('input');
    inp.id = 'bsFaqSearch';
    inp.type = 'search';
    inp.placeholder = 'Поиск по фразам';
    inp.autocomplete = 'off';
    inp.addEventListener('input', faqFilter);
    inp.addEventListener('keydown', e => { if (e.key === 'Escape') { inp.value = ''; faqFilter(); } });
    fc.parentNode.insertBefore(inp, fc);
    const st = document.createElement('style');
    st.textContent =
      '#bsFaqSearch{display:block;width:100%;box-sizing:border-box;margin:0 0 6px;padding:5px 9px;font-size:12.5px;' +
      'border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:var(--bs-panel,#fff);color:var(--bs-text,#222);outline:none}' +
      '#bsFaqSearch:focus{border-color:var(--bs-accent,#3b82f6)}' +
      '#faqContent .bs-faq-hide{display:none!important}' +
      '#faqContent.bs-faq-searching p[id^="content_"]{display:block!important}';
    document.head.appendChild(st);
  }
  // панель фраз сайт может перерисовать – тогда ставим поле заново и повторяем фильтр
  let faqT = 0;
  const faqObs = new MutationObserver(() => {
    if (faqT) return;
    faqT = setTimeout(() => {
      faqT = 0;
      if (!document.getElementById('faqContent')) return;
      if (!document.getElementById('bsFaqSearch')) faqInit();
      const inp = document.getElementById('bsFaqSearch');
      if (inp && inp.value) faqFilter();
    }, 200);
  });
  document.addEventListener('DOMContentLoaded', () => {
    faqInit();
    faqObs.observe(document.body, { childList: true, subtree: true });
  });

  // ---------- Подсказка с текстом быстрой фразы ----------
  // Системный title заменяем своей карточкой. Перед кликом title возвращаем – вдруг сайт берёт текст из него.
  function tipHide() { const t = document.getElementById('bsTip'); if (t) t.style.display = 'none'; }
  function tipShow(a) {
    let t = document.getElementById('bsTip');
    if (!t) { t = document.createElement('div'); t.id = 'bsTip'; document.body.appendChild(t); }
    t.textContent = a.dataset.bsTip;
    t.style.display = 'block';
    const r = a.getBoundingClientRect(), w = t.offsetWidth, h = t.offsetHeight;
    // с той стороны от фразы, где больше места
    const x = r.left > innerWidth - r.right ? r.left - w - 10 : r.right + 10;
    t.style.left = Math.max(8, Math.min(innerWidth - w - 8, x)) + 'px';
    t.style.top = Math.max(8, Math.min(innerHeight - h - 8, r.top + r.height / 2 - h / 2)) + 'px';
  }
  const tipLink = ev => ev.target.closest && ev.target.closest('#faqContent a[title], #faqContent a[data-bs-tip]');
  document.addEventListener('mouseover', ev => {
    const a = tipLink(ev);
    if (!a) return;
    if (a.title) { a.dataset.bsTip = a.title; a.removeAttribute('title'); }
    if (a.dataset.bsTip.trim()) tipShow(a);
  });
  document.addEventListener('mouseout', ev => {
    const a = tipLink(ev);
    if (!a || (ev.relatedTarget && a.contains(ev.relatedTarget))) return;
    tipHide();
    if (a.dataset.bsTip && !a.title) a.title = a.dataset.bsTip;
  });
  document.addEventListener('mousedown', ev => {
    tipHide();
    const a = tipLink(ev);
    if (a && a.dataset.bsTip && !a.title) a.title = a.dataset.bsTip;
  }, true);
  document.addEventListener('click', ev => {
    const a = tipLink(ev);
    if (a) setTimeout(() => { if (a.matches(':hover') && a.title) a.removeAttribute('title'); });
  });
  addEventListener('scroll', tipHide, true);

  // ---------- Выпадашки вместо системных select (CRM-статус, менеджер в напоминаниях…) ----------
  function selClose() { const p = document.getElementById('bsSelPop'); if (p) p.remove(); }
  function selOpen(sel) {
    selClose();
    const p = document.createElement('div');
    p.id = 'bsSelPop';
    p._sel = sel;
    [...sel.options].forEach((o, i) => {
      if (o.hidden) return;
      const d = document.createElement('div');
      d.textContent = o.text.trim() || '–';
      if (i === sel.selectedIndex) d.className = 'bs-on';
      if (o.disabled) d.classList.add('bs-off');
      d.addEventListener('mousedown', e => e.preventDefault());
      d.addEventListener('click', () => {
        if (o.disabled) return;
        selClose();
        if (sel.selectedIndex === i) return;
        sel.selectedIndex = i;
        sel.dispatchEvent(new Event('input', { bubbles: true }));
        sel.dispatchEvent(new Event('change', { bubbles: true }));
      });
      p.appendChild(d);
    });
    document.body.appendChild(p);
    const r = sel.getBoundingClientRect(), below = innerHeight - r.bottom - 10, above = r.top - 10;
    p.style.minWidth = Math.max(160, r.width) + 'px';
    p.style.left = Math.max(8, Math.min(r.left, innerWidth - p.offsetWidth - 8)) + 'px';
    if (p.offsetHeight > below && above > below) { p.style.bottom = (innerHeight - r.top + 4) + 'px'; p.style.maxHeight = Math.min(320, above) + 'px'; }
    else { p.style.top = (r.bottom + 4) + 'px'; p.style.maxHeight = Math.min(320, below) + 'px'; }
    const on = p.querySelector('.bs-on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }
  document.addEventListener('mousedown', ev => {
    if (ev.target.closest && ev.target.closest('#bsSelPop')) return;
    const s = ev.target.closest && ev.target.closest('select');
    const open = document.getElementById('bsSelPop');
    if (!s || s.multiple || s.size > 1 || s.disabled) { if (open) selClose(); return; }
    ev.preventDefault();
    s.focus();
    if (open && open._sel === s) selClose(); else selOpen(s);
  }, true);
  document.addEventListener('keydown', ev => { if (ev.key === 'Escape') selClose(); }, true);
  addEventListener('scroll', ev => { if (!(ev.target.closest && ev.target.closest('#bsSelPop'))) selClose(); }, true);
  addEventListener('resize', selClose);

  // ---------- Напоминания: подсвечиваем строку открытого чата ----------
  // Строка – предок с самым большим числом одинаковых соседей (при равенстве – внешний).
  function remRow(e, box) {
    let best = null, n = 1;
    for (; e && e !== box; e = e.parentElement) {
      const p = e.parentElement;
      if (!p) break;
      const sig = x => x.tagName + (x.getAttribute('class') || '').replace('bs-rem-cur', '').trim();
      const same = [...p.children].filter(x => sig(x) === sig(e)).length;
      if (same > 1 && same >= n) { best = e; n = same; }
    }
    return best;
  }
  function remMark() {
    const box = document.getElementById('remindersContentInner');
    if (!box) return;
    const id = curDialog(), nm = norm((document.querySelector('.dialog_header .person_name') || {}).textContent || '').trim();
    let row = null;
    if (id || nm) for (const e of box.querySelectorAll('*')) {
      if (e.closest('#remindersTabs,#reminderFiltersAdditional')) continue;
      const hit = (id && [...e.attributes].some(a => a.name !== 'class' && a.value.includes(id))) ||
        (nm && !e.children.length && norm(e.textContent).trim() === nm);
      if (hit && (row = remRow(e, box))) break;
    }
    box.querySelectorAll('.bs-rem-cur').forEach(x => { if (x !== row) x.classList.remove('bs-rem-cur'); });
    if (row && !row.classList.contains('bs-rem-cur')) row.classList.add('bs-rem-cur');
  }

  // ---------- Подсказки при вводе {…}: свои фразы и тарифы ----------
  let acList = [], acI = 0;
  function acClose() { const p = document.getElementById('bsAc'); if (p) p.remove(); acList = []; }
  function acFind(q) {
    const words = norm(q).split(/[\s,.;]+/).filter(Boolean);
    const fit = k => { const own = norm(k).split(/[\s,.;:+/|]+/).filter(Boolean); return words.every(w => own.some(x => x.startsWith(w))); };
    return [...jget(SNIP_KEY, []).filter(x => x.k && fit(x.k)).map(x => ({ k: x.k, v: x.v, d: x.v, kind: 'фраза' })),
      ...jget(TAR_KEY, []).filter(x => x.k && x.u && fit(x.k)).map(x => ({ k: x.k, v: x.u, d: x.p ? x.p + ' ₽' : x.u, kind: 'ссылка' }))].slice(0, 8);
  }
  function acPaint(ta) {
    let p = document.getElementById('bsAc');
    if (!acList.length) return acClose();
    if (!p) {
      p = document.createElement('div');
      p.id = 'bsAc';
      p.addEventListener('mousedown', e => e.preventDefault());
      p.addEventListener('click', e => { const d = e.target.closest('[data-i]'); if (d) acPick(ta, +d.dataset.i); });
      document.body.appendChild(p);
    }
    p.innerHTML = '';
    acList.forEach((x, i) => {
      const d = document.createElement('div');
      d.dataset.i = i;
      if (i === acI) d.className = 'bs-on';
      d.innerHTML = '<b></b><s></s><span></span>';
      d.children[0].textContent = x.k;
      d.children[1].textContent = x.kind;
      d.children[2].textContent = x.d.replace(/\s+/g, ' ');
      p.appendChild(d);
    });
    const box = document.querySelector('.send_message_box') || ta, r = box.getBoundingClientRect();
    p.style.left = r.left + 'px';
    p.style.width = Math.min(520, r.width) + 'px';
    p.style.bottom = (innerHeight - r.top + 6) + 'px';
  }
  function acPick(ta, i) {
    const x = acList[i], end = ta.selectionStart, m = /\{([^{}\n]*)$/.exec(ta.value.slice(0, end));
    acClose();
    if (!x || !m) return;
    let after = ta.value.slice(end);
    // если закрывающая скобка уже стоит сразу после курсора – её тоже убираем
    const close = /^[^{}\n]*\}/.exec(after);
    if (close) after = after.slice(close[0].length);
    ta.value = ta.value.slice(0, m.index) + x.v + after;
    const pos = m.index + x.v.length;
    ta.focus();
    ta.setSelectionRange(pos, pos);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    tarHint('✓ ' + x.kind + ': ' + x.k, true);
  }
  document.addEventListener('input', ev => {
    const ta = ev.target;
    if (!ta.matches || !ta.matches('textarea.send_message_textarea')) return;
    const m = /\{([^{}\n]*)$/.exec(ta.value.slice(0, ta.selectionStart));
    if (!m) return acClose();
    acList = acFind(m[1]);
    acI = 0;
    acPaint(ta);
  });
  document.addEventListener('keydown', ev => {
    const ta = ev.target;
    if (!acList.length || !ta.matches || !ta.matches('textarea.send_message_textarea')) return;
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') acI = (acI + (ev.key === 'ArrowDown' ? 1 : acList.length - 1)) % acList.length, acPaint(ta);
    else if ((ev.key === 'Enter' && !ev.shiftKey) || ev.key === 'Tab') acPick(ta, acI);
    else if (ev.key === 'Escape') acClose();
    else return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
  }, true);
  document.addEventListener('mousedown', ev => { if (!(ev.target.closest && ev.target.closest('#bsAc'))) acClose(); }, true);

  document.addEventListener('DOMContentLoaded', () => {
    const st = document.createElement('style');
    st.textContent =
      '#bsTip{position:fixed;z-index:3200;display:none;max-width:340px;max-height:60vh;overflow:hidden;box-sizing:border-box;padding:9px 12px;border-radius:10px;' +
      'font-size:12.5px;line-height:1.45;white-space:pre-wrap;overflow-wrap:anywhere;pointer-events:none;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#e3e7ec);box-shadow:0 10px 30px rgba(16,24,40,.16)}' +
      '#bsSelPop,#bsAc{position:fixed;z-index:3200;box-sizing:border-box;overflow-y:auto;padding:4px;border-radius:10px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#e3e7ec);box-shadow:0 10px 30px rgba(16,24,40,.14)}' +
      '#bsSelPop{max-width:340px}' +
      '#bsSelPop>div,#bsAc>div{padding:5px 9px;border-radius:6px;font-size:12px;line-height:1.3;font-weight:600;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#bsSelPop>div:hover,#bsAc>div:hover,#bsAc>div.bs-on{background:var(--bs-hover,#f3f4f6)}' +
      '#bsSelPop>div.bs-on{color:var(--bs-accent,#3b82f6)}#bsSelPop>div.bs-off{opacity:.45;cursor:default}' +
      '#bsAc{max-height:260px}#bsAc>div{display:flex;align-items:baseline;gap:8px}' +
      '#bsAc b{flex:none;font-weight:700}#bsAc s{flex:none;text-decoration:none;font-size:10.5px;font-weight:600;padding:0 6px;border-radius:6px;background:var(--bs-accent-soft,#e8f0fe);color:var(--bs-accent,#3b82f6)}' +
      '#bsAc span{min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:400;color:var(--bs-muted,#888)}' +
      '#remindersContentInner .bs-rem-cur{background:none!important;box-shadow:none!important}' +
      '#remindersContentInner .bs-rem-cur>*{background:var(--bs-accent-soft,#e8f0fe)!important}' +
      '#remindersContentInner .bs-rem-cur>:first-child{border-radius:6px 0 0 6px!important;color:var(--bs-accent,#3b82f6)!important;font-weight:600!important}' +
      '#remindersContentInner .bs-rem-cur>:last-child{border-radius:0 6px 6px 0!important}' +
      '#remindersContentInner .bs-rem-cur>:only-child{border-radius:6px!important}' +
      '.bs-ghost .dialogs_list_item_content{padding:8px 12px!important}.bs-ghost .dialogs_list_preview{font-style:italic;opacity:.75}';
    document.head.appendChild(st);
  });
})();
