import assert from "node:assert/strict";
import test from "node:test";

import { runCategoryMigration } from "../lib/google-sheets-migration.js";

const INDIVIDUAL_LEGACY = ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ", "Телефон", "Паспорт", "РНОКПП", "Військовий документ", "УБД", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"];
const MILITARY_LEGACY = ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ відповідальної особи", "Телефон", "Номер ВЧ", "Офіційний запит", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"];
const LEGACY_CATEGORIES = ["Старлінк", "Старлінк міні", "Детектор", "Зарядна станція/Генератор", "Такмед", "Інше"];
const CURRENT_CATEGORIES = ["Старлінк", "Старлінк міні", "Детектор", "Зарядні станції", "Генератори", "Такмед", "Інше"];

function cell(value, options = {}) {
  const result = { formattedValue: value, userEnteredValue: options.formula ? { formulaValue: options.formula } : { stringValue: value } };
  if (options.link) result.textFormatRuns = [{ startIndex: 0, format: { link: { uri: options.link } } }];
  if (options.validation) result.dataValidation = options.validation;
  return result;
}

function row(values) {
  return { values: values.map((value) => typeof value === "object" && value?.formattedValue !== undefined ? value : cell(value)) };
}

function makeSheet(title, sheetId, rows) {
  return {
    properties: { title, sheetId, gridProperties: { rowCount: 100 } },
    data: [{ rowData: rows.map(row) }],
    rowGroups: title === "Фізособи" ? [{ range: { sheetId, dimension: "ROWS", startIndex: 2, endIndex: 4 }, depth: 1, collapsed: true }] : [],
    protectedRanges: [],
    filterViews: [],
  };
}

