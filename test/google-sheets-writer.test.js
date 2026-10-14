import assert from "node:assert/strict";
import test from "node:test";

import {
  runWithSheetWriteLease,
  writeConfirmedMultiRequest,
  writeConfirmedSingleRequest,
} from "../lib/google-sheets.js";

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

function sheetsMock({ rows = [["Статус", "ID"]], rowGroups = [], failCollapseOnce = false } = {}) {
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

test("multi followed by single keeps the single row outside the multi group", async () => {
  const previousSecret = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "test-secret";
  try {
    const { api, state } = sheetsMock();
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership });
    await writeConfirmedSingleRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", lastColumn: "O", row: ["Нова", "2026-10-0002"], documentCells: [], applicationId: "2026-10-0002", assertOwnership: ownership });
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
  await writeConfirmedSingleRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, sheetTitle: "Фізособи", lastColumn: "O", row: ["Нова", "2026-10-0001"], documentCells: [], applicationId: "2026-10-0001", assertOwnership: ownership });
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
    const { api, state } = sheetsMock({ rows: [["Статус", "ID"], ["Нова", "2026-10-0001"], ["", "Особа 1"]] });
    await writeConfirmedMultiRequest({ sheetsApi: api, spreadsheetId: "sheet", sheetId: 7, request: multiRequest(), applicationId: "2026-10-0001", confirmedAt, assertOwnership: ownership });
    assert.deepEqual(state.rows.slice(1, 4).map((row) => row[1]), ["2026-10-0001", "Особа 1", "Особа 2"]);
    assert.equal(state.rows.filter((row) => row[1] === "Особа 2").length, 1);
  } finally {
    if (previousSecret === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previousSecret;
  }
});

test("partial multi retry refuses to overwrite a neighboring master", async () => {
  const { api, state } = sheetsMock({ rows: [["Статус", "ID"], ["Нова", "2026-10-0001"], ["", "Особа 1"], ["Нова", "2026-10-0099"]] });
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
