const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const context = vm.createContext({});
vm.runInContext(fs.readFileSync(path.join(__dirname, '../bluesales-sheet.gs'), 'utf8'), context);
const { dayTotalFormula, plan, updateDayTotals } = context;

const russianFormula = (row, scan) =>
  `=ЕСЛИ(O${row}="";"";СУММ(L${row}:ИНДЕКС(L:L;ЕСЛИОШИБКА(СТРОКА()+ПОИСКПОЗ(ИСТИНА;ИНДЕКС(${scan}<>"";0);0)-1;ЧСТРОК(L:L)))))`;
const relativeScan = 'ИНДЕКС(O:O;СТРОКА()+1):ИНДЕКС(O:O;ЧСТРОК(O:O))';

function dayTotalsSheet(cells) {
  return {
    getRange(row, column, height) {
      assert.equal(column, 14);
      if (height) {
        return {
          getFormulas: () => Array.from({ length: height }, (_, i) => {
            const cell = cells.get(row + i);
            return [typeof cell === 'string' && cell.startsWith('=') ? cell : ''];
          })
        };
      }
      return {
        isBlank: () => !cells.has(row),
        setFormula: formula => cells.set(row, formula)
      };
    }
  };
}

test('adding day 7 between days 6 and 10 repairs shifted totals and fills day 7 only once', () => {
  const dates = [null, 3, 4, 5, 6, 10, 12];
  const products = ['', 'A', 'B', 'C', 'D', 'E', 'F'];
  const monthly = '=СУММ(L:L)*Q21';
  const cells = new Map([
    [1, monthly],
    [2, russianFormula(2, 'O3:O')],
    [3, russianFormula(3, 'O4:O')],
    [4, russianFormula(4, 'O5:O')],
    [5, russianFormula(5, 'O7:O')], // Sheets shifts the start past the inserted row.
    [7, russianFormula(7, 'O8:O')],
    [8, russianFormula(8, 'O9:O')]
  ]);
  const first = plan(products, dates, 7);
  assert.equal(first.row, 6);
  assert.equal(first.insert && first.date, true);
  dates.splice(first.row - 1, 0, 7);
  products.splice(first.row - 1, 0, 'G');
  updateDayTotals(dayTotalsSheet(cells), dates, first.row);

  assert.equal(cells.get(1), monthly);
  for (let row = 2; row <= 8; row++) assert.equal(cells.get(row), russianFormula(row, relativeScan));

  const second = plan(products, dates, 7);
  assert.equal(second.row, 7);
  assert.equal(second.insert, true);
  assert.equal(second.date, undefined);
  dates.splice(second.row - 1, 0, null);
  cells.set(9, cells.get(8));
  cells.set(8, cells.get(7));
  cells.delete(7);
  updateDayTotals(dayTotalsSheet(cells), dates, 0);

  assert.equal(cells.get(6), russianFormula(6, relativeScan));
  assert.equal(cells.has(7), false);
  assert.equal(cells.get(8), russianFormula(8, relativeScan));
  assert.equal(cells.get(9), russianFormula(9, relativeScan));
});

test('a sheet without a day total template keeps N empty and preserves other formulas', () => {
  const cells = new Map([[1, '=SUM(L:L)'], [4, '=L4']]);
  updateDayTotals(dayTotalsSheet(cells), [null, 3, 7, 10], 3);
  assert.deepEqual([...cells], [[1, '=SUM(L:L)'], [4, '=L4']]);
});

test('the day total template preserves English function names and comma separators', () => {
  const original = '=IF(O4="","",SUM(L4:INDEX(L:L,IFERROR(ROW()+MATCH(TRUE,INDEX(O12:O<>"",0),0)-1,ROWS(L:L)))))';
  const updated = '=IF(O5="","",SUM(L5:INDEX(L:L,IFERROR(ROW()+MATCH(TRUE,INDEX(INDEX(O:O,ROW()+1):INDEX(O:O,ROWS(O:O))<>"",0),0)-1,ROWS(L:L)))))';
  assert.equal(dayTotalFormula(original, 5), updated);
  assert.equal(dayTotalFormula(updated, 5), updated);
});
