// Помощник BlueSales → своя таблица продаж (Google Таблицы).
// Ставится один раз: таблица → Расширения → Apps Script → вставить этот файл → Развернуть → Новое развёртывание →
// тип «Веб-приложение», «Выполнять от имени: меня», «Доступ: все» → скопировать ссылку …/exec в помощник
// («Смена» → «История» → «📊 Таблица»). Ссылку никому не показывай: по ней можно дописать строки в таблицу.
//
// Что делает: дописывает продажи в лист продаж – только столбцы, которые заполняются руками
// (A продукт, B 1 предмет/комбо, E ссылка на чат, F месяц/год, G сумма оплаты, I почта, K число менеджеров, O дата).
// Формулы (C, D, H, J, L, N) не трогает. День в таблице – это строки от даты в O до следующей даты,
// поэтому продажа за день, который уже есть, встаёт в конец этого дня, а новый день – по порядку дат.
// Одну и ту же продажу (тот же чат и сумма на этом листе, в том числе внесённую руками) второй раз не добавляет.
// Для «Истории» отдаёт строки оплат за месяцы периода и премию: N у первой строки дня (где дата в O) – за день, N1 – за месяц,
// а ещё ставки и цены тарифов из справочника листа (P3:R8, T1:T4) – по ним помощник сам считает премию каждой продажи.
//
// Таблица отдела (общая, если подключена в помощнике): читает и пишет только свой блок (имя в A, подписи строк в B) и только
// в столбцах дат («дд.мм» в строке 1) – лиды, чаты, ссылки, продано, сумма. Формулы и чужие блоки не трогает.
// Поэтому скрипту нужен доступ к таблицам, но работает он только с одной таблицей отдела: её id запоминается
// при первом подключении, другие отклоняются. Сменить: Apps Script → Настройки проекта → Свойства скрипта → удалить TEAM.

const COL = { name: 1, kind: 2, link: 5, pay: 6, sum: 7, email: 9, mops: 11, date: 15 };
const WIDTH = 15;   // A…O – строки продаж; правее (справочник продуктов) не трогаем
const PREM = 14;    // N – премия: N1 за месяц, в строке с датой – за день (формулы, только читаем)
const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.ping) return out({ ok: true, sheets: salesSheets(ss).map(sh => sh.getName()) });
    if (body.team) return out(Object.assign({ ok: true }, teamRead(body.team)));
    if (body.teamPut) return out({ ok: true, res: teamPut(body.teamPut) });
    // сверка: какие продажи уже есть в таблице (ничего не пишет)
    // лист месяца читаем один раз на весь запрос; used – строки, уже узнанные как продажа из этого запроса
    // (две оплаты в одном чате на одну сумму – это две строки)
    const memo = { used: new Set() };
    if (body.rows) return out(Object.assign({ ok: true }, sheetRows(ss, body.rows, memo)));
    // fix – то же, что сверка, но у найденных продаж с fix:1 пишем сумму, почту и число менеджеров из помощника
    const list = body.find || body.fix;
    if (list) return out({ ok: true, res: list.map(s => {
      try {
        const r = findSale(ss, s, null, memo) || { st: 'miss' };
        if (body.fix && s.fix && r.st === 'dup') {
          const sh = memo[dayKey(s.d)].sh, v = { sum: +s.sum || 0, email: String(s.email || '').trim(), mops: +s.mops || 1 };
          Object.keys(v).forEach(k => sh.getRange(r.row, COL[k]).setValue(v[k]));
          return Object.assign({ st: 'fix', row: r.row, sheet: r.sheet }, v);
        }
        return r;
      }
      catch (err) { return { st: err.noSheet ? 'nosheet' : 'err', msg: String(err && err.message || err) }; }
    }) });
    const res = (body.sales || []).map(s => {
      try { return addSale(ss, s); } catch (err) { return { st: 'err', msg: String(err && err.message || err) }; }
    });
    return out({ ok: true, res });
  } catch (err) {
    return out({ ok: false, msg: String(err && err.message || err) });
  } finally {
    lock.releaseLock();
  }
}
function doGet() { return out({ ok: true, hello: 'BlueSales → таблица' }); }
const out = o => ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);

// листы продаж – с шапкой «Продукт» в A1 и «Дата» в O1
function salesSheets(ss) {
  return ss.getSheets().filter(sh => {
    const h = sh.getRange(1, 1, 1, WIDTH).getDisplayValues()[0];
    return /продукт/i.test(h[0]) && /дата/i.test(h[COL.date - 1]);
  });
}

