import { google } from "googleapis";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUIRED_SHEET_TITLES = ["Фізособи", "Військові частини"];
const UKRAINE_TIME_ZONE = "Europe/Kyiv";
export const DEFAULT_REQUEST_STATUS = "Новий";

const OPERATOR_SHEET_LAYOUTS = {
  "Фізособи": {
    lastColumn: "O",
    headers: ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ", "Телефон", "Паспорт", "РНОКПП", "Військовий документ", "УБД", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"],
  },
  "Військові частини": {
    lastColumn: "M",
    headers: ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ відповідальної особи", "Телефон", "Номер ВЧ", "Офіційний запит", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"],
  },
};

function getSheets() {
  return google.sheets({ version: "v4", auth: getGoogleAuth() });
}

export function getCurrentMonthSpreadsheetName(now = new Date()) {
  const parts = new Intl.DateTimeFormat("uk-UA", {
    timeZone: UKRAINE_TIME_ZONE,
    month: "long",
    year: "numeric",
  }).formatToParts(now);
  const month = parts.find((part) => part.type === "month")?.value;
  const year = parts.find((part) => part.type === "year")?.value;

  if (!month || !year) throw new Error("Unable to determine the current Ukrainian month");
  return `Запити-${month.toLocaleLowerCase("uk-UA")}-${year}`;
}

async function findSpreadsheet(name, parentId) {
  const drive = getDrive();
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${name}' and mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
    fields: "files(id,name,mimeType,parents)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0] || null;
}

