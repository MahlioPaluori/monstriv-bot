import { google } from "googleapis";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUIRED_SHEET_TITLES = ["Фізособи", "Військові частини"];
const UKRAINE_TIME_ZONE = "Europe/Kyiv";
const APPLICATION_ID_PATTERN = /^\d{4}-\d{6,}$/;
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

function cellText(cell) {
  return String(valueOrEmpty(cell?.formattedValue ?? cell?.userEnteredValue?.stringValue));
}

function documentLinkAt(textFormatRuns, startIndex) {
  let activeFormat = {};
  for (const run of textFormatRuns || []) {
    if (!Number.isInteger(run?.startIndex) || run.startIndex > startIndex) break;
    activeFormat = run.format || {};
  }
  return activeFormat?.link?.uri || "";
}

function normalizeDocumentCell(cell) {
  const text = cellText(cell);
  if (!text) return [];

  const files = [];
  let startIndex = 0;
  for (const line of text.split("\n")) {
    const fileName = line.trim();
    if (fileName) {
      files.push({
        fileName,
        url: documentLinkAt(cell?.textFormatRuns, startIndex),
      });
    }
    startIndex += line.length + 1;
  }
  return files;
}

async function readIndividualMultiBeneficiaries(sheetsApi, match) {
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId: match.spreadsheetId,
    ranges: [sheetRange(match.title, `A${match.rowNumber + 1}:O`)],
    includeGridData: true,
    fields: "sheets(data(rowData(values(userEnteredValue,formattedValue,textFormatRuns))))",
  });
  const rows = response.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const beneficiaries = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex]?.values || [];
    const label = cellText(cells[1]);
    const expectedLabel = `Особа ${beneficiaries.length + 1}`;

    if (label !== expectedLabel) {
      if (/^Особа \d+$/.test(label)) return { result: "invalid_data" };
      break;
    }

    const beneficiary = {
      index: beneficiaries.length + 1,
      name: cellText(cells[4]).trim(),
      phone: cellText(cells[5]).trim(),
      documents: {
        passport: normalizeDocumentCell(cells[6]),
        rnokpp: normalizeDocumentCell(cells[7]),
        military_id: normalizeDocumentCell(cells[8]),
        ubd: normalizeDocumentCell(cells[9]),
      },
    };
    if (!beneficiary.name || !beneficiary.phone
      || !beneficiary.documents.passport.length
      || !beneficiary.documents.rnokpp.length
      || !beneficiary.documents.military_id.length) {
      return { result: "invalid_data" };
    }
    beneficiaries.push(beneficiary);
  }

  if (beneficiaries.length === 1) return { result: "invalid_data" };
  return beneficiaries.length ? { result: "found", beneficiaries } : { result: "single" };
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
  if (match.type === "individual") {
    const multi = await readIndividualMultiBeneficiaries(sheetsApi, match);
    if (multi.result === "invalid_data") return multi;
    if (multi.result === "found") {
      request.multiPackage = true;
      request.beneficiaries = multi.beneficiaries;
    }
  }
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

function buildMultiMasterRow(request, applicationId, confirmedAt) {
  const data = request.data || {};
  return [
    DEFAULT_REQUEST_STATUS,
    applicationId,
    formatConfirmedAt(confirmedAt),
    valueOrEmpty(data.need),
    valueOrEmpty(data.name),
    valueOrEmpty(data.phone),
    "", "", "", "",
    valueOrEmpty(data.city),
    valueOrEmpty(data.novaPoshtaBranch),
    ...recipientValues(data),
  ];
}

function buildMultiDetailRow(beneficiary, index) {
  const documents = beneficiary?.documents || {};
  return [
    "", `Особа ${index + 1}`, "", "",
    valueOrEmpty(beneficiary?.name),
    valueOrEmpty(beneficiary?.phone),
    serializeDocuments(documents.passport),
    serializeDocuments(documents.rnokpp),
    serializeDocuments(documents.military_id),
    serializeDocuments(documents.ubd),
    "", "", "", "", "",
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

async function findApplicationRowNumber(sheetsApi, spreadsheetId, sheetTitle, applicationId) {
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(sheetTitle, "B2:B"),
  });
  const rowOffset = (response.data.values || []).findIndex((row) => row[0] === applicationId);
  return rowOffset === -1 ? null : rowOffset + 2;
}

async function findApplicationRowNumbers(sheetsApi, spreadsheetId, sheetTitle, applicationId) {
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(sheetTitle, "B2:B"),
  });
  const matches = [];
  (response.data.values || []).forEach((row, rowOffset) => {
    if (row[0] === applicationId) matches.push(rowOffset + 2);
  });
  return matches;
}

function getAppendedRowNumber(updatedRange) {
  const match = typeof updatedRange === "string" && updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
  if (!match || match[1] !== match[2]) throw new Error(`Unable to determine appended row from range: ${updatedRange || "missing"}`);
  return Number(match[1]);
}

