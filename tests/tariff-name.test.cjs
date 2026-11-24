const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../bluesales-helper.user.js'), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
const context = vm.createContext({
  Date: class { getMonth() { return 10; } },
  norm: text => text.toLowerCase()
});
vm.runInContext(section('  const TAR_WORDS =', '  function tarFind(') +
  section('  const MONTHS =', '\n') +
  section('  function tarName(', '  // теги клиента'), context);

test('a monthly tariff with an explicit course month keeps that month in the sale name', () => {
  const title = 'Годовой курс ЕГЭ | Математика (с куратором) | декабрь';
  assert.equal(context.tarName({ k: 'мат мес кур', n: title }), title);
});

test('a monthly tariff without an explicit month keeps the automatic month', () => {
  assert.equal(context.tarName({ k: 'мат мес кур' }), 'Годовой курс ЕГЭ | Математика (с куратором) | ноябрь');
  assert.equal(context.tarName({ k: 'мат мес кур', n: 'Математика' }), 'Математика | ноябрь');
  assert.equal(context.tarName({ k: 'мат год кур', n: 'Математика' }), 'Математика');
});