// дата из ячейки: Date, «13.10», «13.10.2026»; год по умолчанию – год продажи
function dayOf(v, year) {
  if (v instanceof Date) return { d: v.getDate(), m: v.getMonth() + 1, y: v.getFullYear() };
  const m = /^\s*(\d{1,2})\.(\d{1,2})(?:\.(\d{2,4}))?\s*$/.exec(String(v || ''));
  if (!m) return null;
  return { d: +m[1], m: +m[2], y: m[3] ? (m[3].length === 2 ? 2000 + +m[3] : +m[3]) : year };
}
const ord = x => x.y * 10000 + x.m * 100 + x.d;

function pickSheet(ss, day) {
  const list = salesSheets(ss);
  if (!list.length) throw new Error('Нет листа с шапкой «Продукт» в A1 и «Дата» в O1');
  // старые месяцы лежат тут же скрытыми листами – поэтому сначала смотрим на даты, а не только на название
  const dates = list.map(sh => {
    const n = sh.getLastRow();
    return n < 2 ? [] : sh.getRange(2, COL.date, n - 1, 1).getValues().map(r => dayOf(r[0], day.y)).filter(Boolean);
  });
  const named = sh => monthOfName(sh.getName()) === day.m - 1;
  const same = list.filter((sh, i) => dates[i].some(x => x.y === day.y && x.m === day.m));
  const sameNamed = same.filter(named);
  if (sameNamed.length === 1) return sameNamed[0];
  if (same.length === 1) return same[0];
  if (same.length > 1) throw new Error('Не понял, на какой лист писать ' + day.d + '.' + day.m + ' – назови лист по месяцу («Октябрь»)');
  // этот месяц ещё не начат: новый чистый лист с его названием (прошлогодний «Октябрь» с датами не подходит)
  const emptyNamed = list.filter((sh, i) => !dates[i].length && named(sh));
  if (emptyNamed.length === 1) return emptyNamed[0];
  // запасной – чистый лист без месяца в названии, и только для месяца не раньше тех, что уже есть в таблице
  const ym = x => x.y * 100 + x.m, newest = Math.max(0, ...[].concat(...dates).map(ym));
  const free = list.filter((sh, i) => !dates[i].length && monthOfName(sh.getName()) < 0);
  if (free.length === 1 && ym(day) >= newest) return free[0];
  // листа за этот месяц нет (старый удалили) – в чужой месяц не пишем
  const err = new Error('В таблице нет листа за ' + MONTH_NAMES[day.m - 1] + (free.length ? ' – назови лист по месяцу («Октябрь»)' : ''));
  err.noSheet = true;
  throw err;
}
// номер месяца (0…11) в названии листа или -1
function monthOfName(name) {
  name = String(name).toLowerCase();
  return MONTHS.findIndex(m => name.indexOf(m) >= 0 && (m !== 'ма' || /ма[йя]/.test(name)));
}

// куда ставить продажу: A – продукты по строкам, O – даты (ord или null), строки с 1; data[0] – шапка
function plan(A, O, key) {
  const n = A.length;
  let last = 1;
  for (let r = 2; r <= n; r++) if (String(A[r - 1]).trim()) last = r;
  const dates = [];
  for (let r = 2; r <= n; r++) if (O[r - 1] != null) dates.push({ r, o: O[r - 1] });
  const start = dates.find(x => x.o === key);
  if (start) {
    const next = dates.find(x => x.r > start.r);
    const end = next ? next.r - 1 : Math.max(last, start.r);
    for (let r = start.r; r <= end; r++) if (!String(A[r - 1] || '').trim()) return { row: r };
    const t = end + 1;
    return next || t <= last ? { row: t, insert: true } : { row: t };
  }
  const later = dates.find(x => x.o > key);
  if (later) return { row: later.r, insert: true, date: true };
  const lastDate = dates.length ? dates[dates.length - 1].r : 1;
  return { row: Math.max(last, lastDate) + 1, date: true };
}

