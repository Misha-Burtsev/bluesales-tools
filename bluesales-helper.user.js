// ==UserScript==
// @name         BlueSales – помощник
// @namespace    bluesales-sounds
// @version      1.25.0
// @description  Звуки, избранные смайлики и поиск по ним, переключатель темы, таймер «клиент ждёт», черновики по чатам, поиск по быстрым фразам, предпросмотр чата без прочтения в мессенджере BlueSales.
// @match        https://bluesales.ru/*
// @run-at       document-start
// @grant        none
// @updateURL    https://raw.githubusercontent.com/Misha-Burtsev/bluesales-tools/main/bluesales-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Misha-Burtsev/bluesales-tools/main/bluesales-helper.user.js
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
  const send = XMLHttpRequest.prototype.send, open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, url) { this._bsUrl = String(url || ''); return open.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) {
    const text = this._bsUrl + ' ' + (typeof body === 'string' ? body : '');
    if (/dialogs\.sendMessage/.test(text)) {
      const id = curDialog();
      playSent();
      this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) { onSent(id); tarSent(text); } else failTone(); });
      this.addEventListener('error', failTone);
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
    emoFilter();
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
    bar.append(inp, label);
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
      '#bsEmoLabel{display:none;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;color:var(--bs-muted,#888);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;padding-left:4px}',
      'body.bs-emo-closed #bsEmoSearch{display:none}',
      'body.bs-emo-closed #bsEmoLabel{display:block}',
      '#bsEmoToggle{position:fixed;z-index:2002;display:none;height:34px;justify-content:flex-end;padding:6px 12px 0 0;outline:none!important;box-shadow:none!important;border:0!important;box-sizing:border-box;border-radius:11px 11px 0 0;background:none!important}',
      '#bsEmoToggle:hover{color:var(--bs-text,#222)}',
      '#bsEmoToggle:focus,#bsEmoToggle:focus-visible,#bsEmoToggle:active{outline:none!important;box-shadow:none!important}',
      '#bsEmoLabel::after{content:" ▴"}',
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
    paintDock();
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
    const OWN = '#bsDock,#bsEmoBar,#bsRemList,#bsLinks,#bsToasts,#bsMenu,#bsRepWrap,#bsHome,#bsSndMenu,#bsEmoToggle,#bsPeek,#bsSold,#bsTarWrap,#bsTarHint,#bsSaleWrap';
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
  const itemById = id => document.querySelector('.dialogs_list_item[data-dialog-id="' + id + '"]');
  // чат есть в списке – кликаем; нет (не подгружен, другой канал, фильтр) – открываем по ссылке, сайт сам найдёт канал
  function openChat(id) {
    const it = itemById(id);
    if (it) it.click();
    else location.assign(location.origin + '/app/Messenger/?dialogId=' + encodeURIComponent(id));
  }
  const nameOf = it => { const n = it && it.querySelector('.dialogs_list_person_name'); return n ? n.textContent.trim() : ''; };

  function togglePin(id) {
    const p = jget(PIN_KEY, []), i = p.indexOf(id);
    if (i >= 0) p.splice(i, 1); else p.push(id);
    jset(PIN_KEY, p); paintMarks();
  }
  function setRemind(id, hours, note) {
    const r = jget(REM_KEY, {});
    if (hours > 0) r[id] = { at: Date.now() + Math.round(hours * 3600e3), name: nameOf(itemById(id)) || (r[id] && r[id].name) || '', note: (note || '').trim() };
    else delete r[id];
    jset(REM_KEY, r); paintMarks();
  }
  function remText(ms) {
    const min = Math.ceil(ms / 60000);
    return min < 60 ? min + ' мин' : Math.floor(min / 60) + ':' + String(min % 60).padStart(2, '0');
  }
  // значки 📌 и ⏰ у имени + закреплённые наверх списка
  function paintMarks() {
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
        new window.blueSales.blueSalesApi().callApi(method, params, { version: 1 })
          .done(r => ok(r && r.response)).fail(e => fail(e));
      } catch (e) { fail(e); }
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
    p.querySelector('button').onclick = () => { closePeek(); it.click(); };
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
    const r = jget(REP_KEY, {});
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
  function closeReport() { const o = document.getElementById('bsRepWrap'); if (o) o.remove(); }
  function openReport() {
    if (document.getElementById('bsRepWrap')) return closeReport();
    const wrap = document.createElement('div');
    wrap.id = 'bsRepWrap';
    wrap.innerHTML =
      '<div id="bsRep"><div class="bs-rep-head"><b>Отчёт за смену</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-rep-top"><div class="bs-rep-range">' + MANAGERS.map(([id, n]) => '<span data-m="' + id + '">' + n + '</span>').join('') + '</div>' +
      '<input type="date" class="bs-rep-date" title="Дата отчёта"></div>' +
      '<div class="bs-rep-grid">' + REP_FIELDS.map(([k, label, auto]) =>
        '<label' + (auto ? ' class="bs-auto"' : '') + '><span>' + label + '</span><input type="number" min="0" data-k="' + k + '"></label>').join('') + '</div>' +
      '<div class="bs-rep-status"></div>' +
      '<textarea spellcheck="false"></textarea>' +
      '<div class="bs-rep-btns"><span class="bs-rep-edited">Текст правлен вручную</span><button data-a="rebuild" class="bs-rep-edited" title="Собрать текст из цифр заново">Собрать заново</button><button data-a="reload">Обновить цифры</button><button data-a="copy" class="bs-main">Скопировать</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsRep'), ta = box.querySelector('textarea'), status = box.querySelector('.bs-rep-status');
    const inputs = {};
    box.querySelectorAll('input[data-k]').forEach(i => { inputs[i.dataset.k] = i; });
    const saved = repSaved();
    for (const k in inputs) if (saved[k] != null) inputs[k].value = saved[k];
    if (saved.rem == null) inputs.rem.value = 0;
    let manager = localStorage.getItem('bsRepManager') || MANAGERS[0][0];
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
      if (!edited) ta.value = repText(values(), (MANAGERS.find(x => x[0] === manager) || [])[2]);
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
        if (my !== run) return;   // пока считали, переключили менеджера
        inputs.leads.value = leads; inputs.blocks.value = blocks; inputs.chats.value = chats;
        setStatus('ok', 'Посчитано – ' + who + ', ' + t.slice(0, 5) + '. Остальное впиши руками');
        box.classList.remove('bs-done'); void box.offsetWidth; box.classList.add('bs-done');
      } catch (e) {
        if (my !== run) return;
        setStatus('err', 'Не получилось посчитать – впиши цифры руками');
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
      if (ev.target.tagName === 'I') closeReport();
      else if (r) { manager = r; try { localStorage.setItem('bsRepManager', r); } catch (e) {} paintRange(); load(true); }
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
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeReport(); });
    paintRange(); update(); load();
  }
  function reportInit() {
    const dock = document.getElementById('bsDock'), before = document.getElementById('bsThemeBtn');
    if (!dock || document.getElementById('bsRepBtn')) return;
    const b = btn('bsRepBtn', 'Отчёт за смену');
    b.innerHTML = svg('<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V3h6v1M9 10h6M9 14h6M9 18h3"/>');
    b.addEventListener('click', openReport);
    dock.insertBefore(b, before);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeReport(); });
    const st = document.createElement('style');
    st.textContent =
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
    const b = document.getElementById('bsLinks');
    if (b) b.querySelector('b').textContent = linksGet();
  }
  function placeLinks() {
    const b = document.getElementById('bsLinks'), dock = document.getElementById('bsDock');
    if (!b || !dock) return;
    const on = document.body.classList.contains('slide-panel-right-open');
    const tog = document.getElementById('bsEmoToggle');
    b.style.display = on ? 'flex' : 'none';
    const sd = document.getElementById('bsSold');
    if (sd) sd.style.display = b.style.display;
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
    const sold = document.getElementById('bsSold');
    if (sold) sold.style.bottom = (innerHeight - b.getBoundingClientRect().top + 6) + 'px';
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
    const room = r.bottom - (bottom + 8 + pill.offsetHeight + 6);
    if (room < r.height) sel.style.setProperty('height', Math.max(110, room) + 'px', 'important');
  }
  function linksInit() {
    if (document.getElementById('bsLinks')) return;
    const b = document.createElement('div');
    b.id = 'bsLinks';
    b.className = 'bs-pill';
    b.innerHTML = '<span>Ссылки</span><b></b><i data-d="-1" class="bs-ico" title="Убрать одну">−</i><i data-d="1" class="bs-cta bs-sq" title="Выставил ссылку">+</i>';
    b.addEventListener('click', ev => { const i = ev.target.closest('i'); if (!i) return; const d = +i.dataset.d; if (d) linksSet(linksGet() + d); });
    document.body.appendChild(b);
    const st = document.createElement('style');
    st.textContent =
      '.bs-pill{position:fixed;right:12px;width:230px;height:36px;box-sizing:border-box;z-index:2001;align-items:center;gap:2px;padding:0 5px 0 12px;border-radius:12px;font-size:12.5px;' +
      'background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);color:var(--bs-muted,#888)}' +
      '.bs-pill span{width:60px;flex:none;white-space:nowrap}' +
      '.bs-pill b{flex:1;min-width:0;color:var(--bs-text,#222);font-size:15px;font-weight:700;font-variant-numeric:tabular-nums}' +
      '.bs-pill i{font-style:normal;flex:none;height:26px;box-sizing:border-box;display:flex;align-items:center;justify-content:center;border-radius:8px;cursor:pointer;user-select:none}' +
      '.bs-pill i.bs-ico{width:26px;font-size:16px;color:var(--bs-muted,#888)}.bs-pill i.bs-ico:hover{background:var(--bs-hover,#f3f4f6);color:var(--bs-text,#222)}' +
      '.bs-pill i.bs-cta{margin-left:2px;padding:0 10px;background:var(--bs-accent,#3b82f6);color:#fff;font-size:12.5px;font-weight:600}.bs-pill i.bs-cta:hover{filter:brightness(1.1)}' +
      '.bs-pill i.bs-sq{width:26px;padding:0;font-size:17px;font-weight:500}';
    document.head.appendChild(st);
    paintLinks(); placeLinks();
    document.getElementById('bsEmoToggle')?.addEventListener('click', () => setTimeout(placeLinks));
    document.getElementById('bsEmoLabel')?.addEventListener('click', () => setTimeout(placeLinks));
    addEventListener('resize', placeLinks);
    // панель смайликов сворачивается и появляется – просто переставляем раз в секунду, это дёшево
    setInterval(() => { placeLinks(); paintLinks(); paintSold(); homeInit(); }, 1000);
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
    const b = document.getElementById('bsSold');
    if (b) b.querySelector('b').textContent = String(soldGet()).replace('.', ',');
  }
  function soldInit() {
    if (document.getElementById('bsSold')) return;
    const b = document.createElement('div');
    b.id = 'bsSold';
    b.className = 'bs-pill';
    b.style.display = 'none';
    b.innerHTML = '<span>Продано</span><b></b><i data-a="list" class="bs-ico" title="Продажи за смену"><svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/></svg></i><i data-a="new" class="bs-cta" title="Добавить продажу в этом чате">+ Продажа</i>';
    b.addEventListener('click', ev => { const i = ev.target.closest('i'), a = i && i.dataset.a; if (a === 'list') openSales(); else if (a === 'new') openSale(); });
    document.body.appendChild(b);
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
  function tarParse(text) {
    return text.split('\n').map(l => l.split('|').map(x => x.trim())).filter(c => c.length >= 2 && /^https?:\/\//.test(c[1]))
      .map(([k, u, p, ...n]) => ({ k, u, p: p || '', n: n.join(' | ') }));
  }
  const tarText = list => list.map(t => t.k + ' | ' + t.u + (t.p || t.n ? ' | ' + t.p : '') + (t.n ? ' | ' + t.n : '')).join('\n');
  function tarFind(query) {
    const { tags, unknown } = tarTags(query);
    if (unknown.length) return { err: 'Не понял: ' + unknown.join(', ') };
    if (!tags.size) return { err: 'Пустое сокращение' };
    const list = jget(TAR_KEY, []);
    if (!list.length) return { err: 'Тарифов нет – добавь их через ☰ на плашке «Ссылок выставлено»' };
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
  // свои фразы: «## ключ» и под ним текст (можно в несколько строк); {ключ} – слова в любом порядке
  const SNIP_KEY = 'bsSnippets';
  const snipKey = t => norm(t).split(/[\s,.;]+/).filter(Boolean).sort().join(' ');
  function snipParse(text) {
    const out = [];
    text.split('\n').forEach(l => {
      const h = /^##\s*(.+)$/.exec(l);
      if (h) out.push({ k: h[1].trim(), v: [] });
      else if (out.length) out[out.length - 1].v.push(l);
    });
    return out.map(x => ({ k: x.k, v: x.v.join('\n').trim() })).filter(x => x.k && x.v);
  }
  const snipText = list => list.map(x => '## ' + x.k + '\n' + x.v).join('\n\n');
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
  // сообщение ушло – сколько в нём ссылок из тарифов, столько +1 в «Ссылок выставлено»
  function tarSent(raw) {
    let t = raw.replace(/\\\//g, '/');
    try { t += ' ' + decodeURIComponent(raw.replace(/\+/g, ' ')); } catch (e) {}
    const n = jget(TAR_KEY, []).filter(x => t.includes(x.u)).length;
    if (n) linksSet(linksGet() + n);
  }
  function closeTariffs() { const o = document.getElementById('bsTarWrap'); if (o) o.remove(); }
  function openTariffs() {
    if (document.getElementById('bsTarWrap')) return closeTariffs();
    const wrap = document.createElement('div');
    wrap.id = 'bsTarWrap';
    wrap.innerHTML =
      '<div id="bsTar"><div class="bs-rep-head"><b>Сокращения {…}</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-rep-range bs-tar-tabs"><span data-tab="tar" class="bs-on">Тарифы</span><span data-tab="snip">Свои фразы</span></div>' +
      '<div class="bs-tar-pane" data-pane="tar"><div class="bs-tar-help">Строка: <code>слова | ссылка | цена | название для отчёта</code> (название можно не писать – соберётся само).<br>' +
      'Слова: мат (проф), баз, рус, комбо (или мат+рус) · бронь (месяц) / год · кур / сам (без кур). Порядок любой, например <code>{рус сам год}</code>.</div>' +
      '<textarea data-k="tar" spellcheck="false" placeholder="мат бронь сам | https://… | 4990"></textarea></div>' +
      '<div class="bs-tar-pane" data-pane="snip" hidden><div class="bs-tar-help">Строка <code>## ключ</code>, под ней текст или ссылка – можно в несколько строк. В сообщении <code>{мат отзывы}</code> заменится на этот текст. Слова ключа – в любом порядке.</div>' +
      '<textarea data-k="snip" spellcheck="false" placeholder="## мат отзывы&#10;Вот отзывы наших учеников: …&#10;&#10;## мат пробный&#10;https://…"></textarea></div>' +
      '<div class="bs-rep-btns"><span class="bs-tar-note">Хранится только в этом браузере</span><span class="bs-tar-st"></span><button data-a="save" class="bs-main">Сохранить</button></div></div>';
    document.body.appendChild(wrap);
    const taT = wrap.querySelector('[data-k="tar"]'), taS = wrap.querySelector('[data-k="snip"]'), st = wrap.querySelector('.bs-tar-st');
    taT.value = tarText(jget(TAR_KEY, []));
    taS.value = snipText(jget(SNIP_KEY, []));
    wrap.addEventListener('click', ev => {
      const tab = ev.target.dataset.tab;
      if (ev.target.matches('.bs-rep-head i')) closeTariffs();
      else if (tab) {
        wrap.querySelectorAll('[data-tab]').forEach(e => e.classList.toggle('bs-on', e === ev.target));
        wrap.querySelectorAll('[data-pane]').forEach(e => { e.hidden = e.dataset.pane !== tab; });
        (tab === 'tar' ? taT : taS).focus();
      } else if (ev.target.dataset.a === 'save') {
        const list = tarParse(taT.value), sn = snipParse(taS.value);
        jset(TAR_KEY, list); jset(SNIP_KEY, sn);
        taT.value = tarText(list); taS.value = snipText(sn);
        st.textContent = 'Сохранено: тарифов ' + list.length + ', фраз ' + sn.length;
      }
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeTariffs(); });
    taT.focus();
  }

  function tariffsInit() {
    document.addEventListener('input', tarOnInput, true);
    document.addEventListener('keydown', ev => { if (ev.key === 'Escape') closeTariffs(); });
    const st = document.createElement('style');
    st.textContent =
      '#bsTarWrap{position:fixed;inset:0;z-index:3100;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center}' +
      '#bsTar{width:640px;max-width:calc(100vw - 32px);box-sizing:border-box;padding:14px 16px;border-radius:14px;font-size:13px;' +
      'background:var(--bs-panel,#fff);color:var(--bs-text,#222);border:1px solid var(--bs-border,#D9E0E7);box-shadow:0 12px 40px rgba(0,0,0,.25)}' +
      '.bs-tar-help{font-size:12px;line-height:1.5;color:var(--bs-muted,#888);margin-bottom:8px}' +
      '.bs-tar-help code{padding:0 4px;border-radius:4px;background:var(--bs-hover,#f3f5f8);color:var(--bs-text,#222)}' +
      '#bsTar textarea{width:100%;box-sizing:border-box;height:300px;resize:vertical;padding:8px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:var(--bs-hover,#f5f7fa);color:var(--bs-text,#222);font:12px/1.5 ui-monospace,Menlo,monospace;white-space:pre;overflow-wrap:normal}' +
      '.bs-tar-st{margin-right:auto;align-self:center;font-size:12px;color:#1f9d55}.bs-tar-st:not(:empty)~*{}.bs-tar-note{align-self:center;font-size:11.5px;color:var(--bs-muted,#888)}.bs-tar-st:not(:empty){margin-left:8px}' +
      '.bs-tar-tabs{margin-bottom:8px}.bs-tar-pane[hidden]{display:none}' +
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
  function salesGet() { const r = jget(SALES_KEY, {}); return r.d === ddmm(new Date()) ? r.list || [] : []; }
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
      rub(x.price) + ' рублей',
      'МОП: ' + joinMops(x.mops),
      who.join('\n'),
      'Источник: ' + (x.src || ''),
      '"' + (x.quote || '').trim() + '"',
    ].filter(Boolean).join('\n\n');
  }
  const saleDone = x => !!((x.email || '').trim() && (x.fio || '').trim());
  function closeSale() { const o = document.getElementById('bsSaleWrap'); if (o) o.remove(); }
  // id – открыть сохранённую продажу; без id – новая в текущем чате
  function openSale(id) {
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
    let shareTouched = !!old;
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const field = (k, label, ph, tag) => '<label><span>' + label + '</span>' + (tag === 'ta' ? '<textarea data-k="' + k + '" rows="2" placeholder="' + (ph || '') + '"></textarea>' : '<input data-k="' + k + '" placeholder="' + (ph || '') + '"' + (k === 'price' ? ' type="number" min="0"' : '') + '>') + '</label>';
    wrap.innerHTML =
      '<div id="bsSale"><div class="bs-rep-head"><b>' + (old ? 'Продажа' : 'Новая продажа') + (x.who ? ' – ' + esc(x.who) : '') + '</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-sale-cols"><div class="bs-sale-form">' +
      '<label><span>Тариф</span><select data-k="tar"><option value="">– выбери –</option>' + tars.map((t, i) => '<option value="' + i + '">' + esc(t.k) + (t.p ? ' · ' + rub(t.p) : '') + '</option>').join('') + '<option value="own">другой (впишу сам)</option></select></label>' +
      field('name', 'Название в отчёте', 'Годовой курс ЕГЭ | …') + field('price', 'Цена, ₽', '0') +
      '<label><span>МОП</span><div class="bs-chips" data-g="mops">' + MANAGERS.map(m => '<em data-v="' + m[1] + '">' + m[1] + '</em>').join('') + '</div></label>' +
      '<label><span>Доля продажи</span><div class="bs-chips" data-g="share">' + SHARES.map(([v, t]) => '<em data-v="' + v + '">' + t + '</em>').join('') + '</div></label>' +
      field('email', 'Почта', 'когда пришлёт') + field('fio', 'Имя и фамилия', 'когда пришлёт') + field('nick', 'Ник', '@…') +
      field('src', 'Источник', 'из тегов или вручную') + field('quote', 'Откуда узнал о нас', 'своими словами клиента', 'ta') +
      '</div><div class="bs-sale-prev"><span>Текст для Telegram</span><textarea readonly spellcheck="false"></textarea><div class="bs-sale-note"></div></div></div>' +
      '<div class="bs-rep-btns">' + (old ? '<button data-a="del" class="bs-sale-del">Удалить</button>' : '') + '<span class="bs-tar-st"></span><button data-a="save">Сохранить</button><button data-a="copy" class="bs-main">Сохранить и скопировать</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsSale'), prev = box.querySelector('.bs-sale-prev textarea'), note = box.querySelector('.bs-sale-note');
    const inp = k => box.querySelector('[data-k="' + k + '"]');
    ['name', 'price', 'email', 'fio', 'nick', 'src', 'quote'].forEach(k => { inp(k).value = x[k] == null ? '' : x[k]; });
    inp('tar').value = x.tar;
    const paint = () => {
      box.querySelectorAll('[data-g="mops"] em').forEach(e => e.classList.toggle('bs-on', x.mops.includes(e.dataset.v)));
      box.querySelectorAll('[data-g="share"] em').forEach(e => e.classList.toggle('bs-on', +e.dataset.v === x.share));
      prev.value = saleText(x);
      const part = Math.round((+x.price || 0) * x.share);
      note.textContent = 'В отчёт смены: продано +' + String(x.share).replace('.', ',') + ', сумма +' + rub(part) + ' ₽' + (saleDone(x) ? '' : ' · почту и имя можно дописать потом');
    };
    box.addEventListener('input', ev => {
      const k = ev.target.dataset.k;
      if (!k || k === 'tar') return;
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
      const all = salesGet(), i = all.findIndex(s => s.id === x.id), was = i >= 0 ? all[i] : null;
      const part = s => s ? Math.round((+s.price || 0) * s.share) : 0;
      const dShare = r2(x.share - (was ? was.share : 0));
      if (dShare) soldAdd(dShare);
      sumAdd(part(x) - part(was));
      if (i >= 0) all[i] = x; else all.push(x);
      salesSet(all);
      box.querySelector('.bs-tar-st').textContent = 'Сохранено';
    };
    box.addEventListener('click', ev => {
      const em = ev.target.closest('em'), a = ev.target.dataset.a;
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      if (em) {
        const g = em.parentNode.dataset.g, v = em.dataset.v;
        if (g === 'mops') {
          x.mops = x.mops.includes(v) ? x.mops.filter(m => m !== v) : MANAGERS.map(m => m[1]).filter(n => n === v || x.mops.includes(n));
          if (!shareTouched) x.share = shareFor(x.mops.length);
        } else { x.share = +v; shareTouched = true; }
        paint();
      } else if (a === 'save') { if (!x.name) return inp('tar').focus(); save(); closeSale(); tarHint('✓ Продажа сохранена', true); }
      else if (a === 'copy') {
        if (!x.name) return inp('tar').focus();
        save();
        navigator.clipboard.writeText(prev.value).then(() => { closeSale(); tarHint('✓ Продажа сохранена, текст скопирован', true); });
      } else if (a === 'del') {
        if (!confirm('Удалить эту продажу? Доля и сумма уйдут из отчёта смены.')) return;
        const all = salesGet(), was = all.find(s => s.id === x.id);
        if (was) { soldAdd(-was.share); sumAdd(-Math.round((+was.price || 0) * was.share)); salesSet(all.filter(s => s.id !== x.id)); }
        closeSale();
      }
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
    paint();
  }
  // список продаж за сегодня – клик открывает продажу, чтобы дописать данные
  function openSales() {
    closeSale();
    const list = salesGet();
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-sales"><div class="bs-rep-head"><b>Продажи за смену</b><i title="Закрыть">×</i></div>' +
      (list.length ? '<div class="bs-sales-list">' + list.map(x =>
        '<div class="bs-sales-row" data-id="' + x.id + '"><b>' + esc(x.who || x.fio || 'чат ' + x.dlg) + '</b><span>' + esc(x.name) + '</span>' +
        '<em>' + rub(x.price) + ' ₽ · ' + String(x.share).replace('.', ',') + '</em>' + (saleDone(x) ? '' : '<u>не заполнено</u>') + '</div>').join('') + '</div>'
        : '<div class="bs-tar-help">Сегодня продаж пока нет. Открой чат клиента и нажми «+ продажа».</div>') +
      '</div>';
    document.body.appendChild(wrap);
    wrap.addEventListener('click', ev => {
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      const row = ev.target.closest('.bs-sales-row');
      if (row) openSale(row.dataset.id);
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
      '#bsSale.bs-sales{width:520px}' +
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
      '.bs-sales-list{display:flex;flex-direction:column;gap:6px}' +
      '.bs-sales-row{display:grid;grid-template-columns:1fr auto;gap:2px 10px;padding:8px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:9px;cursor:pointer}' +
      '.bs-sales-row:hover{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-sales-row span{grid-column:1;font-size:12px;color:var(--bs-muted,#888)}.bs-sales-row em{grid-row:1;grid-column:2;font-style:normal;font-weight:600}' +
      '.bs-sales-row u{grid-column:2;text-decoration:none;font-size:11px;color:#e08a1e;text-align:right}';
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
        const ok = !q || norm(a.textContent + ' ' + a.title).includes(q);
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
})();
