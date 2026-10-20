import { google } from "googleapis";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";
import {
  categoryNamedRangeRequest,
  categoryValidationRequest,
  clearCategoryValidationRequest,
  INITIAL_REQUEST_CATEGORIES,
  isExpectedCategoryNamedRange,
  REQUEST_CATEGORY_NAMED_RANGE,
  REQUEST_CATEGORY_VALIDATION_SOURCE,
  resolveOperatorSheetLayout,
  runWithSheetWriteLease,
} from "./google-sheets.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUEST_SHEETS = ["Фізособи", "Військові частини"];
const REFERENCE_SHEET = "Довідники";
const MONTHLY_NAME_PATTERN = /^Запити-.+-\d{4}$/u;
const APPLICATION_ID_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-\d{4}$/;
const DETAIL_ROW_PATTERN = /^Особа \d+$/u;

function sheetsClient() {
  return google.sheets({ version: "v4", auth: getGoogleAuth() });
}

function quoteSheet(title) {
  return `'${String(title).replace(/'/g, "''")}'`;
}

function cellText(cell) {
  return String(cell?.formattedValue ?? cell?.userEnteredValue?.stringValue ?? "");
}

function cellLinks(cell) {
  return (cell?.textFormatRuns || []).map((run) => run?.format?.link?.uri).filter(Boolean);
}

function usedRows(sheet) {
  return sheet?.data?.[0]?.rowData || [];
}

function contentSignature(cell) {
  return JSON.stringify({ text: cellText(cell), links: cellLinks(cell) });
}

function sheetStats(sheet, layout) {
  const rows = usedRows(sheet);
  let masterRows = 0;
  let detailRows = 0;
  let invalidIds = 0;
  let misplacedIds = 0;
  let links = 0;
  let formulas = 0;
  let validationPresent = false;
  let validationType = null;
  let validationSource = null;
  const idColumn = layout?.applicationIdIndex;

  rows.forEach((row, rowIndex) => {
    const cells = row?.values || [];
    cells.forEach((cell, columnIndex) => {
      links += cellLinks(cell).length;
      if (cell?.userEnteredValue?.formulaValue) formulas += 1;
      if (rowIndex === 1 && columnIndex === 1 && cell?.dataValidation?.condition) {
        validationType ||= cell.dataValidation.condition.type || null;
        validationSource ||= cell.dataValidation.condition.values?.[0]?.userEnteredValue || null;
        if (cell.dataValidation.condition.type === "ONE_OF_RANGE"
          && cell.dataValidation.condition.values?.length === 1
          && cell.dataValidation.condition.values[0]?.userEnteredValue === REQUEST_CATEGORY_VALIDATION_SOURCE) validationPresent = true;
      }
      if (rowIndex >= 1 && columnIndex !== idColumn && APPLICATION_ID_PATTERN.test(cellText(cell).trim())) misplacedIds += 1;
    });
    if (rowIndex === 0 || !Number.isInteger(idColumn)) return;
    const value = cellText(cells[idColumn]).trim();
    if (APPLICATION_ID_PATTERN.test(value)) masterRows += 1;
    else if (DETAIL_ROW_PATTERN.test(value)) detailRows += 1;
    else if (value) invalidIds += 1;
  });

  return {
    rowCount: rows.length,
    masterRows,
    detailRows,
    invalidIds,
    misplacedIds,
    richTextLinks: links,
    formulas,
    protectedRanges: sheet?.protectedRanges?.length || 0,
    rowGroups: sheet?.rowGroups?.length || 0,
    filters: (sheet?.basicFilter ? 1 : 0) + (sheet?.filterViews?.length || 0),
    validationPresent,
    validationType,
    validationSource,
  };
}

function referenceInfo(sheet) {
  if (!sheet) return { present: false, valid: false, sheetId: null, categories: [] };
  const values = usedRows(sheet).map((row) => cellText(row?.values?.[0]).trim());
  return {
    present: true,
    valid: values[0] === "Категорія запиту",
    sheetId: sheet.properties?.sheetId,
    categories: values.slice(1).filter(Boolean),
  };
}

