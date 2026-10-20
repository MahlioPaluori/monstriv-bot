import assert from "node:assert/strict";
import test from "node:test";

import {
  categoryNamedRangeRequest,
  categoryValidationRequest,
  findApplicationRowsInSpreadsheet,
  INITIAL_REQUEST_CATEGORIES,
  isExpectedCategoryNamedRange,
  newMonthlySpreadsheetSheets,
  resolveOperatorSheetLayout,
  runWithSheetWriteLease,
  writeConfirmedMultiRequest,
  writeConfirmedSingleRequest,
} from "../lib/google-sheets.js";

const LEGACY_HEADERS = ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ", "Телефон", "Паспорт", "РНОКПП", "Військовий документ", "УБД", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"];
const CATEGORY_HEADERS = ["Статус", "Категорія запиту", ...LEGACY_HEADERS.slice(1)];
const singleRow = (id, headers = LEGACY_HEADERS) => {
  const row = Array(headers.length).fill("");
  row[0] = "Нова";
  row[headers === CATEGORY_HEADERS ? 2 : 1] = id;
  return row;
};

process.env.VERCEL_PROJECT_PRODUCTION_URL ||= "example.test";
process.env.REQUEST_CARD_SIGNING_SECRET ||= "test-secret";

function columnIndex(label) {
  return [...label].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0) - 1;
}

function parseRange(range) {
  const match = range.match(/!([A-Z]+)(\d+)(?::([A-Z]+)(\d+)?)?$/);
  if (!match) throw new Error(`Unsupported test range: ${range}`);
  return {
    startColumn: columnIndex(match[1]),
    startRow: Number(match[2]),
    endColumn: columnIndex(match[3] || match[1]),
    endRow: match[4] ? Number(match[4]) : null,
  };
}

function trimValues(values) {
  const rows = values.map((row) => {
    const copy = [...row];
    while (copy.length && (copy.at(-1) === "" || copy.at(-1) === undefined)) copy.pop();
    return copy;
  });
  while (rows.length && !rows.at(-1).length) rows.pop();
  return rows;
}

function sheetsMock({ rows = [LEGACY_HEADERS], rowGroups = [], failCollapseOnce = false } = {}) {
  const state = {
    rows: rows.map((row) => [...row]),
    rowGroups: rowGroups.map((group) => structuredClone(group)),
    rowCount: 100,
    appendCalls: 0,
    failCollapseOnce,
  };
  const ensureRow = (rowNumber) => {
    while (state.rows.length < rowNumber) state.rows.push([]);
    return state.rows[rowNumber - 1];
  };
  const api = {
    spreadsheets: {
      values: {
        append: async () => { state.appendCalls += 1; throw new Error("values.append must not be used"); },
        get: async ({ range }) => {
          const parsed = parseRange(range);
          const endRow = parsed.endRow || state.rows.length;
          const values = [];
          for (let rowNumber = parsed.startRow; rowNumber <= endRow; rowNumber += 1) {
            values.push((state.rows[rowNumber - 1] || []).slice(parsed.startColumn, parsed.endColumn + 1));
          }
          return { data: { values: trimValues(values) } };
        },
        update: async ({ range, requestBody }) => {
          const parsed = parseRange(range);
          requestBody.values.forEach((inputRow, rowOffset) => {
            const target = ensureRow(parsed.startRow + rowOffset);
            inputRow.forEach((value, columnOffset) => { target[parsed.startColumn + columnOffset] = value; });
          });
          return { data: { updatedRange: range } };
        },
      },
      get: async () => ({
        data: {
          sheets: [{
            properties: { sheetId: 7, title: "Фізособи", gridProperties: { rowCount: state.rowCount } },
            rowGroups: state.rowGroups,
          }],
        },
      }),
      batchUpdate: async ({ requestBody }) => {
        for (const request of requestBody.requests || []) {
          if (request.appendDimension) state.rowCount += request.appendDimension.length;
          if (request.addDimensionGroup) {
            state.rowGroups.push({ range: { ...request.addDimensionGroup.range }, depth: 1, collapsed: false });
          }
          if (request.updateDimensionGroup) {
            if (state.failCollapseOnce) {
              state.failCollapseOnce = false;
              throw new Error("simulated grouping failure");
            }
            const wanted = request.updateDimensionGroup.dimensionGroup;
            const group = state.rowGroups.find((item) => item.range.startIndex === wanted.range.startIndex && item.range.endIndex === wanted.range.endIndex);
            if (!group) throw new Error("group not found");
            group.collapsed = wanted.collapsed;
          }
          if (request.updateCells) {
            const startRow = request.updateCells.range.startRowIndex + 1;
            const startColumn = request.updateCells.range.startColumnIndex;
            for (let rowOffset = 0; rowOffset < (request.updateCells.rows || []).length; rowOffset += 1) {
              const target = ensureRow(startRow + rowOffset);
              for (let columnOffset = 0; columnOffset < (request.updateCells.rows[rowOffset].values || []).length; columnOffset += 1) {
                const cell = request.updateCells.rows[rowOffset].values[columnOffset];
                if (cell.userEnteredValue?.stringValue !== undefined) target[startColumn + columnOffset] = cell.userEnteredValue.stringValue;
              }
            }
          }
        }
        return { data: {} };
      },
    },
  };
  return { api, state };
}

