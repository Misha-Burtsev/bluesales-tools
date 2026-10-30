const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require('node:path').join(__dirname, '../bluesales-helper.user.js'), 'utf8');
const section = (a, b) => source.slice(source.indexOf(a), source.indexOf(b, source.indexOf(a)));
function setup() {
  const data = { bsGoal: { n: 100 }, bsKpi: { 202610: 99 }, bsPremFactors: {} };
  const ctx = vm.createContext({
    jget: (k, fallback) => data[k] ?? fallback,
    localStorage: { setItem: (k, v) => { data[k] = JSON.parse(v); } },
    histAll: () => [{ d: '01.10.2026', rep: { bought: 150 }, sales: [], mine: true }],
    ymOf: d => +d.slice(6) * 100 + +d.slice(3, 5),
    shiftMine: e => e.mine, payRate: () => ({ sum: 10000, n: 15 }),
    sheetUrl: () => '', sheetTab: null, premOn: () => true,
    premSum: () => ({ v: 10000, miss: 0 }),
    paintStat: () => {}, statYm: 202610,
  });
  vm.runInContext("const GOAL_KEY = 'bsGoal';" +
    section("  const KPI_KEY =", '  // премия за месяц:') +
    section('  function monthStat(ym)', '  // карточка-подсказка к зарплате:') +
    section('  function statClick(box)', '  const paintShift ='), ctx);
  return { data, ctx, run: s => vm.runInContext(s, ctx) };
}
test('auto boundaries and no manual setting in another month', () => {
  const { data, run } = setup();
  assert.equal(run('premK(202610).k'), 1.21);
  for (const [sold, expected] of [[79.9, .9], [80, 1], [149.9, 1], [150, 1.1]]) {
    run(`histAll = () => [{ d: '01.10.2026', rep: { bought: ${sold} } }]`);
    assert.equal(run('premK(202610).p'), expected);
  }
  for (const [kpi, expected] of [[69.9, .9], [70, 1], [96.9, 1], [97, 1.1]]) {
    data.bsKpi[202610] = kpi;
    assert.equal(run('premK(202610).q'), expected);
  }
  data.bsPremFactors[202610] = { q: 1.15, p: 1.05 };
  assert.equal(run('premK(202610).k'), 1.2075);
  assert.equal(run('premK(202611).manualQ'), false);
  assert.equal(run('premK(202611).q'), 1);
});
test('independent manual values, zero, salary and invalid stored values', () => {
  const { data, run } = setup();
  data.bsPremFactors[202610] = { q: 1.15 };
  assert.equal(run('premK(202610).p'), 1.1);
  assert.equal(run('monthStat(202610).prem'), 12650);
  assert.equal(run('monthStat(202610).shifts'), 667);
  assert.equal(run('monthStat(202610).sal'), 13317);
  data.bsPremFactors[202610] = { q: 0, p: 1.05 };
  assert.equal(run('monthStat(202610).sal'), 667);
  data.bsPremFactors[202610] = { q: -1, p: 'oops' };
  assert.equal(run('premK(202610).k'), 1.21);
  delete data.bsPremFactors[202610];
  assert.equal(run('monthStat(202610).prem'), 12100);
  run("premOn = () => false; sheetUrl = () => 'connected'; sheetTab = { months: [{ y: 2026, m: 10, prem: 9000 }] };");
  data.bsPremFactors[202610] = { q: 1.5, p: 1.5 };
  assert.equal(run('monthStat(202610).prem'), 9000); // N1 already includes coefficients
});
test('decimal input and invalid values', () => {
  const { run } = setup();
  for (const [input, expected] of [['1,15', 1.15], [' 1.05 ', 1.05], ['', null], [' ', null], ['0', 0]])
    assert.equal(run(`factorParse(${JSON.stringify(input)})`), expected);
  for (const input of ['-1', 'Infinity', '1abc', '1,2,3', '1e3'])
    assert.ok(Number.isNaN(run(`factorParse(${JSON.stringify(input)})`)));
});
test('save and reset keep other months; invalid input leaves storage intact', () => {
  const { data, ctx, run } = setup();
  data.bsPremFactors[202609] = { p: 1.2 };
  const status = {}, inputs = ['q', 'p'].map(key => ({ dataset: { factor: key }, value: '', focus() {} }));
  const panel = { querySelector: () => status, querySelectorAll: () => inputs };
  ctx.box = { querySelector: selector => selector === '.bs-factors' ? panel : status };
  run('statClick(box)');
  const click = a => ctx.box.onclick({ target: { closest: () => ({ dataset: { a } }) } });
  inputs[0].value = '1,15';
  click('factors-save');
  assert.deepEqual(data.bsPremFactors[202610], { q: 1.15 });
  assert.equal(run('premK(202610).k'), 1.265);
  inputs[1].value = '-2';
  click('factors-save');
  assert.deepEqual(data.bsPremFactors[202610], { q: 1.15 });
  click('factors-auto');
  assert.equal(data.bsPremFactors[202610], undefined);
  assert.deepEqual(data.bsPremFactors[202609], { p: 1.2 });
  inputs[0].value = ''; inputs[1].value = '';
  click('factors-save');
  assert.equal(run('premK(202610).manualQ'), false);
});