function migrationMock({ individualCategory = false, militaryCategory = false, unknown = false, withReference = false, wrongCategoryValidation = false, failCopy = false, failValidation = false, ignoreValidationWrite = false, materializeNamedRangeEnd = false } = {}) {
  const state = {
    files: [{ id: "monthly-1", name: "Запити-жовтень-2026", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["root"] }],
    sheets: [
      makeSheet("Фізособи", 11, [
        unknown ? ["Статус", "Невідомо"] : individualCategory ? [INDIVIDUAL_LEGACY[0], "Категорія запиту", ...INDIVIDUAL_LEGACY.slice(1)] : INDIVIDUAL_LEGACY,
        individualCategory
          ? ["Нова", "Такмед", "2026-10-0001", "19.10.2026", "Need", "Person", "phone", cell("passport.jpg", { link: "https://drive.test/passport" }), "tax.pdf", "military.jpg", "", "City", "1", "Ні", "", ""]
          : ["Нова", "2026-10-0001", "19.10.2026", "Need", "Person", "phone", cell("passport.jpg", { link: "https://drive.test/passport" }), "tax.pdf", "military.jpg", "", "City", "1", "Ні", "", ""],
        individualCategory ? ["", "", "Особа 1", "", "", "One", "phone1"] : ["", "Особа 1", "", "", "One", "phone1"],
        individualCategory ? ["", "", "Особа 2", "", "", "Two", "phone2"] : ["", "Особа 2", "", "", "Two", "phone2"],
      ]),
      makeSheet("Військові частини", 12, [
        militaryCategory ? [MILITARY_LEGACY[0], "Категорія запиту", ...MILITARY_LEGACY.slice(1)] : MILITARY_LEGACY,
        militaryCategory
          ? ["Нова", "", "2026-10-0002", "19.10.2026", "Need", "Contact", "phone", "A1234", cell("official.pdf", { link: "https://drive.test/official" }), "City", "2", "Ні", "", ""]
          : ["Нова", "2026-10-0002", "19.10.2026", "Need", "Contact", "phone", "A1234", cell("official.pdf", { link: "https://drive.test/official" }), "City", "2", "Ні", "", ""],
      ]),
    ],
    copies: [],
    mutations: [],
    events: [],
    namedRanges: [],
    insertRequests: [],
  };
  if (withReference) state.sheets.push(makeSheet("Довідники", 13, [["Категорія запиту"], ...LEGACY_CATEGORIES.map((category) => [category])]));
  if (wrongCategoryValidation) {
    const statusRule = { condition: { type: "ONE_OF_LIST", values: [{ userEnteredValue: "Нова" }, { userEnteredValue: "В роботі" }] }, strict: true, showCustomUi: true };
    for (const sheet of state.sheets.filter((item) => item.properties.title !== "Довідники")) {
      sheet.data[0].rowData[1].values[1].dataValidation = structuredClone(statusRule);
    }
  }

  const ensureGridCell = (sheet, rowIndex, columnIndex) => {
    const rows = sheet.data[0].rowData;
    while (rows.length <= rowIndex) rows.push({ values: [] });
    while ((rows[rowIndex].values ||= []).length <= columnIndex) rows[rowIndex].values.push(cell(""));
    return rows[rowIndex].values[columnIndex];
  };
  const drive = {
    files: {
      list: async () => ({ data: { files: state.files } }),
      get: async ({ fileId }) => ({ data: fileId === "backup-1"
        ? { id: "backup-1", name: "backup", mimeType: "application/vnd.google-apps.spreadsheet", parents: ["root"], trashed: false }
        : { ...state.files[0], trashed: false } }),
      copy: async () => {
        if (failCopy) throw new Error("copy failed");
        state.copies.push("backup-1");
        state.events.push("backup");
        return { data: { id: "backup-1" } };
      },
    },
  };
  const sheetsApi = {
    spreadsheets: {
      get: async ({ spreadsheetId, includeGridData }) => ({ data: { spreadsheetId, namedRanges: structuredClone(state.namedRanges), sheets: includeGridData === false
        ? state.sheets.map((sheet) => ({ properties: sheet.properties }))
        : structuredClone(state.sheets) } }),
      values: {
        update: async ({ range, requestBody }) => {
          state.mutations.push(`values:${range}`);
          state.events.push(`values:${range}`);
          const match = range.match(/^'([^']+)'!([A-Z]+)(\d+)/);
          const sheet = state.sheets.find((item) => item.properties.title === match[1]);
          const startColumn = match[2].charCodeAt(0) - 65;
          const startRow = Number(match[3]) - 1;
          requestBody.values.forEach((values, rowOffset) => values.forEach((value, columnOffset) => {
            const target = ensureGridCell(sheet, startRow + rowOffset, startColumn + columnOffset);
            target.formattedValue = value;
            target.userEnteredValue = { stringValue: value };
          }));
          return { data: {} };
        },
      },
      batchUpdate: async ({ requestBody }) => {
        for (const request of requestBody.requests || []) {
          if (request.insertDimension) {
            state.insertRequests.push(structuredClone(request.insertDimension));
            state.mutations.push(`insert:${request.insertDimension.range.sheetId}`);
            state.events.push(`insert:${request.insertDimension.range.sheetId}`);
            const sheet = state.sheets.find((item) => item.properties.sheetId === request.insertDimension.range.sheetId);
            for (const dataRow of sheet.data[0].rowData) dataRow.values.splice(1, 0, cell(""));
          }
          if (request.addNamedRange) {
            state.mutations.push("named-range");
            state.events.push("named-range");
            const created = { namedRangeId: "category-range", ...structuredClone(request.addNamedRange.namedRange) };
            if (materializeNamedRangeEnd) {
              const reference = state.sheets.find((item) => item.properties.sheetId === created.range.sheetId);
              created.range.endRowIndex = reference.properties.gridProperties.rowCount;
            }
            state.namedRanges.push(created);
          }
          if (request.addSheet) {
            state.mutations.push("add:Довідники");
            state.events.push("add:Довідники");
            const added = makeSheet(request.addSheet.properties.title, 13, []);
            state.sheets.push(added);
          }
          if (request.setDataValidation) {
            if (failValidation && request.setDataValidation.rule) {
              throw Object.assign(new Error("Invalid condition"), { response: { status: 400, data: { error: { message: "Invalid category validation" } } } });
            }
            const action = request.setDataValidation.rule ? "validation" : "clear-validation";
            state.mutations.push(`${action}:${request.setDataValidation.range.sheetId}`);
            state.events.push(`${action}:${request.setDataValidation.range.sheetId}`);
            const sheet = state.sheets.find((item) => item.properties.sheetId === request.setDataValidation.range.sheetId);
            const target = ensureGridCell(sheet, 1, 1);
            if (request.setDataValidation.rule && !ignoreValidationWrite) target.dataValidation = structuredClone(request.setDataValidation.rule);
            else delete target.dataValidation;
          }
        }
        return { data: { replies: [] } };
      },
    },
  };
  let owners = new Map();
  const leaseServices = {
    acquire: async (spreadsheetId, sheetId, token) => { const key = `${spreadsheetId}:${sheetId}`; if (owners.has(key)) return false; owners.set(key, token); state.events.push(`acquire:${sheetId}`); return true; },
    renew: async (spreadsheetId, sheetId, token) => owners.get(`${spreadsheetId}:${sheetId}`) === token,
    check: async (spreadsheetId, sheetId, token) => owners.get(`${spreadsheetId}:${sheetId}`) === token,
    release: async (spreadsheetId, sheetId, token) => { const owned = owners.get(`${spreadsheetId}:${sheetId}`) === token; if (owned) { owners.delete(`${spreadsheetId}:${sheetId}`); state.events.push(`release:${sheetId}`); } return owned; },
    heartbeatMs: 1000,
  };
  return { state, services: { drive, sheetsApi, rootFolderId: "root", leaseServices } };
}