function multiRequest(count = 2) {
  return {
    type: "individual",
    multiPackage: true,
    beneficiaryCount: count,
    data: { name: "Applicant", phone: "hidden", need: "Need" },
    beneficiaries: Array.from({ length: count }, (_, index) => ({
      name: `Person ${index + 1}`,
      phone: "hidden",
      documents: {},
    })),
  };
}

const ownership = async () => {};
const confirmedAt = "2026-10-14T08:00:00.000Z";

test("layout resolver accepts exact legacy and category headers and rejects ambiguous headers", () => {
  assert.equal(resolveOperatorSheetLayout("Фізособи", LEGACY_HEADERS).applicationIdIndex, 1);
  assert.equal(resolveOperatorSheetLayout("Фізособи", CATEGORY_HEADERS).applicationIdIndex, 2);
  assert.throws(() => resolveOperatorSheetLayout("Фізособи", ["Статус", "ID запиту"]), (error) => error.code === "SHEETS_UNKNOWN_LAYOUT");
});

test("new monthly spreadsheet contract includes the seven-category reference and exact list validation", () => {
  assert.deepEqual(newMonthlySpreadsheetSheets().map((sheet) => sheet.properties.title), ["Фізособи", "Військові частини", "Довідники"]);
  assert.deepEqual(INITIAL_REQUEST_CATEGORIES, ["Старлінк", "Старлінк міні", "Детектор", "Зарядні станції", "Генератори", "Такмед", "Інше"]);
  const validation = categoryValidationRequest(7).setDataValidation;
  assert.deepEqual(validation.range, { sheetId: 7, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 });
  assert.equal(validation.rule.condition.type, "ONE_OF_LIST");
  assert.deepEqual(validation.rule.condition.values.map((value) => value.userEnteredValue), INITIAL_REQUEST_CATEGORIES);
  const namedRange = categoryNamedRangeRequest(9).addNamedRange.namedRange;
  assert.equal(namedRange.name, "MonstrivRequestCategories");
  assert.equal(namedRange.namedRangeId, undefined);
  assert.deepEqual(namedRange.range, { sheetId: 9, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 });
  const apiNamedRange = { name: "MonstrivRequestCategories", range: { sheetId: 9, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 } };
  assert.equal(isExpectedCategoryNamedRange(apiNamedRange, 9, 1000), true);
  assert.equal(isExpectedCategoryNamedRange({ ...apiNamedRange, range: { ...apiNamedRange.range, endRowIndex: null } }, 9, 1000), true);
  assert.equal(isExpectedCategoryNamedRange({ ...apiNamedRange, range: { ...apiNamedRange.range, endRowIndex: 1000 } }, 9, 1000), true);
  assert.equal(isExpectedCategoryNamedRange({ ...apiNamedRange, range: { ...apiNamedRange.range, endRowIndex: 999 } }, 9, 1000), false);
  assert.equal(isExpectedCategoryNamedRange({ ...apiNamedRange, range: { ...apiNamedRange.range, endRowIndex: 0 } }, 9, 1000), false);
  assert.equal(isExpectedCategoryNamedRange({ ...apiNamedRange, range: { ...apiNamedRange.range, sheetId: 10 } }, 9, 1000), false);
});