function getAppendedRowBlock(updatedRange, expectedRowCount) {
  const match = typeof updatedRange === "string" && updatedRange.match(/![A-Z]+(\d+):[A-Z]+(\d+)$/);
  if (!match) throw new Error(`Unable to determine appended rows from range: ${updatedRange || "missing"}`);
  const startRow = Number(match[1]);
  const endRow = Number(match[2]);
  if (endRow - startRow + 1 !== expectedRowCount) throw new Error("Appended multi row count does not match beneficiaries");
  return { masterRowNumber: startRow, firstDetailRowNumber: startRow + 1, lastDetailRowNumber: endRow };
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

function documentRichTextUpdates(sheetId, rowNumber, documents) {
  return [
    [6, documents?.passport],
    [7, documents?.rnokpp],
    [8, documents?.military_id],
    [9, documents?.ubd],
  ].flatMap(([columnIndex, files]) => {
    const richText = buildDocumentRichText(files);
    if (!richText.text) return [];
    return [{
      updateCells: {
        range: { sheetId, startRowIndex: rowNumber - 1, endRowIndex: rowNumber, startColumnIndex: columnIndex, endColumnIndex: columnIndex + 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: richText.text }, textFormatRuns: richText.textFormatRuns }] }],
        fields: "userEnteredValue,textFormatRuns",
      },
    }];
  });
}

async function buildRequestCardRichText(applicationId) {
  const { buildRequestCardUrl } = await import("../request-card.js");
  return {
    text: applicationId,
    textFormatRuns: [{ startIndex: 0, format: { link: { uri: buildRequestCardUrl(applicationId) } } }],
  };
}

function requestCardLinkUpdate(sheetId, rowNumber, richText) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: 1,
        endColumnIndex: 2,
      },
      rows: [{ values: [{
        userEnteredValue: { stringValue: richText.text },
        textFormatRuns: richText.textFormatRuns,
      }] }],
      fields: "userEnteredValue,textFormatRuns",
    },
  };
}

async function applyRequestCardLink(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId) {
  const sheetId = await getSheetId(sheetsApi, spreadsheetId, sheetTitle);
  const richText = await buildRequestCardRichText(applicationId);
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [requestCardLinkUpdate(sheetId, rowNumber, richText)] },
  });
}

async function applyRequestCardLinkSafely(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId) {
  try {
    await applyRequestCardLink(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId);
    return true;
  } catch (error) {
    console.error("Request card link formatting failed:", error?.message || "Unknown error");
    return false;
  }
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

  const existingRowNumber = await findApplicationRowNumber(sheetsApi, spreadsheet.spreadsheetId, sheetTitle, applicationId);
  if (existingRowNumber !== null) {
    await applyRequestCardLinkSafely(sheetsApi, spreadsheet.spreadsheetId, sheetTitle, existingRowNumber, applicationId);
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
  const rowNumber = getAppendedRowNumber(updatedRange);
  await applyDocumentRichText(
    sheetsApi,
    spreadsheet.spreadsheetId,
    sheetTitle,
    rowNumber,
    documentCells,
  );
  await applyRequestCardLinkSafely(sheetsApi, spreadsheet.spreadsheetId, sheetTitle, rowNumber, applicationId);
  return { spreadsheetId: spreadsheet.spreadsheetId, sheetTitle, existing: false, updatedRange: updatedRange || null };
}

async function ensureMultiDetailRows(sheetsApi, spreadsheetId, sheetId, masterRowNumber, beneficiaries) {
  const expectedLabels = beneficiaries.map((_, index) => `Особа ${index + 1}`);
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange("Фізособи", `B${masterRowNumber + 1}:B${masterRowNumber + beneficiaries.length + 1}`),
  });
  const existingLabels = Array.from({ length: beneficiaries.length + 1 }, (_, index) => response.data.values?.[index]?.[0] || "");
  let existingPrefix = 0;
  while (existingPrefix < expectedLabels.length && existingLabels[existingPrefix] === expectedLabels[existingPrefix]) existingPrefix += 1;
  if (existingPrefix === expectedLabels.length) {
    if (/^Особа \d+$/.test(existingLabels[expectedLabels.length])) throw new Error(`Unexpected extra multi detail row after request at row ${masterRowNumber}`);
    return;
  }
  if (/^Особа \d+$/.test(existingLabels[existingPrefix])) throw new Error(`Inconsistent multi detail block at row ${masterRowNumber + existingPrefix + 1}`);

  const missingRows = beneficiaries.length - existingPrefix;
  const insertionStartIndex = masterRowNumber + existingPrefix;
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{
      insertDimension: {
        range: { sheetId, dimension: "ROWS", startIndex: insertionStartIndex, endIndex: insertionStartIndex + missingRows },
        inheritFromBefore: false,
      },
    }] },
  });
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange("Фізособи", `A${masterRowNumber + existingPrefix + 1}`),
    valueInputOption: "RAW",
    requestBody: { values: beneficiaries.slice(existingPrefix).map((beneficiary, index) => buildMultiDetailRow(beneficiary, existingPrefix + index)) },
  });
}

