// ==UserScript==
// @name         BlueSales – помощник
// @namespace    bluesales-sounds
// @version      1.19.0
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
      this.addEventListener('load', () => { if (this.status >= 200 && this.status < 300) onSent(id); else failTone(); });
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
    if (/dialogs\.sendMessage/.test(url + ' ' + body)) { playSent(); p.then(r => { if (!r.ok) failTone(); }).catch(failTone); }
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
    dock.append(inp, label, theme, snd);
    // кнопка сворачивания – в правом верхнем углу панели смайликов (ставит placeLinks); свёрнутые открываются по «Смайлики» в панели
    document.body.append(dock, tog);

    const st = document.createElement('style');
    st.textContent = [
      '#bsDock{display:none;position:fixed;right:12px;bottom:12px;width:230px;box-sizing:border-box;height:36px;align-items:center;gap:2px;padding:0 4px 0 6px;',
      'background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);border-radius:12px;z-index:2001;font-size:12.5px;color:var(--bs-text,#222)}',
      'body.slide-panel-right-open #bsDock{display:flex}',
      '#bsEmoSearch{flex:1;min-width:0;height:24px;padding:0 8px;border:1px solid var(--bs-border,#D9E0E7)!important;border-radius:7px;background:var(--bs-hover,#f3f4f6)!important;color:var(--bs-text,#222)!important;font-size:12px;outline:none}',
      '#bsEmoSearch:focus{border-color:var(--bs-accent,#3b82f6)!important}',
      '#bsEmoLabel{display:none;flex:1;cursor:pointer;color:var(--bs-muted,#888);font-weight:600;font-size:10.5px;text-transform:uppercase;letter-spacing:.03em;padding-left:4px}',
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
      'html:root body.slide-panel-right-open .send_message_box .emoji_selector{bottom:54px!important}',
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
      if (/запретил присылать/.test(ptxt)) info = null;
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
    const OWN = '#bsDock,#bsRemList,#bsLinks,#bsToasts,#bsMenu,#bsRepWrap,#bsHome,#bsSndMenu,#bsEmoToggle,#bsPeek';
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
    b.innerHTML = '<span class="bs-bot-ic">🤖</span><b></b>';
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
      '#bsBotBtn{position:relative}#bsBotBtn .bs-bot-ic{font-size:14px;line-height:1;filter:grayscale(1);opacity:.7}' +
      '#bsBotBtn.bs-on{background:var(--bs-accent-soft,rgba(59,130,246,.14))!important}#bsBotBtn.bs-on .bs-bot-ic{filter:none;opacity:1}' +
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
      'купили (кол-во программ) - ' + n('bought') + '\n\n' +
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
    if (tog) tog.style.display = 'none';
    if (!on) return;
    const sel = document.querySelector('.send_message_box .emoji_selector');
    const open = sel && sel.getClientRects().length && !document.body.classList.contains('bs-emo-closed');
    if (open) fitEmoji(sel, b);
    const r = open ? sel.getBoundingClientRect() : dock.getBoundingClientRect();
    b.style.bottom = (innerHeight - r.top + 6) + 'px';
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
    b.innerHTML = '<span>Ссылок выставлено</span><i data-d="-1" title="Убрать одну">−</i><b></b><i data-d="1" class="bs-plus" title="Выставил ссылку">+</i>';
    b.addEventListener('click', ev => { const d = +ev.target.dataset.d; if (d) linksSet(linksGet() + d); });
    document.body.appendChild(b);
    const st = document.createElement('style');
    st.textContent =
      '#bsLinks{position:fixed;right:12px;width:230px;box-sizing:border-box;z-index:2001;align-items:center;gap:6px;padding:4px 4px 4px 10px;border-radius:10px;font-size:12.5px;' +
      'background:var(--bs-panel,#fff);border:1px solid var(--bs-border,#D9E0E7);color:var(--bs-muted,#888)}' +
      '#bsLinks span{flex:1}#bsLinks b{min-width:18px;text-align:center;color:var(--bs-text,#222);font-size:13.5px}' +
      '#bsLinks i{font-style:normal;width:24px;height:24px;display:flex;align-items:center;justify-content:center;border-radius:7px;cursor:pointer;user-select:none;font-size:15px}' +
      '#bsLinks i:hover{background:var(--bs-hover,#f3f4f6);color:var(--bs-text,#222)}' +
      '#bsLinks i.bs-plus{background:var(--bs-accent,#3b82f6);color:#fff;font-size:17px}#bsLinks i.bs-plus:hover{filter:brightness(1.1)}';
    document.head.appendChild(st);
    paintLinks(); placeLinks();
    document.getElementById('bsEmoToggle')?.addEventListener('click', () => setTimeout(placeLinks));
    document.getElementById('bsEmoLabel')?.addEventListener('click', () => setTimeout(placeLinks));
    addEventListener('resize', placeLinks);
    // панель смайликов сворачивается и появляется – просто переставляем раз в секунду, это дёшево
    setInterval(() => { placeLinks(); paintLinks(); homeInit(); }, 1000);
  }
  document.addEventListener('DOMContentLoaded', linksInit);

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
