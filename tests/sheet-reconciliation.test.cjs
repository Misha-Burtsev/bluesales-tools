const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../bluesales-helper.user.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const date = '15.11.2026';
const month = { y: 2026, m: 11, sheet: 'Ноябрь' };
const sentSale = dlg => ({ id: dlg, dlg, price: 800, sh: 1, shT: { sum: 800, email: '', mops: 1 } });
const sheetRow = dlg => ({ dlg, ym: 202611, sum: 800, email: '', mops: 1, d: date });
const clone = data => JSON.parse(JSON.stringify(data));

function setup(current, history = []) {
  const state = { current, history, writes: 0 };
  const ctx = vm.createContext({
    ddmm: () => date, ymOf: () => 202611, toSheet: x => x.cnt !== false, saleTotal: x => x.price,
    shBad: x => x.shT.email !== (x.email || ''),
    sheetUrl: () => 'connected', withHist: f => f, teamOn: () => false,
    sheetBusy: false, teamBusy: false, ico: () => '', ICO: { sync: '' },
    salesGet: () => clone(state.current), histGet: () => clone(state.history),
    salesSet: sales => { state.current = sales; state.writes++; },
    histSave: h => { state.history = h; }
  });
  vm.runInContext(section('  const shTab =', '  const shSent =') +
    section('  const shOrder =', '  async function sheetSend(') +
    section('  function tabMatch(', '  // маленькие иконки') +
    section('  const syncRow =', '  // строка таблицы →') +
    '\nglobalThis.renderSync = syncCard;', ctx);
  return { state, ctx, reconcile: snapshot => ctx.tabMatch(true, snapshot) };
}

test('reconciliation clears the deleted row’s marker while retaining the sale and other markers', () => {
  const removed = sentSale('1'), retained = sentSale('2'), historical = sentSale('3');
  const { state, reconcile } = setup([removed, retained], [{ d: date, sales: [historical] }]);
  reconcile({ months: [month], rows: [sheetRow('2')] });
  assert.deepEqual(clone(state.current), [{ id: '1', dlg: '1', price: 800 }, retained]);
  assert.deepEqual(clone(state.history[0].sales), [{ id: '3', dlg: '3', price: 800 }]);
  assert.equal(state.writes, 1);
});

test('an unavailable month leaves sent markers alone, and a manual row still matches an unsent current sale', () => {
  const sent = sentSale('1'), unsent = { id: '2', dlg: '2', price: 800 };
  const { state, reconcile } = setup([sent, unsent]);
  reconcile({ months: [{ y: 2026, m: 11, err: 'Нет листа' }], rows: [] });
  assert.equal(state.writes, 0);
  const { only } = reconcile({ months: [month], rows: [sheetRow('1'), sheetRow('2')] });
  assert.equal(only.length, 0);
  assert.equal(state.writes, 0);
  assert.equal(state.current[1].sh, undefined);
});


test('History flags a deleted current sale even after Today cleared the marker', () => {
  const removed = { id: '1', dlg: '1', price: 9900 };
  const retained = sentSale('2');
  const otherManager = { id: '3', dlg: '3', price: 9900, cnt: false };
  const { state, ctx, reconcile } = setup([removed, retained, otherManager]);
  ctx.sheetTab = { months: [month], rows: [sheetRow('2')] };
  const { pair } = reconcile(ctx.sheetTab);
  const statuses = ctx.histSheetSales({ now: true, sales: state.current }, pair);
  assert.deepEqual(Array.from(statuses), ['miss', 'ok', null]);
  assert.match(ctx.histCurrentSheetLabel(statuses[0]), /нет в табл\./);
  assert.match(ctx.histCurrentSheetLabel(statuses[1]), /✓ табл\./);
  assert.equal(ctx.histCurrentSheetLabel(statuses[2]), '');

  const html = ctx.renderSync(null, null, { miss: statuses.filter(st => st === 'miss').length, exp: 0 }, []);
  assert.match(html, /не отправлено 1/);
  assert.doesNotMatch(html, /всё сходится|data-a="tabexp"/);
});