test("category layout leaves operator category blank and keeps it on retry", async () => {
  const { api, state } = sheetsMock({ rows: [CATEGORY_HEADERS] });
  const request = multiRequest();
  request.beneficiaries[0].documents.passport = [{ fileName: "passport.jpg", driveUrl: "https://example.test/file" }];
  const args = { sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request, applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership };
  await writeConfirmedMultiRequest(args);
  assert.equal(state.rows[1][1], "");
  assert.equal(state.rows[1][2], "2026-10-0001");
  assert.equal(state.rows[2][7], "passport.jpg");
  state.rows[1][1] = "Такмед";
  await writeConfirmedMultiRequest(args);
  assert.equal(state.rows[1][1], "Такмед");
  assert.deepEqual(state.rows.slice(2, 4).map((row) => row[2]), ["Особа 1", "Особа 2"]);
});

test("category-layout single writer puts the ID in C and preserves operator category on retry", async () => {
  const { api, state } = sheetsMock({ rows: [CATEGORY_HEADERS] });
  const row = singleRow("2026-10-0010", CATEGORY_HEADERS);
  const args = { sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", row, documentCells: [], applicationId: "2026-10-0010", assertOwnership: ownership };
  await writeConfirmedSingleRequest(args);
  assert.equal(state.rows[1][1], "");
  assert.equal(state.rows[1][2], "2026-10-0010");
  state.rows[1][1] = "Детектор";
  await writeConfirmedSingleRequest(args);
  assert.equal(state.rows[1][1], "Детектор");
});

test("unknown headers fail before a writer update", async () => {
  const { api, state } = sheetsMock({ rows: [["Статус", "Невідома колонка"]] });
  await assert.rejects(writeConfirmedSingleRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", row: singleRow("2026-10-0001"), documentCells: [], applicationId: "2026-10-0001", assertOwnership: ownership }), (error) => error.code === "SHEETS_UNKNOWN_LAYOUT");
  assert.equal(state.rows.length, 1);
});

test("application ID lookup uses each sheet layout's semantic ID column", async () => {
  const individualRows = [CATEGORY_HEADERS, singleRow("2026-10-0007", CATEGORY_HEADERS)];
  const militaryHeaders = ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ відповідальної особи", "Телефон", "Номер ВЧ", "Офіційний запит", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"];
  const militaryRows = [militaryHeaders, ["Нова", "2026-10-0008"]];
  const api = { spreadsheets: { values: { get: async ({ range }) => {
    const rows = range.includes("'Фізособи'") ? individualRows : militaryRows;
    if (range.endsWith("A1:Z1")) return { data: { values: [rows[0]] } };
    const idIndex = range.includes("'Фізособи'") ? 2 : 1;
    return { data: { values: rows.slice(1).map((row) => [row[idIndex]]) } };
  } } } };
  const individual = await findApplicationRowsInSpreadsheet(api, "sheet", "2026-10-0007");
  const military = await findApplicationRowsInSpreadsheet(api, "sheet", "2026-10-0008");
  assert.deepEqual(individual.map(({ title, rowNumber }) => [title, rowNumber]), [["Фізособи", 2]]);
  assert.deepEqual(military.map(({ title, rowNumber }) => [title, rowNumber]), [["Військові частини", 2]]);
});

test("multi followed by single keeps the single row outside the multi group", async () => {
  const previousSecret = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "test-secret";
  try {
    const { api, state } = sheetsMock();
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership });
    await writeConfirmedSingleRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", row: singleRow("2026-10-0002"), documentCells: [], applicationId: "2026-10-0002", assertOwnership: ownership });
    assert.equal(state.rows[4][1], "2026-10-0002");
    assert.deepEqual(state.rowGroups.map(({ range }) => [range.startIndex, range.endIndex]), [[2, 4]]);
    assert.equal(state.appendCalls, 0);
  } finally {
    if (previousSecret === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previousSecret;
  }
});

test("multi followed by multi creates isolated non-overlapping groups", async () => {
  const previousSecret = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "test-secret";
  try {
    const { api, state } = sheetsMock();
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership });
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0002", confirmedAt, assertOwnership: ownership });
    assert.deepEqual(state.rows.slice(1, 7).map((row) => row[1]), ["2026-10-0001", "Особа 1", "Особа 2", "2026-10-0002", "Особа 1", "Особа 2"]);
    assert.deepEqual(state.rowGroups.map(({ range }) => [range.startIndex, range.endIndex]), [[2, 4], [5, 7]]);
  } finally {
    if (previousSecret === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previousSecret;
  }
});