test("dry-run reports legacy layouts, duplicate-name files and performs no mutations", async () => {
  const { state, services } = migrationMock();
  state.files.push({ ...state.files[0], id: "monthly-2" });
  const report = await runCategoryMigration({ mode: "dry-run", services });
  assert.equal(report.spreadsheetCount, 2);
  assert.ok(report.results.every((item) => item.result === "would_migrate"));
  assert.ok(report.results.every((item) => item.sheets.every((sheet) => sheet.layout === "legacy")));
  assert.deepEqual(state.mutations, []);
  assert.deepEqual(state.copies, []);
});

test("apply backs up, inserts B, preserves data and links, creates reference and validation", async () => {
  const { state, services } = migrationMock();
  const report = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(report.results[0].result, "migrated");
  assert.deepEqual(state.copies, ["backup-1"]);
  assert.ok(state.insertRequests.every((request) => request.inheritFromBefore === false));
  assert.equal(state.sheets[0].data[0].rowData[1].values[2].formattedValue, "2026-10-0001");
  assert.equal(state.sheets[0].data[0].rowData[1].values[7].textFormatRuns[0].format.link.uri, "https://drive.test/passport");
  assert.ok(state.sheets.some((sheet) => sheet.properties.title === "Довідники"));
  assert.ok(state.mutations.includes("named-range"));
  assert.ok(state.mutations.includes("clear-validation:11"));
  assert.ok(state.mutations.includes("validation:11"));
  assert.ok(state.mutations.includes("validation:12"));
});

test("repeated apply is idempotent and does not create another backup or column", async () => {
  const { state, services } = migrationMock();
  await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  const second = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(second.results[0].result, "already_migrated");
  assert.equal(state.copies.length, 1);
  assert.equal(state.mutations.filter((item) => item.startsWith("insert:")).length, 2);
});

test("partially migrated spreadsheet migrates the remaining sheet and upgrades the exact legacy category list", async () => {
  const { state, services } = migrationMock({ individualCategory: true, withReference: true });
  const report = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(report.results[0].result, "migrated");
  assert.deepEqual(state.mutations.filter((item) => item.startsWith("insert:")), ["insert:12"]);
  const reference = state.sheets.find((sheet) => sheet.properties.title === "Довідники");
  assert.deepEqual(reference.data[0].rowData.slice(1).map((item) => item.values[0].formattedValue), CURRENT_CATEGORIES);
});

test("category columns without reference or validation resume safely without inserting another column", async () => {
  const { state, services } = migrationMock({ individualCategory: true, militaryCategory: true });
  const report = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(report.results[0].result, "migrated");
  assert.deepEqual(state.mutations.filter((item) => item.startsWith("insert:")), []);
  assert.equal(state.sheets.find((item) => item.properties.sheetId === 11).data[0].rowData[1].values[1].formattedValue, "Такмед");
  assert.ok(state.mutations.includes("add:Довідники"));
  assert.ok(state.mutations.includes("validation:11"));
  assert.ok(state.mutations.includes("validation:12"));
});

test("partially migrated category sheets replace inherited status validation without inserting B again", async () => {
  const { state, services } = migrationMock({ individualCategory: true, militaryCategory: true, withReference: true, wrongCategoryValidation: true });
  const report = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(report.results[0].result, "migrated");
  assert.deepEqual(state.mutations.filter((item) => item.startsWith("insert:")), []);
  assert.ok(state.mutations.includes("named-range"));
  for (const sheetId of [11, 12]) {
    const clearIndex = state.events.indexOf(`clear-validation:${sheetId}`);
    const setIndex = state.events.indexOf(`validation:${sheetId}`);
    assert.ok(clearIndex >= 0 && setIndex > clearIndex);
    const sheet = state.sheets.find((item) => item.properties.sheetId === sheetId);
    const condition = sheet.data[0].rowData[1].values[1].dataValidation.condition;
    assert.equal(condition.type, "ONE_OF_LIST");
    assert.deepEqual(condition.values.map((value) => value.userEnteredValue), CURRENT_CATEGORIES);
  }
  const second = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(second.results[0].result, "already_migrated");
  assert.equal(state.copies.length, 1);
});

