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
//
// Строка ниже – доступ только к этой таблице, а не ко всем таблицам на Google Диске.
/** @OnlyCurrentDoc */

const COL = { name: 1, kind: 2, link: 5, pay: 6, sum: 7, email: 9, mops: 11, date: 15 };
const WIDTH = 15;   // A…O – строки продаж; правее (справочник продуктов) не трогаем
const MONTH_NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MONTHS = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const body = JSON.parse(e.postData.contents);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    if (body.ping) return out({ ok: true, sheets: salesSheets(ss).map(sh => sh.getName()) });
    // сверка: какие продажи уже есть в таблице (ничего не пишет)
    const memo = {};   // лист месяца читаем один раз на весь запрос
    if (body.find) return out({ ok: true, res: body.find.map(s => {
      try { return findSale(ss, s, null, memo) || { st: 'miss' }; }
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
  const scan = (vals, forms, n, name) => {
    let day = '';   // дата пишется только у первой продажи дня
    for (let r = 2; r <= n; r++) {
      const v = vals[r - 1], link = String(v[COL.link - 1]) + forms[r - 1][0];
      if (v[COL.date - 1] !== '') day = dmOf(v[COL.date - 1]);
      const byDlg = re && re.test(link), sum = +v[COL.sum - 1];
      if (!name && byDlg && sum === +s.sum) return { st: 'dup', row: r, sheet: sh.getName() };
      if (byDlg || mail && String(v[COL.email - 1]).trim().toLowerCase() === mail)
        also.push(name ? { row: r, sum, d: day, sheet: name } : { row: r, sum, d: day });
    }
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