// уже есть: тот же чат и сумма на листе этого месяца (продукт руками могли записать по-своему);
// тот же человек с другой суммой или в прошлом месяце – в also, для предупреждения
function findSale(ss, s, got, memo) {
  const p = dayOf(s.d);
  if (!p) throw new Error('Нет даты продажи');
  const c = monthSheet(ss, p, memo), { sh, n, vals, forms } = c;
  if (got) Object.assign(got, { p, sh, n, vals });
  const re = s.dlg ? new RegExp('dialogId=' + s.dlg + '(?!\\d)') : null;
  const mail = String(s.email || '').trim().toLowerCase(), also = [];
  // тот же человек (чат или почта): на листе месяца с той же суммой – повтор, иначе пусть перепроверят
  // was – сумма, с которой продажа записана в таблицу (в помощнике её потом поправили): сначала ищем строку по ней
  const used = memo && memo.used, was = s.was != null && s.was !== '' ? +s.was : null;
  const scan = (vals, forms, n, name) => {
    let day = '', hitWas = 0, hitSum = 0;   // дата пишется только у первой продажи дня
    for (let r = 2; r <= n; r++) {
      const v = vals[r - 1], link = String(v[COL.link - 1]) + forms[r - 1][0];
      if (v[COL.date - 1] !== '') day = dmOf(v[COL.date - 1]);
      const byDlg = re && re.test(link), sum = +v[COL.sum - 1];
      // force – помощник уже сверил и знает, что это отдельная оплата
      if (!name && byDlg && !s.force && !(used && used.has(sh.getName() + ':' + r))) {
        if (!hitWas && was !== null && sum === was) hitWas = r;
        if (!hitSum && sum === +s.sum) hitSum = r;
      }
      if (byDlg || mail && String(v[COL.email - 1]).trim().toLowerCase() === mail)
        also.push(name ? { row: r, sum, d: day, sheet: name } : { row: r, sum, d: day });
    }
    const r = hitWas || hitSum;
    if (!r) return null;
    if (used) used.add(sh.getName() + ':' + r);
    // что в этой строке сейчас – помощник сравнит со своей продажей
    const v = vals[r - 1];
    return { st: 'dup', row: r, sheet: sh.getName(), sum: +v[COL.sum - 1] || 0, email: String(v[COL.email - 1]).trim(), mops: +v[COL.mops - 1] || 0 };
  };
  const dup = scan(vals, forms, n);
  if (dup) return dup;
  // прошлый месяц (лист может быть скрыт): там только предупреждаем
  let prev = null;
  try { prev = monthSheet(ss, p.m > 1 ? { y: p.y, m: p.m - 1, d: 1 } : { y: p.y - 1, m: 12, d: 1 }, memo); } catch (e) {}
  if (prev && prev.sh.getName() !== sh.getName()) scan(prev.vals, prev.forms, prev.n, prev.sh.getName());
  if (got) got.also = also;
  return also.length ? { st: 'miss', also } : null;
}

// строки оплат и премия за месяцы с from по to («дд.мм.гггг»), ничего не пишет: помощник сам сверит их с «Историей».
// Листа за месяц нет – в months у него err
function sheetRows(ss, q, memo) {
  const a = dayOf(q.from), b = dayOf(q.to);
  if (!a || !b) throw new Error('Нет периода');
  const z = x => ('0' + x).slice(-2), dmy = p => z(p.d) + '.' + z(p.m) + '.' + p.y;
  const months = [], rows = [], days = {};
  for (let y = a.y, m = a.m; y * 100 + m <= b.y * 100 + b.m;) {
    let c = null;
    try { c = monthSheet(ss, { y, m, d: 1 }, memo); } catch (err) { months.push({ y, m, err: String(err && err.message || err) }); }
    if (c) {
      const { sh, n, vals, forms } = c, name = sh.getName();
      months.push({ y, m, sheet: name, prem: num(vals[0][PREM - 1]), cfg: premCfg(sh) });
      let day = '';   // дата пишется только у первой продажи дня – там и премия за день
      for (let r = 2; r <= n; r++) {
        const v = vals[r - 1];
        if (v[COL.date - 1] !== '') {
          const p = dayOf(v[COL.date - 1], y);
          if (p) { day = dmy(p); const pr = num(v[PREM - 1]); if (pr != null) days[day] = (days[day] || 0) + pr; }
        }
        const prod = String(v[COL.name - 1]).trim(), sum = +v[COL.sum - 1] || 0;
        if (!prod && !sum) continue;
        const dlg = /dialogId=(\d+)/.exec(String(v[COL.link - 1]) + forms[r - 1][0]);
        rows.push({ sheet: name, ym: y * 100 + m, row: r, d: day, name: prod, kind: String(v[COL.kind - 1]).trim(), pay: String(v[COL.pay - 1]).trim(),
          sum, email: String(v[COL.email - 1]).trim(), mops: +v[COL.mops - 1] || 0, dlg: dlg ? dlg[1] : '' });
      }
    }
    if (++m > 12) { m = 1; y++; }
  }
  return { months, rows, days };
}

const num = v => { if (typeof v === 'number') return v; const x = parseFloat(String(v).replace(/[^\d,.-]/g, '').replace(',', '.')); return isNaN(x) ? null : x; };