test("dry-run rejects legacy ONE_OF_RANGE validation after switching to the exact category list", async () => {
  const { state, services } = migrationMock({ individualCategory: true, militaryCategory: true, withReference: true });
  const invalidRule = {
    condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: "MonstrivRequestCategories" }] },
    strict: true,
    showCustomUi: true,
  };
  for (const sheet of state.sheets.filter((item) => item.properties.sheetId === 11 || item.properties.sheetId === 12)) {
    sheet.data[0].rowData[1].values[1].dataValidation = structuredClone(invalidRule);
  }

  const report = await runCategoryMigration({ mode: "dry-run", spreadsheetId: "monthly-1", services });
  for (const sheet of report.results[0].sheets) {
    assert.equal(sheet.stats.validationPresent, false);
    assert.equal(sheet.stats.validationType, "ONE_OF_RANGE");
    assert.equal(sheet.stats.validationSource, "MonstrivRequestCategories");
  }
  assert.equal(report.results[0].result, "would_migrate");
});

test("recovery upgrades the exact 6-category reference once and is idempotent", async () => {
  const { state, services } = migrationMock({ individualCategory: true, militaryCategory: true, withReference: true, wrongCategoryValidation: true });
  const first = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(first.results[0].result, "migrated");
  const reference = state.sheets.find((sheet) => sheet.properties.sheetId === 13);
  assert.deepEqual(reference.data[0].rowData.slice(1).map((item) => item.values[0].formattedValue), CURRENT_CATEGORIES);
  assert.deepEqual(state.mutations.filter((item) => item.startsWith("insert:")), []);

  const second = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(second.results[0].result, "already_migrated");
  assert.equal(state.copies.length, 1);
  assert.deepEqual(reference.data[0].rowData.slice(1).map((item) => item.values[0].formattedValue), CURRENT_CATEGORIES);
});

test("unknown manual reference changes block dry-run and apply before backup or mutation", async () => {
  const { state, services } = migrationMock({ individualCategory: true, militaryCategory: true, withReference: true });
  const reference = state.sheets.find((sheet) => sheet.properties.sheetId === 13);
  reference.data[0].rowData[2].values[0] = cell("Ручна категорія");

  const dryRun = await runCategoryMigration({ mode: "dry-run", spreadsheetId: "monthly-1", services });
  assert.equal(dryRun.results[0].result, "blocked");
  assert.ok(dryRun.results[0].ambiguities.some((message) => message.includes("unknown manual changes")));
  await assert.rejects(
    runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services }),
    (error) => error.code === "MIGRATION_STRUCTURE_AMBIGUOUS",
  );
  assert.deepEqual(state.copies, []);
  assert.deepEqual(state.mutations, []);
});

test("API-materialized full-column named range is accepted after creation", async () => {
  const { state, services } = migrationMock({
    individualCategory: true,
    militaryCategory: true,
    withReference: true,
    wrongCategoryValidation: true,
    materializeNamedRangeEnd: true,
  });
  const report = await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.equal(report.results[0].result, "migrated");
  assert.equal(report.results[0].namedRange.valid, true);
  assert.equal(state.namedRanges[0].range.endRowIndex, 100);
  assert.deepEqual(state.mutations.filter((item) => item.startsWith("insert:")), []);
});

test("migration holds both production writer leases before backup and all mutations", async () => {
  const { state, services } = migrationMock();
  await runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services });
  assert.deepEqual(state.events.slice(0, 3), ["acquire:11", "acquire:12", "backup"]);
  const lastMutation = Math.max(...state.events.map((event, index) => /^(insert|values|add|validation):/.test(event) ? index : -1));
  assert.ok(state.events.indexOf("release:12") > lastMutation);
  assert.ok(state.events.indexOf("release:11") > lastMutation);
});

test("unknown headers stop apply before backup or mutations", async () => {
  const { state, services } = migrationMock({ unknown: true });
  await assert.rejects(runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services }), /Migration blocked/);
  assert.deepEqual(state.copies, []);
  assert.deepEqual(state.mutations, []);
});

test("backup API failure stops apply before Sheets mutations", async () => {
  const { state, services } = migrationMock({ failCopy: true });
  await assert.rejects(runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services }), /copy failed/);
  assert.deepEqual(state.mutations, []);
});

test("Google validation failure is tagged with the safe migration stage", async () => {
  const { services } = migrationMock({ failValidation: true });
  await assert.rejects(
    runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services }),
    (error) => error.migrationStage === "set_category_validation" && error.response?.status === 400,
  );
});

test("post-verification failure exposes a controlled local stage and code", async () => {
  const { services } = migrationMock({ ignoreValidationWrite: true });
  await assert.rejects(
    runCategoryMigration({ mode: "apply", spreadsheetId: "monthly-1", services }),
    (error) => error.migrationStage === "verify_category_validation"
      && error.code === "MIGRATION_VALIDATION_VERIFICATION_FAILED"
      && error.migrationSafeToLog === true,
  );
});
