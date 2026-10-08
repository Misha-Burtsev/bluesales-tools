// ==UserScript==
// @name         BlueSales – помощник
// @namespace    bluesales-sounds
// @version      1.35.3
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
    const OWN = '#bsDock,#bsEmoBar,#bsRemList,#bsLinks,#bsToasts,#bsMenu,#bsRepWrap,#bsHome,#bsSndMenu,#bsEmoToggle,#bsPeek,#bsSold,#bsTarWrap,#bsTarHint,#bsSaleWrap,#bsTip,#bsSelPop,#bsAc';
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
      if (ev.target.tagName === 'I') closeReport();
      else if (r) { manager = r; paintRange(); load(true); }
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
    // карточка клиента прокручивается под плашками – снизу у неё отступ на их высоту
    const top = (sold && sold.offsetHeight ? sold : b).getBoundingClientRect().top;
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
    const sold = document.getElementById('bsSold');
    const pills = pill.offsetHeight + 6 + (sold && sold.offsetHeight ? sold.offsetHeight + 6 : 0);
    const room = r.bottom - (bottom + 22 + pills);
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
      '<div class="bs-tar-foot"><span class="bs-tar-note">Сохраняется само · хранится только в этом браузере</span><span class="bs-tar-st"></span></div></div>';
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
      const tar = [...lists.tar.children].filter(check).map(r => ({ k: val(r, 'k'), u: val(r, 'u'), p: val(r, 'p').replace(/\s/g, ''), n: val(r, 'n') }));
      const sn = [...lists.snip.children].filter(check).map(r => ({ k: val(r, 'k'), v: val(r, 'v') }));
      jset(TAR_KEY, tar); jset(SNIP_KEY, sn);
      const bad = wrap.querySelectorAll('.bs-bad').length;
      st.className = 'bs-tar-st' + (bad ? ' bs-warn' : '');
      st.textContent = bad ? 'Не сохранено строк: ' + bad + ' – заполни сокращение и ссылку' : '✓ Сохранено';
    };
    jget(TAR_KEY, []).forEach(t => row('tar', t));
    jget(SNIP_KEY, []).forEach(t => row('snip', t));
    if (!lists.tar.children.length) row('tar');
    if (!lists.snip.children.length) row('snip');
    requestAnimationFrame(() => wrap.querySelectorAll('textarea').forEach(grow));
    wrap.addEventListener('input', ev => {
      if (ev.target.matches('textarea')) grow(ev.target);
      const r = ev.target.closest('.bs-tr');
      if (r && r.classList.contains('bs-bad')) check(r);
      clearTimeout(tm); tm = setTimeout(save, 400);
    });
    wrap.addEventListener('click', ev => {
      const t = ev.target, tab = t.dataset.tab, add = t.dataset.add;
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
  const repHas = r => ['bought', 'sum', 'links', 'leads'].some(k => +r[k]);
  // в архив – только то, что нужно для статистики, без лишних полей
  const histSale = x => ({ dlg: x.dlg, name: x.name, price: x.price, disc: x.disc, mops: x.mops, share: x.share, cnt: x.cnt, fio: x.fio, who: x.who });
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
      const ok = histPush({ d, end: Date.now(), rep: rOld && r.d === d ? histRep(r) : {}, sales: sOld && sl.d === d ? sl.list.map(histSale) : [] });
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
  const salePart = s => s ? Math.round(saleTotal(s) * saleShare(s)) : 0;
  function closeSale() { const o = document.getElementById('bsSaleWrap'); if (o) o.remove(); }
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
    // по этому чату сегодня уже есть продажа – подсказываем, чтобы не посчитать дважды (доплата/бронь – это нормально, тогда просто заполняем дальше)
    const twins = old ? [] : list.filter(s => s.dlg === dlg);
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const field = (k, label, ph, tag) => '<label><span>' + label + '</span>' + (tag === 'ta' ? '<textarea data-k="' + k + '" rows="2" placeholder="' + (ph || '') + '"></textarea>' : '<input data-k="' + k + '" placeholder="' + (ph || '') + '"' + (k === 'price' ? ' type="number" min="0"' : '') + '>') + '</label>';
    wrap.innerHTML =
      '<div id="bsSale"><div class="bs-rep-head"><b>' + (old ? 'Продажа' : 'Новая продажа') + (x.who ? ' – ' + esc(x.who) : '') + '</b><i title="Закрыть">×</i></div>' +
      twins.map(s => '<div class="bs-sale-dup">По этому чату сегодня уже есть продажа: <b>' + esc(s.name || 'без тарифа') + ' · ' + rub(saleTotal(s)) + ' ₽</b>. Если это та же оплата – открой её, чтобы не посчитать дважды. Доплату или бронь заполняй здесь.<button data-a="twin" data-id="' + s.id + '">Открыть</button></div>').join('') +
      '<div class="bs-sale-cols"><div class="bs-sale-form">' +
      '<label><span>Тариф</span><select data-k="tar"><option value="">– выбери –</option>' + tars.map((t, i) => '<option value="' + i + '">' + esc(t.k) + (t.p ? ' · ' + rub(t.p) : '') + '</option>').join('') + '<option value="own">другой (впишу сам)</option></select></label>' +
      field('name', 'Название в отчёте', 'Годовой курс ЕГЭ | …') + field('price', 'Цена, ₽', '0') + field('disc', 'Скидка', '0 – в рублях или 10%') +
      '<label><span>МОП</span><div class="bs-chips" data-g="mops">' + MANAGERS.map(m => '<em data-v="' + m[1] + '">' + m[1] + '</em>').join('') + '</div></label>' +
      '<label class="bs-sale-share"><span>Доля продажи</span><div class="bs-chips" data-g="share">' + SHARES.map(([v, t]) => '<em data-v="' + v + '">' + t + '</em>').join('') + '</div></label>' +
      field('email', 'Почта', 'когда пришлёт') + field('fio', 'Имя и фамилия', 'когда пришлёт') + field('nick', 'Ник', '@…') +
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
      if (!mine) return void (note.textContent = 'Продажа не на тебя (' + meName() + ') – будет в списке продаж, чтобы дописать данные, но в «Продано» и сумму не пойдёт.');
      const part = Math.round(saleTotal(x) * x.share);
      note.textContent = (meSet() ? '' : 'Не выбрано, кто ты («Продажи за смену» → «Я: …») – считаю продажу твоей. ') + 'В отчёт смены: продано +' + String(x.share).replace('.', ',') + ', сумма +' + rub(part) + ' ₽' + (saleDone(x) ? '' : ' · почту и имя можно дописать потом');
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
      x.cnt = saleMine(x);
      const dShare = r2(saleShare(x) - saleShare(was));
      if (dShare) soldAdd(dShare);
      sumAdd(salePart(x) - salePart(was));
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
          x.share = shareFor(x.mops.length);   // доля – от числа МОП, потом можно поправить вручную
        } else x.share = +v;
        paint();
      } else if (a === 'back') openSales();
      else if (a === 'twin') openSale(ev.target.dataset.id, fromList);
      else if (a === 'save') { if (!x.name) return inp('tar').focus(); save(); fromList ? openSales() : closeSale(); tarHint('✓ Продажа сохранена', true); }
      else if (a === 'copy') {
        if (!x.name) return inp('tar').focus();
        save();
        navigator.clipboard.writeText(prev.value).then(() => { closeSale(); tarHint(x.cnt ? '✓ Продажа сохранена, текст скопирован' : '✓ Сохранено без учёта в сумме, текст скопирован', true); });
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
  // ---------- Окно «Продажи»: вкладки «Смена» (сегодня) и «История» (архив смен) ----------
  const dmyDate = d => { const [a, b, c] = String(d).split('.'); return new Date(+c, b - 1, +a); };
  const isoOf = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const fromIso = s => { const [y, m, d] = String(s).split('-'); return y && m && d ? new Date(+y, m - 1, +d) : null; };
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const r2s = n => String(Math.round((+n || 0) * 100) / 100).replace('.', ',');
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
    if (repHas(cur) || curSales.length) all.push({ d: ddmm(new Date()), now: true, end: Date.now(), rep: histRep(cur), sales: curSales });
    return all.sort((a, b) => dmyDate(b.d) - dmyDate(a.d) || b.end - a.end);
  }
  function histSave(h) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(h)); return true; } catch (e) { alert('Не хватило места в браузере – скачай резервную копию и удали старые смены.'); return false; }
  }
  // продажи за прошлую дату – в смену этой даты в архиве (если её нет – создаём)
  function histAddDay(d, xs) {
    const h = histGet();
    let e = h.filter(x => x.d === d).pop();
    if (!e) { e = { d, end: dmyDate(d).getTime() + 86399000, rep: {}, sales: [] }; h.push(e); }
    xs.forEach(x => {
      e.sales.push(histSale(x));
      e.rep.bought = Math.round(((+e.rep.bought || 0) + saleShare(x)) * 100) / 100;
      e.rep.sum = (+e.rep.sum || 0) + salePart(x);
    });
    return histSave(h);
  }
  const statsHtml = a => '<div class="bs-stats">' + a.map(([k, v]) => '<div><span>' + k + '</span><b>' + v + '</b></div>').join('') + '</div>';
  function openSales(tab) {
    closeSale();
    tab = tab === 'hist' ? 'hist' : 'shift';
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    wrap.innerHTML = '<div id="bsSale" class="bs-sales"><div class="bs-rep-head"><b>Продажи</b>' +
      '<span class="bs-seg"><em data-tab="shift"' + (tab === 'shift' ? ' class="on"' : '') + '>Смена</em><em data-tab="hist"' + (tab === 'hist' ? ' class="on"' : '') + '>История</em></span>' +
      '<i title="Закрыть">×</i></div><div class="bs-tab"></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('.bs-tab');
    (tab === 'hist' ? paintHist : paintShift)(box);
    wrap.addEventListener('click', ev => {
      const t = ev.target;
      if (t.matches('.bs-rep-head i')) return closeSale();
      if (t.dataset.tab && t.dataset.tab !== tab) return openSales(t.dataset.tab);
    });
    wrap.addEventListener('mousedown', ev => { if (ev.target === wrap) closeSale(); });
  }
  function paintShift(box) {
    const list = salesGet(), r = repSaved(), now = new Date();
    box.innerHTML =
      statsHtml([['Сегодня', ddmm(now).slice(0, 5) + ', ' + WD[now.getDay()]], ['Продано', r2s(r.bought)], ['Сумма', rub(+r.sum || 0) + ' ₽'], ['Ссылки', +r.links || 0]]) +
      (list.length ? '<div class="bs-sales-list">' + list.map(x =>
        '<div class="bs-sales-row" data-id="' + x.id + '"><b>' + esc(x.who || x.fio || 'чат ' + x.dlg) + (x.mops || []).map(m => '<s class="bs-mop" data-m="' + esc(m) + '">' + esc(m) + '</s>').join('') + '</b><span>' + esc(x.name) + '</span>' +
        '<em>' + rub(saleTotal(x)) + ' ₽ · ' + (x.cnt === false ? '0' : r2s(x.share)) + '</em>' + (saleDone(x) ? '' : '<u>не заполнено</u>') +
        '<i class="bs-sales-del" title="Удалить продажу">×</i></div>').join('') + '</div>'
        : '<div class="bs-empty">Продаж пока нет.<br>Открой чат клиента и нажми «+ Продажа» или вставь отчёты из Telegram.</div>') +
      '<div class="bs-foot"><button data-a="me" class="bs-ghost" title="Кто ты – на тебя считаются продажи и отчёт">👤 ' + (meSet() ? esc(meName()) : 'Кто я?') + '</button><span></span>' +
      '<button data-a="imp" title="Вставить тексты продаж из Telegram – свои доли попадут в отчёт">Импорт из ТГ</button>' +
      '<button data-a="shift" class="bs-main" title="Смена уйдёт в «Историю», а «Продано», сумма, ссылки и список обнулятся">Закрыть смену</button></div>';
    box.onclick = ev => {
      const t = ev.target, a = t.dataset.a;
      if (a === 'me') return askMe();
      if (a === 'imp') return openImport();
      if (a === 'shift') {
        if (!confirm('Закрыть смену? Она сохранится в «Истории», а «Продано», сумма, «Ссылки» и список продаж обнулятся.')) return;
        newShift(); openSales('hist'); return tarHint('✓ Смена закрыта и сохранена в истории', true);
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
    h.splice(i, 1);
  }
  // дата из поля ввода – только целиком набранная (пока год печатается, там 0002, 0020…)
  const dateOk = s => { const d = fromIso(s); return d && d.getFullYear() >= 2000 && d <= new Date() ? d : null; };
  function paintHist(box) {
    const today = isoOf(new Date());
    // шапка с периодом рисуется один раз – иначе поле даты теряет ввод посреди набора года
    box.innerHTML =
      '<div class="bs-hist-per"><span class="bs-seg">' + [['7', '7 дней'], ['30', '30 дней'], ['month', 'Месяц'], ['all', 'Всё']]
        .map(([v, t]) => '<em data-p="' + v + '">' + t + '</em>').join('') + '</span>' +
      '<span class="bs-range"><input type="date" data-r="from" max="' + today + '"><span>–</span><input type="date" data-r="to" max="' + today + '"></span></div>' +
      '<div class="bs-hist-body"></div>' +
      '<div class="bs-foot"><button data-a="bak" class="bs-ghost" title="Сохранить все данные помощника в файл или загрузить из файла">💾 Резервная копия</button><span></span>' +
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
      const list = histAll().filter(e => { const d = dmyDate(e.d); return (!from || d >= from) && (!to || d <= to); });
      const tot = k => list.reduce((a, e) => a + (+e.rep[k] || 0), 0);
      const bought = Math.round(tot('bought') * 100) / 100, sum = tot('sum');
      const open = new Set([...body.querySelectorAll('.bs-hist-row.open')].map(r => r.dataset.k));
      if (histKeep) { open.add(histKeep); histKeep = null; }
      body.innerHTML =
        statsHtml([['Смен', list.length], ['Продано', r2s(bought)], ['Сумма', rub(sum) + ' ₽'], ['Ср. чек', bought ? rub(Math.round(sum / bought)) + ' ₽' : '–'], ['Ссылки', tot('links')]]) +
        (list.length ? '<div class="bs-hist-list">' + list.map(e => {
          const k = e.now ? 'now' : e.hi + ':' + e.end;
          return '<div class="bs-hist-row' + (open.has(k) ? ' open' : '') + '" data-k="' + k + '"><b>' + e.d.slice(0, 5) + '<span>' + WD[dmyDate(e.d).getDay()] + (e.now ? ' · сейчас' : '') + '</span></b>' +
            '<em><span>' + r2s(e.rep.bought) + ' прод.</span><span>' + rub(+e.rep.sum || 0) + ' ₽</span><span>' + (+e.rep.links || 0) + ' ссыл.</span></em>' +
            (e.now ? '<s></s>' : '<i class="bs-hist-del" title="Удалить смену из истории">×</i>') +
            '<div class="bs-hist-sales">' + (e.sales.length ? e.sales.map((x, si) =>
              '<div class="bs-hist-s' + (x.cnt === false ? ' bs-hist-other' : '') + '" ' + (e.now ? 'data-id="' + x.id + '"' : 'data-si="' + si + '"') + ' title="Открыть и поправить"><span>' + esc(x.who || x.fio || 'чат ' + x.dlg) + ' – ' + esc(x.name) + '</span><span>' + rub(saleTotal(x)) + ' ₽ · ' + (x.cnt === false ? 'не моя' : r2s(x.share)) + '</span>' +
              (e.now ? '' : '<i class="bs-hist-sdel" data-si="' + si + '" title="Удалить продажу из этой смены">×</i>') + '</div>').join('') : '<div><span>Список продаж не вёлся</span></div>') +
            (e.now ? '' : '<p class="bs-hist-move"><span>Дата смены</span><input type="date" value="' + isoOf(dmyDate(e.d)) + '" max="' + today + '"><button data-a="move">Перенести</button></p>') +
            '</div></div>';
        }).join('') + '</div>' : '<div class="bs-empty">За этот период смен нет.<br>Закрытые смены попадают сюда сами, а прошлые дни можно добавить кнопкой «+ Продажи за дату».</div>');
    };
    const repaint = () => { paintPer(); paintBody(); };
    repaint();
    const find = row => { const [hi, end] = row.dataset.k.split(':'), h = histGet(); return h[+hi] && String(h[+hi].end) === end ? { h, i: +hi } : null; };
    box.onclick = ev => {
      const t = ev.target, a = t.dataset.a;
      if (a === 'bak') return openBackup();
      if (a === 'add') return openImport(isoOf(new Date(Date.now() - 864e5)));
      if (t.dataset.p) { histPer.p = t.dataset.p; return repaint(); }
      const row = t.closest('.bs-hist-row');
      if (!row) return;
      if (a === 'move' || t.matches('.bs-hist-del,.bs-hist-sdel')) {
        const f = find(row);
        if (!f) return paintBody();
        const e = f.h[f.i];
        if (a === 'move') {
          const d = dateOk(row.querySelector('.bs-hist-move input').value);
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
      const sd = t.closest('.bs-hist-s');
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
    histKeep = hi + ':' + end;
    closeSale();
    const old = e.sales[si], x = Object.assign({}, old, { mops: (old.mops || []).slice() });
    const wrap = document.createElement('div');
    wrap.id = 'bsSaleWrap';
    const field = (k, t, ph) => '<label><span>' + t + '</span><input data-k="' + k + '" placeholder="' + (ph || '') + '"></label>';
    wrap.innerHTML = '<div id="bsSale" class="bs-hedit"><div class="bs-rep-head"><b>Продажа за ' + e.d + '</b><i title="Закрыть">×</i></div>' +
      '<div class="bs-sale-form">' + field('fio', 'Имя и фамилия') + field('name', 'Тариф') +
      '<div class="bs-hedit-2">' + field('price', 'Цена, ₽') + field('disc', 'Скидка', '₽ или 10%') + '</div>' +
      '<label><span>Менеджеры</span><div class="bs-chips" data-g="mops">' + MANAGERS.map(m => '<em data-v="' + m[1] + '">' + m[1] + '</em>').join('') + '</div></label>' +
      '<label class="bs-sale-share"><span>Доля продажи</span><div class="bs-chips" data-g="share">' + SHARES.map(([v, t]) => '<em data-v="' + v + '">' + t + '</em>').join('') + '</div></label>' +
      '<div class="bs-sale-note"></div>' +
      (x.dlg ? '<a class="bs-hedit-chat" href="/app/messenger/?dialogId=' + encodeURIComponent(x.dlg) + '" target="_blank">Открыть чат ↗</a>' : '') + '</div>' +
      '<div class="bs-rep-btns"><button data-a="del" class="bs-sale-del">Удалить</button><span class="bs-tar-st"></span><button data-a="back">Назад</button><button data-a="save" class="bs-main">Сохранить</button></div></div>';
    document.body.appendChild(wrap);
    const box = wrap.querySelector('#bsSale'), note = box.querySelector('.bs-sale-note');
    ['fio', 'name', 'price', 'disc'].forEach(k => { box.querySelector('[data-k="' + k + '"]').value = x[k] == null ? '' : x[k]; });
    const paint = () => {
      // «моя» – если я среди менеджеров (как при импорте)
      x.cnt = !meSet() || x.mops.includes(meName());
      box.querySelectorAll('[data-g="mops"] em').forEach(m => m.classList.toggle('bs-on', x.mops.includes(m.dataset.v)));
      box.querySelectorAll('[data-g="share"] em').forEach(m => m.classList.toggle('bs-on', +m.dataset.v === +x.share));
      box.querySelector('.bs-sale-share').hidden = !x.cnt;
      const dB = Math.round((saleShare(x) - saleShare(old)) * 100) / 100, dS = salePart(x) - salePart(old);
      note.textContent = (x.cnt ? 'Твоя: ' + rub(saleTotal(x)) + ' ₽ × ' + r2s(x.share) + ' = ' + rub(salePart(x)) + ' ₽' : 'Не твоя – в «Продано» и сумму не идёт') +
        (dB || dS ? ' · смена: продано ' + (dB >= 0 ? '+' : '') + r2s(dB) + ', сумма ' + (dS >= 0 ? '+' : '−') + rub(Math.abs(dS)) + ' ₽' : '');
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
        } else x.share = +v;
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
    res.forEach((x, i) => { if (!x.bad && res.slice(i + 1).some(y => y.dlg === x.dlg && y.price === x.price)) x.bad = 'повтор ниже'; });
    return res;
  }
  // day – 'ГГГГ-ММ-ДД': продажи за прошлый день уходят в «Историю», за сегодня – в текущую смену
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
    const dayInp = box.querySelector('.bs-imp-day input');
    const target = () => { const d = fromIso(dayInp.value); return d && ddmm(d) !== ddmm(new Date()) ? ddmm(d) : ''; };
    const paint = () => {
      const td = target(), me = meName();
      box.querySelector('.bs-imp-day u').textContent = td ? 'прошлый день – продажи уйдут в «Историю»' : 'сегодня – в текущую смену';
      const have = td ? histGet().filter(e => e.d === td).flatMap(e => e.sales) : salesGet();
      found = parseSales(ta.value).map(x => Object.assign(x, {
        mine: !x.bad && x.mops.includes(me),
        dup: have.some(s => s.dlg === x.dlg && (norm(s.name) === norm(x.name) || String(s.price) === x.price)),
      }));
      const ok = found.filter(x => !x.bad && !x.dup), my = ok.filter(x => x.mine);
      out.innerHTML = found.length ? found.map(x =>
        '<div class="bs-imp-row' + (!x.bad && !x.dup ? '' : ' bs-off') + '"><b>' + esc(x.fio || 'чат ' + x.dlg) + x.mops.map(m => '<s class="bs-mop" data-m="' + esc(m) + '">' + esc(m) + '</s>').join('') + '</b>' +
        '<em>' + (x.price ? rub(saleTotal(x)) + ' ₽' : '?') + ' · ' + (x.mine ? String(shareFor(x.mops.length)).replace('.', ',') : '0') + '</em><span>' + esc(x.name) + '</span>' +
        '<u>' + (x.bad ? x.bad + ' – пропущу' : x.dup ? 'уже в списке' : x.mine ? '' : 'не твоя – без учёта в сумме') + '</u></div>').join('')
        : (ta.value.trim() ? '<div class="bs-tar-help">Продаж не нашёл – в тексте должна быть ссылка на чат BlueSales.</div>' : '');
      btn.disabled = !ok.length;
      btn.textContent = ok.length ? 'Добавить ' + ok.length + ' · твоих ' + my.length + ' · +' + rub(my.reduce((a, x) => a + saleTotal(x) * shareFor(x.mops.length), 0)) + ' ₽' : 'Добавить';
    };
    ta.addEventListener('input', paint);
    dayInp.addEventListener('change', paint);
    paint();
    box.addEventListener('click', ev => {
      const a = ev.target.dataset.a;
      if (ev.target.matches('.bs-rep-head i')) return closeSale();
      if (a === 'back') return openSales(target() ? 'hist' : 'shift');
      if (a !== 'add') return;
      const td = target();
      if (td) {
        const xs = found.filter(x => !x.bad && !x.dup).map(f => ({ dlg: f.dlg, name: f.name, price: f.price, disc: f.disc, mops: f.mops, share: shareFor(f.mops.length), fio: f.fio, who: f.fio, cnt: f.mine }));
        if (!histAddDay(td, xs)) return;
        openSales('hist');
        return tarHint('✓ В историю за ' + td + ' добавлено продаж: ' + xs.length, true);
      }
      const all = salesGet();
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
      tarHint('✓ Добавлено продаж: ' + n, true);
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
      '#bsSale.bs-sales{width:600px}' +
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
      '.bs-empty{padding:26px 10px;text-align:center;font-size:12.5px;line-height:1.6;color:var(--bs-muted,#888)}' +
      '.bs-foot{display:flex;align-items:center;gap:8px;margin-top:12px}.bs-foot>span{flex:1}' +
      '.bs-foot button{padding:6px 12px;border:1px solid var(--bs-border,#D9E0E7);border-radius:8px;background:none;color:var(--bs-text,#222);font-size:12.5px;cursor:pointer;white-space:nowrap}.bs-foot button:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}' +
      '.bs-foot button.bs-main{background:var(--bs-accent,#3b82f6);border-color:var(--bs-accent,#3b82f6);color:#fff}.bs-foot button.bs-main:hover{color:#fff;filter:brightness(1.1)}' +
      '.bs-foot button.bs-ghost{border-color:transparent;color:var(--bs-muted,#888);padding:6px 8px}.bs-foot button.bs-ghost:hover{border-color:transparent;color:var(--bs-text,#222);background:var(--bs-hover,rgba(0,0,0,.06))}' +
      '.bs-hist-list{display:flex;flex-direction:column;gap:6px}' +
      '.bs-hist-row{display:grid;grid-template-columns:1fr auto 22px;align-items:center;gap:4px 10px;padding:8px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:9px;cursor:pointer}.bs-hist-row:hover{border-color:var(--bs-accent,#3b82f6)}' +
      '.bs-hist-row>b span{margin-left:6px;font-weight:400;color:var(--bs-muted,#888)}' +
      '.bs-hist-row em{display:grid;grid-template-columns:72px 104px 64px;font-style:normal;text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}' +
      '.bs-hist-row em span:first-child,.bs-hist-row em span:last-child{color:var(--bs-muted,#888)}' +
      '.bs-hist-sales{display:none;grid-column:1/-1;flex-direction:column;gap:3px;margin-top:4px;padding-top:6px;border-top:1px solid var(--bs-border,#D9E0E7);font-size:12px;cursor:default}.bs-hist-row.open .bs-hist-sales{display:flex}' +
      '.bs-hist-sales div{display:flex;align-items:center;gap:10px}.bs-hist-sales div span:first-child{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bs-hist-sales div span+span{flex:none;font-variant-numeric:tabular-nums}' +
      '.bs-hist-other{color:var(--bs-muted,#888)}' +
      '.bs-hist-del,.bs-hist-sdel{font-style:normal;text-align:center;color:var(--bs-muted,#888);border-radius:6px;cursor:pointer;opacity:0}.bs-hist-sdel{width:18px}' +
      '.bs-hist-row:hover>.bs-hist-del,.bs-hist-sales div:hover .bs-hist-sdel{opacity:1}.bs-hist-del:hover,.bs-hist-sdel:hover{color:#e04848;background:rgba(224,72,72,.12)}' +
      '#bsSale.bs-hedit{width:440px}.bs-hedit-2{display:grid;grid-template-columns:1fr 1fr;gap:8px}.bs-hedit-chat{align-self:flex-start;font-size:12px;color:var(--bs-accent,#3b82f6);text-decoration:none}' +
      '.bs-hist-s{cursor:pointer;margin:0 -6px;padding:2px 6px;border-radius:6px}.bs-hist-s:hover{background:var(--bs-hover,rgba(0,0,0,.06))}' +
      '.bs-hist-move{display:flex;align-items:center;gap:8px;margin:6px 0 0;padding-top:6px;border-top:1px dashed var(--bs-border,#D9E0E7);color:var(--bs-muted,#888)}.bs-hist-move span{flex:1}' +
      '#bsSale .bs-hist-move input{padding:3px 6px;font-size:12px}.bs-hist-move button{padding:3px 10px;border:1px solid var(--bs-border,#D9E0E7);border-radius:7px;background:none;color:var(--bs-text,#222);font-size:12px;cursor:pointer;white-space:nowrap}.bs-hist-move button:hover{border-color:var(--bs-accent,#3b82f6);color:var(--bs-accent,#3b82f6)}' +
      '#bsSale label.bs-imp-day{flex-direction:row;align-items:center;gap:8px;margin-bottom:8px;font-size:12.5px;color:var(--bs-text,#222)}.bs-imp-day u{text-decoration:none;color:var(--bs-muted,#888)}' +
      '.bs-backup{width:440px}.bs-backup .bs-tar-help{margin-bottom:6px}' +
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
      '.bs-imp-row span{font-size:12px;color:var(--bs-muted,#888)}.bs-imp-row em{font-style:normal;font-weight:600;text-align:right}.bs-imp-row u{text-decoration:none;font-size:11px;color:#e08a1e;text-align:right}' +
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
      '#remindersContentInner .bs-rem-cur>:only-child{border-radius:6px!important}';
    document.head.appendChild(st);
  });
})();