// справочник для премии (правее продаж, только читаем): T1 – % с оплаты за месяц, T2 – % с оплаты за год,
// T3 – за доплату на тариф (год), T4 – за бронь; P3:R8 – продукт, цена за месяц, цена за курс
function premCfg(sh) {
  const v = sh.getRange('P1:T8').getValues();
  return { t: [0, 1, 2, 3].map(i => num(v[i][4])), p: v.slice(2).map(r => [String(r[0]).trim(), num(r[1]), num(r[2])]) };
}

const dayKey = d => { const p = dayOf(d); return p.y * 100 + p.m; };

// лист месяца и его значения – читаем один раз на запрос
function monthSheet(ss, p, memo) {
  const mk = p.y * 100 + p.m;
  let c = memo && memo[mk];
  if (!c) {
    const sh = pickSheet(ss, p), n = Math.max(sh.getLastRow(), 2);
    c = { sh, n, vals: sh.getRange(1, 1, n, WIDTH).getValues(), forms: sh.getRange(1, COL.link, n, 1).getFormulas() };
    if (memo) memo[mk] = c;
  }
  return c;
}

function dmOf(v) {
  const z = x => ('0' + x).slice(-2);
  return v instanceof Date ? z(v.getDate()) + '.' + z(v.getMonth() + 1) : String(v || '').slice(0, 5);
}

function addSale(ss, s) {
  const got = {}, dup = findSale(ss, s, got);
  if (dup && dup.st === 'dup') return dup;
  const { p, sh, vals } = got, key = ord(p);
  const A = vals.map(v => v[COL.name - 1]);
  const O = vals.map((v, i) => { if (!i) return null; const x = dayOf(v[COL.date - 1], p.y); return x ? ord(x) : null; });
  const pl = plan(A, O, key);
  const row = pl.row;
  if (pl.insert || row > sh.getMaxRows()) {
    if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), row - sh.getMaxRows());
    else sh.getRange(row, 1, 1, WIDTH).insertCells(SpreadsheetApp.Dimension.ROWS);
    // формулы, выпадашки и оформление – из соседней строки с продажей
    const tpl = row > 2 ? row - 1 : row + 1;
    sh.getRange(tpl, 1, 1, WIDTH).copyTo(sh.getRange(row, 1, 1, WIDTH));
    Object.keys(COL).forEach(k => sh.getRange(row, COL[k]).clearContent());
  } else if (row > 2 && !sh.getRange(row, 12).getFormula() && sh.getRange(row - 1, 12).getFormula()) {
    // заготовленные строки с формулами кончились – берём формулы из строки выше
    sh.getRange(row - 1, 1, 1, WIDTH).copyTo(sh.getRange(row, 1, 1, WIDTH));
    Object.keys(COL).forEach(k => sh.getRange(row, COL[k]).clearContent());
  }
  const set = (k, v) => sh.getRange(row, COL[k]).setValue(v);
  set('name', s.name);
  set('kind', s.kind);
  set('link', s.link);
  set('pay', s.pay);
  set('sum', +s.sum || 0);
  set('email', s.email || '');
  set('mops', +s.mops || 1);
  if (pl.date) {
    const c = sh.getRange(row, COL.date);
    const fmt = vals.slice(1).map((v, i) => v[COL.date - 1] instanceof Date ? i + 2 : 0).find(Boolean);
    c.setValue(new Date(p.y, p.m - 1, p.d));
    c.setNumberFormat(fmt ? sh.getRange(fmt, COL.date).getNumberFormat() : 'dd.MM');
  }
  return got.also.length ? { st: 'add', row, sheet: sh.getName(), also: got.also } : { st: 'add', row, sheet: sh.getName() };
}

