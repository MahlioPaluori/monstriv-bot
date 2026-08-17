import { google } from "googleapis";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUIRED_SHEET_TITLES = ["Фізособи", "Військові частини"];
const UKRAINE_TIME_ZONE = "Europe/Kyiv";
export const DEFAULT_REQUEST_STATUS = "Нова";
const REQUEST_STATUS_OPTIONS = ["Нова", "В роботі", "Зібрано", "Відхилено"];
const REQUEST_STATUS_FORMATS = [
  { status: "Нова", backgroundColor: { red: 0.82, green: 0.91, blue: 0.98 } },
  { status: "В роботі", backgroundColor: { red: 1, green: 0.95, blue: 0.7 } },
  { status: "Зібрано", backgroundColor: { red: 0.8, green: 0.94, blue: 0.82 } },
  { status: "Відхилено", backgroundColor: { red: 1, green: 0.8, blue: 0.8 } },
];

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

const REQUEST_SHEET_CONFIGS = [
  { title: "Фізособи", type: "individual", lastColumn: "O" },
  { title: "Військові частини", type: "military_unit", lastColumn: "M" },
];

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

function monthlySpreadsheetNamesForYears(years) {
  return new Set(years.flatMap((year) => Array.from(
    { length: 12 },
    (_, month) => getCurrentMonthSpreadsheetName(new Date(Date.UTC(year, month, 15, 12))),
  )));
}

async function findMonthlySpreadsheetsForApplicationId(applicationId) {
  const year = Number(applicationId.slice(0, 4));
  const names = monthlySpreadsheetNamesForYears([year, year + 1]);
  const { rootFolderId } = getGoogleConfig();
  const drive = getDrive();
  const files = [];
  let pageToken;

  do {
    const response = await drive.files.list({
      q: `'${rootFolderId}' in parents and mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
      fields: "nextPageToken,files(id,name,mimeType,parents)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    files.push(...(response.data.files || []).filter((file) => file.name && names.has(file.name)));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function findApplicationRowsInSpreadsheet(sheetsApi, spreadsheetId, applicationId) {
  const response = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges: REQUEST_SHEET_CONFIGS.map(({ title }) => sheetRange(title, "B2:B")),
  });
  const matches = [];
  REQUEST_SHEET_CONFIGS.forEach((config, index) => {
    const values = response.data.valueRanges?.[index]?.values || [];
    values.forEach((row, rowOffset) => {
      if (row[0] === applicationId) matches.push({ ...config, rowNumber: rowOffset + 2 });
    });
  });
  return matches;
}

function normalizeRequestRow(type, row) {
  const values = Array.from({ length: type === "individual" ? 15 : 13 }, (_, index) => valueOrEmpty(row[index]));
  const isIndividual = type === "individual";
  const personName = values[4];
  const mainPhone = values[5];
  const anotherRecipient = values[isIndividual ? 12 : 10];
  const recipientName = values[isIndividual ? 13 : 11];
  const recipientPhone = values[isIndividual ? 14 : 12];
  let actualRecipientName;
  let actualRecipientPhone;

  if (anotherRecipient === "Так") {
    actualRecipientName = recipientName;
    actualRecipientPhone = recipientPhone;
  } else if (anotherRecipient === "Ні") {
    actualRecipientName = personName;
    actualRecipientPhone = mainPhone;
  } else {
    return null;
  }

  return {
    type,
    applicationId: values[1],
    date: values[2],
    need: values[3],
    personName,
    mainPhone,
    militaryUnitNumber: isIndividual ? "" : values[6],
    city: values[isIndividual ? 10 : 8],
    novaPoshtaBranch: values[isIndividual ? 11 : 9],
    actualRecipientName,
    actualRecipientPhone,
  };
}

export async function findRequestByApplicationId(applicationId) {
  const spreadsheets = await findMonthlySpreadsheetsForApplicationId(applicationId);
  const sheetsApi = getSheets();
  const matches = [];

  for (const spreadsheet of spreadsheets) {
    const rows = await findApplicationRowsInSpreadsheet(sheetsApi, spreadsheet.id, applicationId);
    matches.push(...rows.map((row) => ({ ...row, spreadsheetId: spreadsheet.id })));
  }

  if (!matches.length) return { result: "not_found" };
  if (matches.length > 1) return { result: "duplicate" };

  const match = matches[0];
  const rowResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: match.spreadsheetId,
    range: sheetRange(match.title, `A${match.rowNumber}:${match.lastColumn}${match.rowNumber}`),
  });
  const request = normalizeRequestRow(match.type, rowResponse.data.values?.[0] || []);
  if (!request || request.applicationId !== applicationId) return { result: "invalid_data" };
  return { result: "found", request };
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

function statusColumnRange(sheetId) {
  return { sheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 };
}

function isStatusColumnRange(range, sheetId) {
  return range?.sheetId === sheetId
    && range.startRowIndex === 1
    && range.startColumnIndex === 0
    && range.endColumnIndex === 1
    && range.endRowIndex === undefined;
}

function hasStatusConditionalFormat(sheet, status) {
  const sheetId = sheet.properties?.sheetId;
  return (sheet.conditionalFormats || []).some((rule) => {
    const condition = rule.booleanRule?.condition;
    return rule.ranges?.some((range) => isStatusColumnRange(range, sheetId))
      && condition?.type === "TEXT_EQ"
      && condition.values?.some((value) => value.userEnteredValue === status);
  });
}

function statusValidationRequest(sheetId) {
  return {
    setDataValidation: {
      range: statusColumnRange(sheetId),
      rule: {
        condition: {
          type: "ONE_OF_LIST",
          values: REQUEST_STATUS_OPTIONS.map((status) => ({ userEnteredValue: status })),
        },
        strict: true,
        showCustomUi: true,
      },
    },
  };
}

function missingStatusConditionalFormatRequests(sheet) {
  const sheetId = sheet.properties?.sheetId;
  let index = (sheet.conditionalFormats || []).length;
  return REQUEST_STATUS_FORMATS
    .filter(({ status }) => !hasStatusConditionalFormat(sheet, status))
    .map(({ status, backgroundColor }) => ({
      addConditionalFormatRule: {
        rule: {
          ranges: [statusColumnRange(sheetId)],
          booleanRule: {
            condition: { type: "TEXT_EQ", values: [{ userEnteredValue: status }] },
            format: { backgroundColor },
          },
        },
        index: index++,
      },
    }));
}

async function ensureOperatorSheetStructure(spreadsheetId) {
  const sheetsApi = getSheets();
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,sheetType),conditionalFormats)",
  });
  const sheetsByTitle = new Map((metadata.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));

  for (const [title, layout] of Object.entries(OPERATOR_SHEET_LAYOUTS)) {
    if (!sheetsByTitle.has(title)) throw new Error(`Required sheet is missing: ${title}`);
    await addHeadersIfSheetIsEmpty(sheetsApi, spreadsheetId, title, layout);
  }

  const requests = REQUIRED_SHEET_TITLES.flatMap((title) => {
    const sheet = sheetsByTitle.get(title);
    const sheetId = sheet.properties.sheetId;
    return [
      {
        updateSheetProperties: {
          properties: {
            sheetId,
            gridProperties: { frozenRowCount: 1, frozenColumnCount: 1 },
          },
          fields: "gridProperties.frozenRowCount,gridProperties.frozenColumnCount",
        },
      },
      statusValidationRequest(sheetId),
      ...missingStatusConditionalFormatRequests(sheet),
    ];
  });
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