async function ensureMultiRowGroup(sheetsApi, spreadsheetId, sheetId, firstDetailRowNumber, lastDetailRowNumber) {
  const targetRange = { sheetId, dimension: "ROWS", startIndex: firstDetailRowNumber - 1, endIndex: lastDetailRowNumber };
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId),rowGroups(range,depth,collapsed))",
  });
  const sheet = (metadata.data.sheets || []).find((item) => item.properties?.sheetId === sheetId);
  const rowGroups = sheet?.rowGroups || [];
  const exactGroup = rowGroups.find((group) => group.range?.startIndex === targetRange.startIndex && group.range?.endIndex === targetRange.endIndex);
  const overlapsTarget = rowGroups.some((group) => group.range?.startIndex < targetRange.endIndex && group.range?.endIndex > targetRange.startIndex);
  if (!exactGroup && overlapsTarget) throw new Error(`Conflicting row group for multi detail rows ${firstDetailRowNumber}-${lastDetailRowNumber}`);

  if (!exactGroup) {
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addDimensionGroup: { range: targetRange } }] } });
  }
  if (!exactGroup?.collapsed) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ updateDimensionGroup: { dimensionGroup: { range: targetRange, depth: exactGroup?.depth || 1, collapsed: true }, fields: "collapsed" } }] },
    });
  }
}

export async function appendConfirmedMultiRequest(request, applicationId, confirmedAt) {
  if (request.type !== "individual" || request.multiPackage !== true) throw new Error("Invalid individual multi request");
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  const beneficiaries = request.beneficiaries;
  if (!Array.isArray(beneficiaries) || beneficiaries.length < 2 || beneficiaries.length !== request.beneficiaryCount) throw new Error("Invalid multi beneficiaries");

  const spreadsheet = await getOrCreateCurrentMonthSpreadsheet();
  const sheetsApi = getSheets();
  const sheetTitle = "Фізособи";
  const sheetId = await getSheetId(sheetsApi, spreadsheet.spreadsheetId, sheetTitle);
  const existingMasterRows = await findApplicationRowNumbers(sheetsApi, spreadsheet.spreadsheetId, sheetTitle, applicationId);
  if (existingMasterRows.length > 1) throw new Error(`Duplicate multi request master row: ${applicationId}`);
  let masterRowNumber = existingMasterRows[0] || null;

  if (masterRowNumber === null) {
    const rows = [buildMultiMasterRow(request, applicationId, confirmedAt), ...beneficiaries.map(buildMultiDetailRow)];
    const response = await sheetsApi.spreadsheets.values.append({
      spreadsheetId: spreadsheet.spreadsheetId,
      range: sheetRange(sheetTitle, "A:O"),
      valueInputOption: "RAW",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: rows },
    });
    ({ masterRowNumber } = getAppendedRowBlock(response.data.updates?.updatedRange, rows.length));
  } else {
    await ensureMultiDetailRows(sheetsApi, spreadsheet.spreadsheetId, sheetId, masterRowNumber, beneficiaries);
    if (request.sheetsRecorded !== true) {
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId: spreadsheet.spreadsheetId,
        range: sheetRange(sheetTitle, `A${masterRowNumber}`),
        valueInputOption: "RAW",
        requestBody: { values: [buildMultiMasterRow(request, applicationId, confirmedAt), ...beneficiaries.map(buildMultiDetailRow)] },
      });
    }
  }

  const firstDetailRowNumber = masterRowNumber + 1;
  const lastDetailRowNumber = masterRowNumber + beneficiaries.length;
  const masterRichText = await buildRequestCardRichText(applicationId);
  const formattingRequests = [
    requestCardLinkUpdate(sheetId, masterRowNumber, masterRichText),
    ...beneficiaries.map((_, index) => ({
      updateCells: {
        range: { sheetId, startRowIndex: firstDetailRowNumber + index - 1, endRowIndex: firstDetailRowNumber + index, startColumnIndex: 1, endColumnIndex: 2 },
        rows: [{ values: [{ userEnteredValue: { stringValue: `Особа ${index + 1}` }, textFormatRuns: [] }] }],
        fields: "userEnteredValue,textFormatRuns",
      },
    })),
    ...beneficiaries.flatMap((beneficiary, index) => documentRichTextUpdates(sheetId, firstDetailRowNumber + index, beneficiary.documents)),
  ];
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId: spreadsheet.spreadsheetId, requestBody: { requests: formattingRequests } });
  await ensureMultiRowGroup(sheetsApi, spreadsheet.spreadsheetId, sheetId, firstDetailRowNumber, lastDetailRowNumber);
  return { spreadsheetId: spreadsheet.spreadsheetId, sheetTitle, masterRowNumber, firstDetailRowNumber, lastDetailRowNumber };
}