// ---------- Таблица отдела: свой блок по датам ----------
const TEAM_ROWS = { leads: 'новые лиды', chats: 'чатов в работе', links: 'выставлено ссылок', bought: 'продано курсов', sum: 'сумма оплат' };
const pad2 = n => (n < 10 ? '0' : '') + n;
// число (и «3,5» текстом) – числом, пусто – null, остальное («выходной») – строкой в нижнем регистре
function teamVal(v) {
  if (v === '' || v == null) return null;
  if (typeof v === 'number') return v;
  const t = String(v).trim();
  if (/^-?[\d\s\u00a0]+([.,]\d+)?$/.test(t)) return +t.replace(/[\s\u00a0]/g, '').replace(',', '.');
  return t.toLowerCase() || null;
}
function teamOpen(q) {
  const id = (String(q.url || '').match(/\/spreadsheets\/d\/([\w-]{20,})/) || [])[1];
  if (!id) throw new Error('нужна ссылка на таблицу отдела (docs.google.com/spreadsheets/d/…)');
  const props = PropertiesService.getScriptProperties(), was = props.getProperty('TEAM');
  if (was && was !== id) throw new Error('скрипт уже работает с другой таблицей отдела. Сменить: Apps Script → Настройки проекта → Свойства скрипта → удалить TEAM');
  let ss;
  try { ss = SpreadsheetApp.openById(id); } catch (e) { throw new Error('таблица отдела не открылась – проверь ссылку и доступ на редактирование'); }
  const name = String(q.name || '').trim().toLowerCase();
  if (!name) throw new Error('не указано имя в таблице отдела');
  for (const sh of ss.getSheets()) {
    const last = sh.getLastRow(), lc = sh.getLastColumn();
    if (last < 2 || lc < 3) continue;
    const ab = sh.getRange(1, 1, last, 2).getDisplayValues();
    const r0 = ab.findIndex(r => String(r[0]).trim().toLowerCase() === name);
    if (r0 < 0) continue;
    // блок – от строки с именем до следующего имени в A (объединённая ячейка: имя только в первой строке)
    const rows = {};
    for (let i = r0; i < last && (i === r0 || !String(ab[i][0]).trim()); i++) {
      const lb = String(ab[i][1]).trim().toLowerCase();
      Object.keys(TEAM_ROWS).forEach(k => { if (!rows[k] && lb.indexOf(TEAM_ROWS[k]) === 0) rows[k] = i + 1; });
    }
    if (!Object.keys(rows).length) continue;
    if (!was) props.setProperty('TEAM', id);
    return { ss, sh, rows, cols: teamCols(sh, lc) };
  }
  throw new Error('в таблице отдела нет блока «' + String(q.name).trim() + '» (имя в столбце A, подписи строк – в B)');
}
// столбцы дат: «дд.мм» в строке 1 → 'дд.мм.гггг'. Года в шапке нет – считаем справа налево: самый правый столбец –
// этот год (или соседний, если месяц далеко), левее год убывает, когда месяц «прыгает» вверх (январь ← декабрь)
function teamCols(sh, lc) {
  const r = sh.getRange(1, 1, 1, lc), v = r.getValues()[0], dv = r.getDisplayValues()[0], now = new Date(), nm = now.getMonth() + 1;
  const cols = {};
  let y = null, pm = null;
  for (let c = lc - 1; c >= 0; c--) {
    const p = dayOf(v[c] instanceof Date ? v[c] : dv[c]);
    if (!p || p.m < 1 || p.m > 12 || p.d < 1 || p.d > 31) continue;
    if (!p.y) {
      if (y == null) y = now.getFullYear() + (p.m - nm > 6 ? -1 : nm - p.m > 6 ? 1 : 0);
      else if (p.m > pm) y--;
      p.y = y;
    } else y = p.y;
    pm = p.m;
    const k = pad2(p.d) + '.' + pad2(p.m) + '.' + p.y;
    if (!cols[k]) cols[k] = c + 1;
  }
  return cols;
}
// q: {url, name, from, to} → { sheet, rows: что нашлось, days: {'дд.мм.гггг': {leads, chats, links, bought, sum}} }
function teamRead(q) {
  const t = teamOpen(q), lo = dayOf(q.from), hi = dayOf(q.to);
  const ks = Object.keys(t.rows), r1 = Math.min(...ks.map(k => t.rows[k])), r2 = Math.max(...ks.map(k => t.rows[k]));
  const vals = t.sh.getRange(r1, 1, r2 - r1 + 1, t.sh.getLastColumn()).getValues(), days = {};
  Object.keys(t.cols).forEach(d => {
    const p = dayOf(d);
    if (lo && ord(p) < ord(lo) || hi && ord(p) > ord(hi)) return;
    const o = {};
    ks.forEach(k => { o[k] = teamVal(vals[t.rows[k] - r1][t.cols[d] - 1]); });
    days[d] = o;
  });
  return { sheet: t.sh.getName(), rows: ks, days };
}
// q: {url, name, cells: [{d, k, v, was}]} – пишем, только если в ячейке всё ещё то, что помощник видел (was), и там не формула
function teamPut(q) {
  const t = teamOpen(q);
  return (q.cells || []).map(c => {
    const row = t.rows[c.k], col = t.cols[c.d];
    if (!row) return 'norow';
    if (!col) return 'nocol';
    const cell = t.sh.getRange(row, col);
    if (cell.getFormula()) return 'formula';
    const cur = teamVal(cell.getValue()), was = c.was == null ? null : c.was;
    if (typeof cur === 'number' && typeof was === 'number' ? Math.abs(cur - was) > 0.005 : cur !== was) return 'changed';
    cell.setValue(+c.v || 0);
    return 'ok';
  });
}