export async function listMonthlySpreadsheets({ drive = getDrive(), rootFolderId = getGoogleConfig().rootFolderId, spreadsheetId } = {}) {
  if (spreadsheetId) {
    const response = await drive.files.get({
      fileId: spreadsheetId,
      fields: "id,name,mimeType,parents,trashed",
      supportsAllDrives: true,
    });
    const file = response.data;
    if (file.trashed || file.mimeType !== SPREADSHEET_MIME || !(file.parents || []).includes(rootFolderId)) {
      throw new Error("Target spreadsheet is not an active spreadsheet in GOOGLE_DRIVE_ROOT_FOLDER_ID");
    }
    if (!MONTHLY_NAME_PATTERN.test(file.name || "")) throw new Error("Target spreadsheet does not have a monthly spreadsheet name");
    return [file];
  }

  const files = [];
  let pageToken;
  do {
    const response = await drive.files.list({
      q: `'${String(rootFolderId).replace(/'/g, "\\'")}' in parents and mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,parents)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(response.data.files || []).filter((file) => MONTHLY_NAME_PATTERN.test(file.name || "")));
    pageToken = response.data.nextPageToken;
  } while (pageToken);
  return files.sort((left, right) => String(left.name).localeCompare(String(right.name), "uk") || String(left.id).localeCompare(String(right.id)));
}

export async function inspectMonthlySpreadsheet(file, { sheetsApi = sheetsClient() } = {}) {
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId: file.id,
    includeGridData: false,
    fields: "sheets(properties(sheetId,title)),namedRanges(namedRangeId,name,range)",
  });
  const existingTitles = new Set((metadata.data.sheets || []).map((sheet) => sheet.properties?.title));
  const requestedTitles = [...REQUEST_SHEETS, REFERENCE_SHEET].filter((title) => existingTitles.has(title));
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId: file.id,
    ranges: requestedTitles.map((title) => `${quoteSheet(title)}!A1:${title === REFERENCE_SHEET ? "A" : "Z"}`),
    includeGridData: true,
    fields: "sheets(properties(sheetId,title,gridProperties),data(rowData(values(userEnteredValue,formattedValue,textFormatRuns,dataValidation))),basicFilter,filterViews,protectedRanges,rowGroups)",
  });
  const byTitle = new Map((response.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));
  const ambiguities = [];
  const sheets = REQUEST_SHEETS.map((title) => {
    const sheet = byTitle.get(title);
    if (!sheet) {
      ambiguities.push(`Missing required sheet: ${title}`);
      return { title, sheetId: null, layout: "unknown", stats: null };
    }
    const headers = (usedRows(sheet)[0]?.values || []).map(cellText);
    let layout;
    try {
      layout = resolveOperatorSheetLayout(title, headers);
    } catch (error) {
      ambiguities.push(`${title}: ${error.message}`);
      return { title, sheetId: sheet.properties?.sheetId, layout: "unknown", headers, stats: sheetStats(sheet, null) };
    }
    const stats = sheetStats(sheet, layout);
    if (stats.invalidIds) ambiguities.push(`${title}: ${stats.invalidIds} non-empty values in the ID column are neither application IDs nor detail labels`);
    if (stats.misplacedIds) ambiguities.push(`${title}: ${stats.misplacedIds} application IDs are outside the expected ID column`);
    return { title, sheetId: sheet.properties?.sheetId, layout: layout.version, semanticLayout: layout, headers, stats };
  });
  const reference = referenceInfo(byTitle.get(REFERENCE_SHEET));
  const referenceSheet = byTitle.get(REFERENCE_SHEET);
  const referenceSheetId = referenceSheet?.properties?.sheetId;
  const referenceRowCount = referenceSheet?.properties?.gridProperties?.rowCount;
  const categoryNamedRanges = (metadata.data.namedRanges || []).filter((range) => range.name === REQUEST_CATEGORY_NAMED_RANGE);
  const namedRangeTargets = categoryNamedRanges.map((namedRange) => ({
    sheetId: namedRange.range?.sheetId ?? null,
    startRowIndex: namedRange.range?.startRowIndex ?? null,
    endRowIndex: namedRange.range?.endRowIndex ?? null,
    startColumnIndex: namedRange.range?.startColumnIndex ?? null,
    endColumnIndex: namedRange.range?.endColumnIndex ?? null,
  }));
  const namedRange = {
    present: categoryNamedRanges.length === 1,
    valid: categoryNamedRanges.length === 1 && isExpectedCategoryNamedRange(categoryNamedRanges[0], referenceSheetId, referenceRowCount),
    count: categoryNamedRanges.length,
    referenceSheetId: referenceSheetId ?? null,
    referenceRowCount: referenceRowCount ?? null,
    targets: namedRangeTargets,
  };
  if (reference.present && !reference.valid) ambiguities.push(`${REFERENCE_SHEET}: unexpected header`);
  if (categoryNamedRanges.length > 1) ambiguities.push(`Duplicate named range: ${REQUEST_CATEGORY_NAMED_RANGE}`);
  if (categoryNamedRanges.length === 1 && !namedRange.valid) ambiguities.push(`Named range has unexpected target: ${REQUEST_CATEGORY_NAMED_RANGE}`);
  const needsMigration = sheets.some((sheet) => sheet.layout === "legacy")
    || sheets.some((sheet) => sheet.layout === "category" && !sheet.stats.validationPresent)
    || !reference.present
    || !reference.valid
    || !namedRange.valid
    || INITIAL_REQUEST_CATEGORIES.some((category) => !reference.categories.includes(category));
  return {
    spreadsheetId: file.id,
    name: file.name,
    parents: file.parents || [],
    sheets,
    reference,
    namedRange,
    ambiguities,
    needsMigration,
  };
}

function attachMigrationStage(error, stage) {
  if (error && typeof error === "object" && !error.migrationStage) error.migrationStage = stage;
  throw error;
}

function migrationFailure(code, message, stage) {
  return Object.assign(new Error(message), {
    code,
    migrationStage: stage,
    migrationSafeToLog: true,
  });
}

async function migrationOperation(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    attachMigrationStage(error, stage);
  }
}

function captureWorkingSheet(sheetReport, sheet) {
  const rows = usedRows(sheet);
  const idIndex = sheetReport.semanticLayout.applicationIdIndex;
  return {
    layout: sheetReport.layout,
    rowContents: rows.map((row) => (row?.values || []).map(contentSignature)),
    ids: rows.slice(1).map((row) => cellText(row?.values?.[idIndex]).trim()).filter((value) => APPLICATION_ID_PATTERN.test(value) || DETAIL_ROW_PATTERN.test(value)),
    stats: sheetReport.stats,
  };
}

async function readVerificationSnapshot(file, report, sheetsApi) {
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId: file.id,
    ranges: REQUEST_SHEETS.map((title) => `${quoteSheet(title)}!A1:Z`),
    includeGridData: true,
    fields: "sheets(properties(sheetId,title),data(rowData(values(userEnteredValue,formattedValue,textFormatRuns,dataValidation))),basicFilter,filterViews,protectedRanges,rowGroups)",
  });
  const byTitle = new Map((response.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));
  return Object.fromEntries(report.sheets.map((sheetReport) => [sheetReport.title, captureWorkingSheet(sheetReport, byTitle.get(sheetReport.title))]));
}

function withoutCategory(row) {
  return [row?.[0] || "", ...(row || []).slice(2)];
}

function verifyMigration(before, afterReport, afterSnapshot) {
  for (const beforeSheet of before.report.sheets) {
    const afterSheet = afterReport.sheets.find((sheet) => sheet.title === beforeSheet.title);
    if (afterSheet?.layout !== "category") throw migrationFailure("MIGRATION_LAYOUT_VERIFICATION_FAILED", `${beforeSheet.title}: category layout verification failed`, "verify_preserved_content");
    const previous = before.snapshot[beforeSheet.title];
    const current = afterSnapshot[beforeSheet.title];
    if (JSON.stringify(previous.ids) !== JSON.stringify(current.ids)) throw migrationFailure("MIGRATION_ID_SEQUENCE_CHANGED", `${beforeSheet.title}: ID/detail sequence changed during migration`, "verify_preserved_content");
    const previousRows = previous.layout === "legacy" ? previous.rowContents : previous.rowContents.map(withoutCategory);
    const currentRows = current.rowContents.map(withoutCategory);
    if (JSON.stringify(previousRows) !== JSON.stringify(currentRows)) throw migrationFailure("MIGRATION_CONTENT_CHANGED", `${beforeSheet.title}: cell values or rich-text links changed during migration`, "verify_preserved_content");
    for (const key of ["masterRows", "detailRows", "richTextLinks", "formulas", "protectedRanges", "rowGroups", "filters"]) {
      if (previous.stats[key] !== current.stats[key]) throw migrationFailure("MIGRATION_STRUCTURE_CHANGED", `${beforeSheet.title}: ${key} changed during migration`, "verify_preserved_content");
    }
  }
}

async function createAndVerifyBackup(file, drive, sheetsApi) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const response = await drive.files.copy({
    fileId: file.id,
    requestBody: { name: `${file.name} — backup-before-category-${stamp}`, parents: file.parents },
    fields: "id,name,mimeType,parents",
    supportsAllDrives: true,
  });
  const backupId = response.data.id;
  if (!backupId) throw new Error("Google Drive did not return a backup file ID");
  const verified = await drive.files.get({ fileId: backupId, fields: "id,name,mimeType,parents,trashed", supportsAllDrives: true });
  if (verified.data.trashed || verified.data.mimeType !== SPREADSHEET_MIME || verified.data.id !== backupId) throw new Error("Spreadsheet backup verification failed");
  const spreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: backupId, includeGridData: false, fields: "spreadsheetId,sheets(properties(sheetId,title))" });
  if (spreadsheet.data.spreadsheetId !== backupId || (spreadsheet.data.sheets || []).length < REQUEST_SHEETS.length) {
    throw new Error("Spreadsheet backup content verification failed");
  }
  return { id: backupId, name: verified.data.name };
}

async function withSpreadsheetWriterLeases(report, operation, leaseServices) {
  const targets = report.sheets.map((sheet) => sheet.sheetId).filter(Number.isInteger).sort((a, b) => a - b);
  if (targets.length !== REQUEST_SHEETS.length) throw migrationFailure("MIGRATION_SHEETS_MISSING", "Cannot lock spreadsheet with missing request sheets", "writer_lease_prepare");
  const assertions = [];
  const acquire = async (index) => {
    if (index === targets.length) return operation(async () => { for (const assertOwnership of assertions) await assertOwnership(); });
    return runWithSheetWriteLease(report.spreadsheetId, targets[index], async (assertOwnership) => {
      assertions.push(assertOwnership);
      try { return await acquire(index + 1); }
      finally { assertions.pop(); }
    }, leaseServices);
  };
  return acquire(0);
}

async function ensureReferenceSheet(report, sheetsApi, assertOwnership) {
  let sheet = report.reference.present ? { properties: { title: REFERENCE_SHEET } } : null;
  if (!sheet) {
    await assertOwnership();
    const response = await migrationOperation("create_reference_sheet", () => sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: report.spreadsheetId,
      requestBody: { requests: [{ addSheet: { properties: { title: REFERENCE_SHEET } } }] },
    }));
    await assertOwnership();
    sheet = response.data.replies?.[0]?.addSheet;
  }
  if (report.reference.present && !report.reference.valid) throw migrationFailure("MIGRATION_REFERENCE_INVALID", `${REFERENCE_SHEET}: unexpected header`, "ensure_reference_sheet");
  const categories = [...report.reference.categories];
  for (const category of INITIAL_REQUEST_CATEGORIES) if (!categories.includes(category)) categories.push(category);
  await assertOwnership();
  await migrationOperation("update_reference_categories", () => sheetsApi.spreadsheets.values.update({
    spreadsheetId: report.spreadsheetId,
    range: `${quoteSheet(REFERENCE_SHEET)}!A1:A${categories.length + 1}`,
    valueInputOption: "RAW",
    requestBody: { values: [["Категорія запиту"], ...categories.map((category) => [category])] },
  }));
  await assertOwnership();
}

async function ensureCategoryNamedRange(report, sheetsApi, assertOwnership) {
  if (report.namedRange.valid) return;
  if (report.namedRange.count) throw migrationFailure("MIGRATION_NAMED_RANGE_INVALID", `Named range has unexpected target: ${REQUEST_CATEGORY_NAMED_RANGE}`, "ensure_category_named_range");
  if (!Number.isInteger(report.reference.sheetId)) throw migrationFailure("MIGRATION_REFERENCE_ID_MISSING", "Reference sheet ID is missing", "ensure_category_named_range");
  await assertOwnership();
  await migrationOperation("create_category_named_range", () => sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: report.spreadsheetId,
    requestBody: { requests: [categoryNamedRangeRequest(report.reference.sheetId)] },
  }));
  await assertOwnership();
}

async function migrateSpreadsheet(file, initialReport, { sheetsApi, drive, leaseServices }) {
  if (initialReport.ambiguities.length) throw migrationFailure("MIGRATION_STRUCTURE_AMBIGUOUS", `Migration blocked: ${initialReport.ambiguities.join("; ")}`, "validate_initial_structure");
  if (!initialReport.needsMigration) return { ...initialReport, result: "already_migrated", backup: null };

  return migrationOperation("writer_lease_lifecycle", () => withSpreadsheetWriterLeases(initialReport, async (assertOwnership) => {
    await assertOwnership();
    const report = await inspectMonthlySpreadsheet(file, { sheetsApi });
    await assertOwnership();
    if (report.ambiguities.length) throw migrationFailure("MIGRATION_STRUCTURE_AMBIGUOUS", `Migration blocked after lock: ${report.ambiguities.join("; ")}`, "validate_locked_structure");
    const before = { report, snapshot: await readVerificationSnapshot(file, report, sheetsApi) };
    await assertOwnership();
    const backup = await migrationOperation("create_and_verify_backup", () => createAndVerifyBackup(file, drive, sheetsApi));
    await assertOwnership();

    for (const sheet of report.sheets) {
      if (sheet.layout !== "legacy") continue;
      await migrationOperation(`insert_category_column:${sheet.title}`, () => sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: file.id,
        requestBody: { requests: [{ insertDimension: { range: { sheetId: sheet.sheetId, dimension: "COLUMNS", startIndex: 1, endIndex: 2 }, inheritFromBefore: false } }] },
      }));
      await assertOwnership();
      await migrationOperation(`write_category_header:${sheet.title}`, () => sheetsApi.spreadsheets.values.update({ spreadsheetId: file.id, range: `${quoteSheet(sheet.title)}!B1`, valueInputOption: "RAW", requestBody: { values: [["Категорія запиту"]] } }));
      await assertOwnership();
    }

    await ensureReferenceSheet(report, sheetsApi, assertOwnership);
    let lockedReport = await migrationOperation("inspect_post_insert", () => inspectMonthlySpreadsheet(file, { sheetsApi }));
    if (lockedReport.ambiguities.length) throw migrationFailure("MIGRATION_STRUCTURE_AMBIGUOUS", `Post-insert structure is ambiguous: ${lockedReport.ambiguities.join("; ")}`, "validate_post_insert_structure");
    await ensureCategoryNamedRange(lockedReport, sheetsApi, assertOwnership);
    lockedReport = await migrationOperation("verify_category_named_range", () => inspectMonthlySpreadsheet(file, { sheetsApi }));
    if (!lockedReport.namedRange.valid) throw migrationFailure("MIGRATION_NAMED_RANGE_VERIFICATION_FAILED", "Category named range verification failed", "verify_category_named_range");
    const clearRequests = lockedReport.sheets.map((sheet) => clearCategoryValidationRequest(sheet.sheetId));
    const validationRequests = lockedReport.sheets.map((sheet) => categoryValidationRequest(sheet.sheetId));
    await assertOwnership();
    await migrationOperation("clear_category_validation", () => sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: file.id, requestBody: { requests: clearRequests } }));
    await assertOwnership();
    await migrationOperation("set_category_validation", () => sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: file.id, requestBody: { requests: validationRequests } }));
    await assertOwnership();

    const afterReport = await migrationOperation("inspect_post_migration", () => inspectMonthlySpreadsheet(file, { sheetsApi }));
    const afterSnapshot = await migrationOperation("read_post_migration_snapshot", () => readVerificationSnapshot(file, afterReport, sheetsApi));
    verifyMigration(before, afterReport, afterSnapshot);
    if (!afterReport.reference.valid || INITIAL_REQUEST_CATEGORIES.some((category) => !afterReport.reference.categories.includes(category))) {
      throw migrationFailure("MIGRATION_REFERENCE_VERIFICATION_FAILED", "Reference sheet verification failed", "verify_reference_sheet");
    }
    if (afterReport.sheets.some((sheet) => !sheet.stats.validationPresent)) throw migrationFailure("MIGRATION_VALIDATION_VERIFICATION_FAILED", "Category validation verification failed", "verify_category_validation");
    return { ...afterReport, result: "migrated", backup };
  }, leaseServices));
}

export async function runCategoryMigration({ mode = "dry-run", spreadsheetId, services = {} } = {}) {
  if (!new Set(["dry-run", "apply"]).has(mode)) throw new Error("Mode must be dry-run or apply");
  const drive = services.drive || getDrive();
  const sheetsApi = services.sheetsApi || sheetsClient();
  const rootFolderId = services.rootFolderId || getGoogleConfig().rootFolderId;
  const files = await migrationOperation("list_monthly_spreadsheets", () => listMonthlySpreadsheets({ drive, rootFolderId, spreadsheetId }));
  const results = [];
  for (const file of files) {
    const report = await migrationOperation("inspect_initial_spreadsheet", () => inspectMonthlySpreadsheet(file, { sheetsApi }));
    if (mode === "dry-run") results.push({ ...report, result: report.ambiguities.length ? "blocked" : report.needsMigration ? "would_migrate" : "already_migrated" });
    else results.push(await migrationOperation("migrate_spreadsheet", () => migrateSpreadsheet(file, report, { sheetsApi, drive, leaseServices: services.leaseServices })));
  }
  return { mode, spreadsheetCount: files.length, results };
}

export function formatMigrationReport(report) {
  const lines = [`Mode: ${report.mode}`, `Monthly spreadsheets: ${report.spreadsheetCount}`];
  for (const item of report.results) {
    lines.push(`\n${item.name} (${item.spreadsheetId}) — ${item.result}`);
    for (const sheet of item.sheets) {
      const stats = sheet.stats;
      lines.push(`  ${sheet.title}: ${sheet.layout}; master=${stats?.masterRows ?? 0}; detail=${stats?.detailRows ?? 0}; misplaced=${stats?.misplacedIds ?? 0}; links=${stats?.richTextLinks ?? 0}; formulas=${stats?.formulas ?? 0}; filters=${stats?.filters ?? 0}; protected=${stats?.protectedRanges ?? 0}; groups=${stats?.rowGroups ?? 0}`);
    }
    lines.push(`  ${REFERENCE_SHEET}: ${item.reference.present ? item.reference.valid ? "valid" : "invalid" : "missing"}; categories=${item.reference.categories.length}`);
    for (const ambiguity of item.ambiguities) lines.push(`  BLOCKED: ${ambiguity}`);
    if (item.backup) lines.push(`  Backup: ${item.backup.name} (${item.backup.id})`);
  }
  return lines.join("\n");
}