export async function updateMilitaryRequestDocumentLinks(applicationId, documents) {
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  const spreadsheets = await findMonthlySpreadsheetsForApplicationId(applicationId);
  const sheetsApi = getSheets();
  const matches = [];

  for (const spreadsheet of spreadsheets) {
    const response = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: spreadsheet.id,
      range: sheetRange("Військові частини", "B2:B"),
    });
    (response.data.values || []).forEach((row, rowOffset) => {
      if (row[0] === applicationId) matches.push({ spreadsheetId: spreadsheet.id, rowNumber: rowOffset + 2 });
    });
  }

  if (!matches.length) throw new Error(`Military request row not found: ${applicationId}`);
  if (matches.length > 1) throw new Error(`Duplicate military request row: ${applicationId}`);
  const match = matches[0];
  const richText = buildDocumentRichText(documents);
  const sheetId = await getSheetId(sheetsApi, match.spreadsheetId, "Військові частини");
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId: match.spreadsheetId,
    requestBody: {
      requests: [{
        updateCells: {
          range: {
            sheetId,
            startRowIndex: match.rowNumber - 1,
            endRowIndex: match.rowNumber,
            startColumnIndex: 7,
            endColumnIndex: 8,
          },
          rows: [{ values: [{
            userEnteredValue: { stringValue: richText.text },
            textFormatRuns: richText.textFormatRuns,
          }] }],
          fields: "userEnteredValue,textFormatRuns",
        },
      }],
    },
  });
}

function hasCorrectRequestCardLink(cell, applicationId, expectedUrl) {
  return cell?.userEnteredValue?.stringValue === applicationId && cell?.hyperlink === expectedUrl;
}

export async function ensureRequestCardLinks() {
  const spreadsheet = await getOrCreateCurrentMonthSpreadsheet();
  const sheetsApi = getSheets();
  const valuesResponse = await sheetsApi.spreadsheets.values.batchGet({
    spreadsheetId: spreadsheet.spreadsheetId,
    ranges: REQUIRED_SHEET_TITLES.map((title) => sheetRange(title, "B2:B")),
  });
  const valuesByTitle = new Map(REQUIRED_SHEET_TITLES.map((title, index) => [
    title,
    valuesResponse.data.valueRanges?.[index]?.values || [],
  ]));
  const populatedRanges = REQUIRED_SHEET_TITLES
    .map((title) => ({ title, rowCount: valuesByTitle.get(title).length }))
    .filter(({ rowCount }) => rowCount > 0);

  if (!populatedRanges.length) return { success: true, updated: 0, alreadyCorrect: 0, skipped: 0 };

  const gridResponse = await sheetsApi.spreadsheets.get({
    spreadsheetId: spreadsheet.spreadsheetId,
    ranges: populatedRanges.map(({ title, rowCount }) => sheetRange(title, `B2:B${rowCount + 1}`)),
    includeGridData: true,
    fields: "sheets(properties(sheetId,title),data(startRow,rowData(values(userEnteredValue,hyperlink))))",
  });
  const sheetsByTitle = new Map((gridResponse.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));
  const requests = [];
  let alreadyCorrect = 0;
  let skipped = 0;

  for (const { title } of populatedRanges) {
    const sheet = sheetsByTitle.get(title);
    const sheetId = sheet?.properties?.sheetId;
    if (!Number.isInteger(sheetId)) throw new Error(`Required sheet is missing: ${title}`);
    const rowData = sheet.data?.[0]?.rowData || [];
    const values = valuesByTitle.get(title);

    for (let rowOffset = 0; rowOffset < values.length; rowOffset += 1) {
      const applicationId = values[rowOffset]?.[0];
      if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) {
        skipped += 1;
        continue;
      }
      const richText = await buildRequestCardRichText(applicationId);
      const cell = rowData[rowOffset]?.values?.[0];
      const expectedUrl = richText.textFormatRuns[0].format.link.uri;
      if (hasCorrectRequestCardLink(cell, applicationId, expectedUrl)) {
        alreadyCorrect += 1;
        continue;
      }
      requests.push(requestCardLinkUpdate(sheetId, rowOffset + 2, richText));
    }
  }

  const batchSize = 500;
  for (let index = 0; index < requests.length; index += batchSize) {
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheet.spreadsheetId,
      requestBody: { requests: requests.slice(index, index + batchSize) },
    });
  }

  return { success: true, updated: requests.length, alreadyCorrect, skipped };
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