test("single followed by multi preserves the single row and creates one exact detail group", async () => {
  const { api, state } = sheetsMock();
  await writeConfirmedSingleRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", row: singleRow("2026-10-0001"), documentCells: [], applicationId: "2026-10-0001", assertOwnership: ownership });
  await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0002", confirmedAt, assertOwnership: ownership });
  assert.deepEqual(state.rows.slice(1, 5).map((row) => row[1]), ["2026-10-0001", "2026-10-0002", "Особа 1", "Особа 2"]);
  assert.deepEqual(state.rowGroups.map(({ range }) => [range.startIndex, range.endIndex]), [[3, 5]]);
});

test("repeated multi webhook reuses the complete block without duplicating rows", async () => {
  const { api, state } = sheetsMock();
  const args = { sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership };
  await writeConfirmedMultiRequest(args);
  await writeConfirmedMultiRequest(args);
  assert.equal(state.rows.filter((row) => row[1] === "2026-10-0001").length, 1);
  assert.equal(state.rows.filter((row) => /^Особа \d+$/.test(row[1] || "")).length, 2);
  assert.equal(state.rowGroups.length, 1);
});

test("partial multi retry writes only a verified empty suffix without duplicates", async () => {
  const previousSecret = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "test-secret";
  try {
    const { api, state } = sheetsMock({ rows: [LEGACY_HEADERS, singleRow("2026-10-0001"), ["", "Особа 1"]] });
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership });
    assert.deepEqual(state.rows.slice(1, 4).map((row) => row[1]), ["2026-10-0001", "Особа 1", "Особа 2"]);
    assert.equal(state.rows.filter((row) => row[1] === "Особа 2").length, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previousSecret;
  }
});

test("partial multi retry refuses to overwrite a neighboring master", async () => {
  const { api, state } = sheetsMock({ rows: [LEGACY_HEADERS, singleRow("2026-10-0001"), ["", "Особа 1"], singleRow("2026-10-0099")] });
  await assert.rejects(writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership }), /Cannot recover non-empty detail row/);
  assert.equal(state.rows[3][1], "2026-10-0099");
});

test("retry after grouping failure reuses the matrix and completes the existing exact group", async () => {
  const previousSecret = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "test-secret";
  try {
    const { api, state } = sheetsMock({ failCollapseOnce: true });
    const args = { sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership };
    await assert.rejects(writeConfirmedMultiRequest(args), /simulated grouping failure/);
    await writeConfirmedMultiRequest(args);
    assert.equal(state.rows.filter((row) => row[1] === "2026-10-0001").length, 1);
    assert.equal(state.rows.filter((row) => row[1] === "Особа 1").length, 1);
    assert.deepEqual(state.rowGroups.map(({ range, collapsed }) => [range.startIndex, range.endIndex, collapsed]), [[2, 4, true]]);
  } finally {
    if (previousSecret === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previousSecret;
  }
});

test("sheet writer lease serializes concurrent writers across invocations", async () => {
  let owner = null;
  let releaseFirst;
  const gate = new Promise((resolve) => { releaseFirst = resolve; });
  const services = {
    acquire: async (_spreadsheet, _sheet, token) => { if (owner) return false; owner = token; return true; },
    renew: async (_spreadsheet, _sheet, token) => owner === token,
    check: async (_spreadsheet, _sheet, token) => owner === token,
    release: async (_spreadsheet, _sheet, token) => { if (owner !== token) return false; owner = null; return true; },
    heartbeatMs: 1000,
  };
  const first = runWithSheetWriteLease("spreadsheet", 7, async () => gate, { ...services, ownerToken: "writer-a" });
  await assert.rejects(runWithSheetWriteLease("spreadsheet", 7, async () => {}, { ...services, ownerToken: "writer-b" }), (error) => error.code === "SHEET_WRITE_BUSY");
  releaseFirst();
  await first;
  await runWithSheetWriteLease("spreadsheet", 7, async () => {}, { ...services, ownerToken: "writer-b" });
});

test("lost sheet writer lease stops the old writer at the next ownership fence", async () => {
  let owner = "writer-a";
  const services = {
    acquire: async () => true,
    renew: async (_spreadsheet, _sheet, token) => owner === token,
    check: async (_spreadsheet, _sheet, token) => owner === token,
    release: async () => true,
    ownerToken: "writer-a",
    heartbeatMs: 1000,
  };
  await assert.rejects(runWithSheetWriteLease("spreadsheet", 7, async (assertOwnership) => {
    owner = null;
    await assertOwnership();
  }, services), (error) => error.code === "SHEET_WRITE_CLAIM_LOST");
});