async function removeUnexpectedDefaultSheets(spreadsheetId, sheets) {
  const existing = sheets || [];
  const titles = new Set(existing.map((sheet) => sheet.properties?.title));
  const requests = REQUIRED_SHEET_TITLES
    .filter((title) => !titles.has(title))
    .map((title) => ({ addSheet: { properties: { title } } }));

  for (const sheet of existing) {
    const title = sheet.properties?.title;
    const sheetId = sheet.properties?.sheetId;
    if (!REQUIRED_SHEET_TITLES.includes(title) && Number.isInteger(sheetId)) {
      requests.push({ deleteSheet: { sheetId } });
    }
  }

  if (!requests.length) return;
  const sheetsApi = getSheets();
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function moveSpreadsheetToRootFolder(spreadsheetId, rootFolderId) {
  const drive = getDrive();
  const metadata = await drive.files.get({
    fileId: spreadsheetId,
    fields: "parents",
    supportsAllDrives: true,
  });
  const previousParents = metadata.data.parents?.join(",");

  await drive.files.update({
    fileId: spreadsheetId,
    addParents: rootFolderId,
    removeParents: previousParents || undefined,
    fields: "id,name,parents",
    supportsAllDrives: true,
  });
}

function sheetRange(title, range) {
  return `'${title}'!${range}`;
}

function rowsMatchHeaders(actual, expected) {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function valueOrEmpty(value) {
  return value ?? "";
}

function formatConfirmedAt(confirmedAt) {
  const date = new Date(confirmedAt);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid confirmation timestamp");
  const parts = new Intl.DateTimeFormat("uk-UA", {
    timeZone: UKRAINE_TIME_ZONE,
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.day}.${values.month}.${values.year}`;
}

export function serializeDocuments(files) {
  return buildDocumentRichText(files).text;
}

export function buildDocumentRichText(files) {
  if (!Array.isArray(files) || !files.length) return { text: "", textFormatRuns: [] };

  let text = "";
  const textFormatRuns = [];
  files.forEach((file, index) => {
    if (index > 0) text += "\n";
    const startIndex = text.length;
    text += file.fileName || "Файл";
    if (file.driveUrl) textFormatRuns.push({ startIndex, format: { link: { uri: file.driveUrl } } });
    if (index < files.length - 1) textFormatRuns.push({ startIndex: text.length, format: {} });
  });

  return { text, textFormatRuns };
}

function recipientValues(data) {
  const anotherRecipient = data.recipientAnotherPerson === true;
  return [
    anotherRecipient ? "Так" : "Ні",
    anotherRecipient ? valueOrEmpty(data.recipientName) : "",
    anotherRecipient ? valueOrEmpty(data.recipientPhone) : "",
  ];
}

function buildPhysicalPersonRow(request, applicationId, confirmedAt) {
  const data = request.data || {};
  const documents = request.documents || {};
  return [
    DEFAULT_REQUEST_STATUS,
    applicationId,
    formatConfirmedAt(confirmedAt),
    valueOrEmpty(data.need),
    valueOrEmpty(data.name),
    valueOrEmpty(data.phone),
    serializeDocuments(documents.passport),
    serializeDocuments(documents.rnokpp),
    serializeDocuments(documents.military_id),
    serializeDocuments(documents.ubd),
    valueOrEmpty(data.city),
    valueOrEmpty(data.novaPoshtaBranch),
    ...recipientValues(data),
  ];
}

function buildMilitaryUnitRow(request, applicationId, confirmedAt) {
  const data = request.data || {};
  const documents = request.documents || {};
  return [
    DEFAULT_REQUEST_STATUS,
    applicationId,
    formatConfirmedAt(confirmedAt),
    valueOrEmpty(data.need),
    valueOrEmpty(data.name),
    valueOrEmpty(data.phone),
    valueOrEmpty(data.militaryUnitNumber),
    serializeDocuments(documents.official_request),
    valueOrEmpty(data.city),
    valueOrEmpty(data.novaPoshtaBranch),
    ...recipientValues(data),
  ];
}

async function spreadsheetAlreadyHasApplicationId(sheetsApi, spreadsheetId, sheetTitle, applicationId) {
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(sheetTitle, "B2:B"),
  });
  return (response.data.values || []).some((row) => row[0] === applicationId);
}

function getAppendedRowNumber(updatedRange) {
  const match = typeof updatedRange === "string" && updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
  if (!match || match[1] !== match[2]) throw new Error(`Unable to determine appended row from range: ${updatedRange || "missing"}`);
  return Number(match[1]);
}

async function getSheetId(sheetsApi, spreadsheetId, sheetTitle) {
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const sheet = (response.data.sheets || []).find((item) => item.properties?.title === sheetTitle);
  const sheetId = sheet?.properties?.sheetId;
  if (!Number.isInteger(sheetId)) throw new Error(`Unable to find sheet ID for: ${sheetTitle}`);
  return sheetId;
}

async function applyDocumentRichText(sheetsApi, spreadsheetId, sheetTitle, rowNumber, documentCells) {
  const cellsWithDocuments = documentCells.filter(({ richText }) => richText.text);
  if (!cellsWithDocuments.length) return;

  const sheetId = await getSheetId(sheetsApi, spreadsheetId, sheetTitle);
  const requests = cellsWithDocuments.map(({ columnIndex, richText }) => ({
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: columnIndex,
        endColumnIndex: columnIndex + 1,
      },
      rows: [{ values: [{
        userEnteredValue: { stringValue: richText.text },
        textFormatRuns: richText.textFormatRuns,
      }] }],
      fields: "userEnteredValue,textFormatRuns",
    },
  }));
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

export async function appendConfirmedRequest(request, applicationId, confirmedAt) {
  const spreadsheet = await getOrCreateCurrentMonthSpreadsheet();
  const sheetsApi = getSheets();
  const isMilitaryUnit = request.type === "military_unit";
  const sheetTitle = isMilitaryUnit ? "Військові частини" : "Фізособи";
  const row = isMilitaryUnit
    ? buildMilitaryUnitRow(request, applicationId, confirmedAt)
    : buildPhysicalPersonRow(request, applicationId, confirmedAt);
  const documents = request.documents || {};
  const documentCells = isMilitaryUnit
    ? [{ columnIndex: 7, richText: buildDocumentRichText(documents.official_request) }]
    : [
        { columnIndex: 6, richText: buildDocumentRichText(documents.passport) },
        { columnIndex: 7, richText: buildDocumentRichText(documents.rnokpp) },
        { columnIndex: 8, richText: buildDocumentRichText(documents.military_id) },
        { columnIndex: 9, richText: buildDocumentRichText(documents.ubd) },
      ];

  if (await spreadsheetAlreadyHasApplicationId(sheetsApi, spreadsheet.spreadsheetId, sheetTitle, applicationId)) {
    return { spreadsheetId: spreadsheet.spreadsheetId, sheetTitle, existing: true };
  }

  const response = await sheetsApi.spreadsheets.values.append({
    spreadsheetId: spreadsheet.spreadsheetId,
    range: sheetRange(sheetTitle, isMilitaryUnit ? "A:M" : "A:O"),
    valueInputOption: "RAW",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });
  const updatedRange = response.data.updates?.updatedRange;
  await applyDocumentRichText(
    sheetsApi,
    spreadsheet.spreadsheetId,
    sheetTitle,
    getAppendedRowNumber(updatedRange),
    documentCells,
  );
  return { spreadsheetId: spreadsheet.spreadsheetId, sheetTitle, existing: false, updatedRange: updatedRange || null };
}

async function addHeadersIfSheetIsEmpty(sheetsApi, spreadsheetId, title, layout) {
  const valuesResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(title, `A1:${layout.lastColumn}`),
  });
  const hasData = (valuesResponse.data.values || []).some((row) => row.some((value) => value !== ""));
  if (hasData) return false;

  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(title, "A1"),
    valueInputOption: "RAW",
    requestBody: { values: [layout.headers] },
  });
  return true;
}

async function ensureOperatorSheetStructure(spreadsheetId) {
  const sheetsApi = getSheets();
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,sheetType))",
  });
  const sheetsByTitle = new Map((metadata.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));

  for (const [title, layout] of Object.entries(OPERATOR_SHEET_LAYOUTS)) {
    if (!sheetsByTitle.has(title)) throw new Error(`Required sheet is missing: ${title}`);
    await addHeadersIfSheetIsEmpty(sheetsApi, spreadsheetId, title, layout);
  }

  const requests = REQUIRED_SHEET_TITLES.map((title) => ({
    updateSheetProperties: {
      properties: {
        sheetId: sheetsByTitle.get(title).properties.sheetId,
        gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
      },
      fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
    },
  }));
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

export async function getOrCreateCurrentMonthSpreadsheet() {
  const { rootFolderId } = getGoogleConfig();
  const name = getCurrentMonthSpreadsheetName();
  const existing = await findSpreadsheet(name, rootFolderId);
  if (existing) {
    await ensureOperatorSheetStructure(existing.id);
    return { spreadsheetId: existing.id, name: existing.name, created: false };
  }

  const sheetsApi = getSheets();
  const created = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: { title: name, locale: "uk_UA", timeZone: UKRAINE_TIME_ZONE },
      sheets: REQUIRED_SHEET_TITLES.map((title) => ({ properties: { title } })),
    },
    fields: "spreadsheetId,properties.title,sheets.properties",
  });
  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Google Sheets did not return a spreadsheet ID");

  await removeUnexpectedDefaultSheets(spreadsheetId, created.data.sheets);
  await moveSpreadsheetToRootFolder(spreadsheetId, rootFolderId);
  await ensureOperatorSheetStructure(spreadsheetId);
  return { spreadsheetId, name: created.data.properties?.title || name, created: true };
}

export async function testCurrentMonthSpreadsheetAccess() {
  const spreadsheet = await getOrCreateCurrentMonthSpreadsheet();
  const sheetsApi = getSheets();
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId: spreadsheet.spreadsheetId,
    fields: "spreadsheetId,properties(title,locale,timeZone),sheets(properties(sheetId,title,index))",
  });
  const sheetTitles = response.data.sheets?.map((sheet) => sheet.properties?.title).filter(Boolean) || [];
  const missingSheetTitles = REQUIRED_SHEET_TITLES.filter((title) => !sheetTitles.includes(title));
  const headerRanges = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: spreadsheet.spreadsheetId,
    ranges: [sheetRange("Фізособи", "A1:O1"), sheetRange("Військові частини", "A1:M1")],
  });
  const [physicalHeaderRange, militaryHeaderRange] = headerRanges.data.valueRanges || [];
  const physicalHeaders = physicalHeaderRange?.values?.[0] || [];
  const militaryHeaders = militaryHeaderRange?.values?.[0] || [];

  return {
    success: missingSheetTitles.length === 0,
    created: spreadsheet.created,
    spreadsheetId: response.data.spreadsheetId || spreadsheet.spreadsheetId,
    name: response.data.properties?.title || spreadsheet.name,
    timeZone: response.data.properties?.timeZone || null,
    sheets: sheetTitles,
    missingSheetTitles,
    physicalHeaders,
    militaryHeaders,
    physicalHeadersHaveData: physicalHeaders.some((value) => value !== ""),
    militaryHeadersHaveData: militaryHeaders.some((value) => value !== ""),
    physicalHeadersMatch: rowsMatchHeaders(physicalHeaders, OPERATOR_SHEET_LAYOUTS["Фізособи"].headers),
    militaryHeadersMatch: rowsMatchHeaders(militaryHeaders, OPERATOR_SHEET_LAYOUTS["Військові частини"].headers),
  };
}
