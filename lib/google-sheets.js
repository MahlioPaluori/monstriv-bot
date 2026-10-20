import { google } from "googleapis";
import { randomUUID } from "node:crypto";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";
import {
  acquireSheetWriteClaim,
  ownsSheetWriteClaim,
  releaseSheetWriteClaim,
  renewSheetWriteClaim,
  SHEET_WRITE_CLAIM_TTL_SECONDS,
} from "./state.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUIRED_SHEET_TITLES = ["Фізособи", "Військові частини"];
const REFERENCE_SHEET_TITLE = "Довідники";
export const REQUEST_CATEGORY_NAMED_RANGE = "MonstrivRequestCategories";
export const REQUEST_CATEGORY_VALIDATION_SOURCE = "'Довідники'!A2:A";
const ALLOWED_SHEET_TITLES = [...REQUIRED_SHEET_TITLES, REFERENCE_SHEET_TITLE];
const UKRAINE_TIME_ZONE = "Europe/Kyiv";
const APPLICATION_ID_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-\d{4}$/;
const APPLICATION_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
export const DEFAULT_REQUEST_STATUS = "Нова";
const REQUEST_STATUS_OPTIONS = ["Нова", "В роботі", "Зібрано", "Відхилено"];
const REQUEST_STATUS_FORMATS = [
  { status: "Нова", backgroundColor: { red: 0.82, green: 0.91, blue: 0.98 } },
  { status: "В роботі", backgroundColor: { red: 1, green: 0.95, blue: 0.7 } },
  { status: "Зібрано", backgroundColor: { red: 0.8, green: 0.94, blue: 0.82 } },
  { status: "Відхилено", backgroundColor: { red: 1, green: 0.8, blue: 0.8 } },
];

const LEGACY_SHEET_HEADERS = {
  "Фізособи": {
    lastColumn: "O",
    headers: ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ", "Телефон", "Паспорт", "РНОКПП", "Військовий документ", "УБД", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"],
  },
  "Військові частини": {
    lastColumn: "M",
    headers: ["Статус", "ID запиту", "Дата", "Потреба", "ПІБ відповідальної особи", "Телефон", "Номер ВЧ", "Офіційний запит", "Місто", "Нова пошта", "Інший отримувач", "ПІБ отримувача", "Телефон отримувача"],
  },
};

const OPERATOR_SHEET_LAYOUTS = Object.fromEntries(Object.entries(LEGACY_SHEET_HEADERS).map(([title, legacy]) => [title, {
  lastColumn: title === "Фізособи" ? "P" : "N",
  headers: [legacy.headers[0], "Категорія запиту", ...legacy.headers.slice(1)],
}]));

export const INITIAL_REQUEST_CATEGORIES = [
  "Старлінк",
  "Старлінк міні",
  "Детектор",
  "Зарядна станція/Генератор",
  "Такмед",
  "Інше",
];

const REQUEST_SHEET_CONFIGS = [
  { title: "Фізособи", type: "individual" },
  { title: "Військові частини", type: "military_unit" },
];

function columnLetter(index) {
  let value = index + 1;
  let label = "";
  while (value > 0) {
    value -= 1;
    label = String.fromCharCode(65 + (value % 26)) + label;
    value = Math.floor(value / 26);
  }
  return label;
}

function exactHeaders(actual, expected) {
  return actual.length === expected.length && expected.every((value, index) => actual[index] === value);
}

function layoutFor(title, version) {
  const type = title === "Фізособи" ? "individual" : title === "Військові частини" ? "military_unit" : null;
  if (!type) throw new Error(`Unknown request sheet: ${title}`);
  const category = version === "category";
  const shift = category ? 1 : 0;
  const legacy = LEGACY_SHEET_HEADERS[title];
  const headers = category ? OPERATOR_SHEET_LAYOUTS[title].headers : legacy.headers;
  const documents = type === "individual"
    ? { passport: 6 + shift, rnokpp: 7 + shift, military_id: 8 + shift, ubd: 9 + shift }
    : { official_request: 7 + shift };
  return {
    version,
    title,
    type,
    headers,
    columnCount: headers.length,
    lastColumn: columnLetter(headers.length - 1),
    statusIndex: 0,
    categoryIndex: category ? 1 : null,
    applicationIdIndex: 1 + shift,
    dateIndex: 2 + shift,
    needIndex: 3 + shift,
    personNameIndex: 4 + shift,
    mainPhoneIndex: 5 + shift,
    militaryUnitNumberIndex: type === "military_unit" ? 6 + shift : null,
    documents,
    cityIndex: (type === "individual" ? 10 : 8) + shift,
    novaPoshtaBranchIndex: (type === "individual" ? 11 : 9) + shift,
    anotherRecipientIndex: (type === "individual" ? 12 : 10) + shift,
    recipientNameIndex: (type === "individual" ? 13 : 11) + shift,
    recipientPhoneIndex: (type === "individual" ? 14 : 12) + shift,
  };
}

export function resolveOperatorSheetLayout(title, headerRow) {
  const actual = Array.isArray(headerRow) ? headerRow.map((value) => String(value ?? "").trim()) : [];
  const legacy = LEGACY_SHEET_HEADERS[title]?.headers;
  const category = OPERATOR_SHEET_LAYOUTS[title]?.headers;
  if (!legacy || !category) throw new Error(`Unknown request sheet: ${title}`);
  if (exactHeaders(actual, legacy)) return layoutFor(title, "legacy");
  if (exactHeaders(actual, category)) return layoutFor(title, "category");
  const error = new Error(`Unknown or incomplete sheet headers: ${title}`);
  error.code = "SHEETS_UNKNOWN_LAYOUT";
  throw error;
}

async function readOperatorSheetLayout(sheetsApi, spreadsheetId, title) {
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(title, "A1:Z1"),
  });
  return resolveOperatorSheetLayout(title, response.data.values?.[0] || []);
}

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
  const requests = ALLOWED_SHEET_TITLES
    .filter((title) => !titles.has(title))
    .map((title) => ({ addSheet: { properties: { title } } }));

  for (const sheet of existing) {
    const title = sheet.properties?.title;
    const sheetId = sheet.properties?.sheetId;
    if (!ALLOWED_SHEET_TITLES.includes(title) && Number.isInteger(sheetId)) {
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

function applicationPeriodFromId(applicationId) {
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  return applicationId.slice(0, 7);
}

function spreadsheetNameForPeriod(period) {
  if (!APPLICATION_PERIOD_PATTERN.test(period)) throw new Error("Invalid application period");
  const [year, month] = period.split("-").map(Number);
  return getCurrentMonthSpreadsheetName(new Date(Date.UTC(year, month - 1, 15, 12)));
}

async function findMonthlySpreadsheetsForPeriod(period) {
  const name = spreadsheetNameForPeriod(period);
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
    files.push(...(response.data.files || []).filter((file) => file.name === name));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function findMonthlySpreadsheetsForApplicationId(applicationId) {
  return findMonthlySpreadsheetsForPeriod(applicationPeriodFromId(applicationId));
}

export async function getMaxApplicationSequenceForPeriod(period) {
  if (!APPLICATION_PERIOD_PATTERN.test(period)) throw new Error("Invalid application period");
  const spreadsheets = await findMonthlySpreadsheetsForPeriod(period);
  const sheetsApi = getSheets();
  const prefix = `${period}-`;
  let maximum = 0;

  for (const spreadsheet of spreadsheets) {
    for (const { title } of REQUEST_SHEET_CONFIGS) {
      const layout = await readOperatorSheetLayout(sheetsApi, spreadsheet.id, title);
      const idColumn = columnLetter(layout.applicationIdIndex);
      const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId: spreadsheet.id, range: sheetRange(title, `${idColumn}2:${idColumn}`) });
      for (const row of response.data.values || []) {
        const applicationId = row[0];
        if (typeof applicationId !== "string" || !applicationId.startsWith(prefix) || !APPLICATION_ID_PATTERN.test(applicationId)) continue;
        maximum = Math.max(maximum, Number(applicationId.slice(-4)));
      }
    }
  }
  return maximum;
}

export async function findApplicationRowsInSpreadsheet(sheetsApi, spreadsheetId, applicationId) {
  const matches = [];
  for (const config of REQUEST_SHEET_CONFIGS) {
    const layout = await readOperatorSheetLayout(sheetsApi, spreadsheetId, config.title);
    const idColumn = columnLetter(layout.applicationIdIndex);
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: sheetRange(config.title, `${idColumn}2:${idColumn}`) });
    const values = response.data.values || [];
    values.forEach((row, rowOffset) => {
      if (row[0] === applicationId) matches.push({ ...config, layout, rowNumber: rowOffset + 2 });
    });
  }
  return matches;
}

function normalizeDocumentValue(value) {
  return String(valueOrEmpty(value))
    .split("\n")
    .map((fileName) => fileName.trim())
    .filter(Boolean)
    .map((fileName) => ({ fileName }));
}

export function normalizeRequestRow(type, row, providedLayout) {
  const title = type === "individual" ? "Фізособи" : "Військові частини";
  const layout = providedLayout || layoutFor(title, "legacy");
  const values = Array.from({ length: layout.columnCount }, (_, index) => valueOrEmpty(row[index]));
  const isIndividual = type === "individual";
  const personName = values[layout.personNameIndex];
  const mainPhone = values[layout.mainPhoneIndex];
  const anotherRecipient = values[layout.anotherRecipientIndex];
  const recipientName = values[layout.recipientNameIndex];
  const recipientPhone = values[layout.recipientPhoneIndex];
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
    applicationId: values[layout.applicationIdIndex],
    date: values[layout.dateIndex],
    need: values[layout.needIndex],
    personName,
    mainPhone,
    militaryUnitNumber: isIndividual ? "" : values[layout.militaryUnitNumberIndex],
    documents: isIndividual
      ? {
          passport: normalizeDocumentValue(values[layout.documents.passport]),
          rnokpp: normalizeDocumentValue(values[layout.documents.rnokpp]),
          military_id: normalizeDocumentValue(values[layout.documents.military_id]),
          ubd: normalizeDocumentValue(values[layout.documents.ubd]),
        }
      : { official_request: normalizeDocumentValue(values[layout.documents.official_request]) },
    city: values[layout.cityIndex],
    novaPoshtaBranch: values[layout.novaPoshtaBranchIndex],
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
    ranges: [sheetRange(match.title, `A${match.rowNumber + 1}:${match.layout.lastColumn}`)],
    includeGridData: true,
    fields: "sheets(data(rowData(values(userEnteredValue,formattedValue,textFormatRuns))))",
  });
  const rows = response.data.sheets?.[0]?.data?.[0]?.rowData || [];
  const beneficiaries = [];

  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const cells = rows[rowIndex]?.values || [];
    const label = cellText(cells[match.layout.applicationIdIndex]);
    const expectedLabel = `Особа ${beneficiaries.length + 1}`;

    if (label !== expectedLabel) {
      if (/^Особа \d+$/.test(label)) return { result: "invalid_data" };
      break;
    }

    const beneficiary = {
      index: beneficiaries.length + 1,
      name: cellText(cells[match.layout.personNameIndex]).trim(),
      phone: cellText(cells[match.layout.mainPhoneIndex]).trim(),
      documents: {
        passport: normalizeDocumentCell(cells[match.layout.documents.passport]),
        rnokpp: normalizeDocumentCell(cells[match.layout.documents.rnokpp]),
        military_id: normalizeDocumentCell(cells[match.layout.documents.military_id]),
        ubd: normalizeDocumentCell(cells[match.layout.documents.ubd]),
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
    range: sheetRange(match.title, `A${match.rowNumber}:${match.layout.lastColumn}${match.rowNumber}`),
  });
  const request = normalizeRequestRow(match.type, rowResponse.data.values?.[0] || [], match.layout);
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

function emptyLayoutRow(layout) { return Array(layout.columnCount).fill(""); }

function buildPhysicalPersonRow(request, applicationId, confirmedAt, layout) {
  const data = request.data || {};
  const documents = request.documents || {};
  const row = emptyLayoutRow(layout);
  row[layout.statusIndex] = DEFAULT_REQUEST_STATUS;
  row[layout.applicationIdIndex] = applicationId;
  row[layout.dateIndex] = formatConfirmedAt(confirmedAt);
  row[layout.needIndex] = valueOrEmpty(data.need);
  row[layout.personNameIndex] = valueOrEmpty(data.name);
  row[layout.mainPhoneIndex] = valueOrEmpty(data.phone);
  for (const key of Object.keys(layout.documents)) row[layout.documents[key]] = serializeDocuments(documents[key]);
  row[layout.cityIndex] = valueOrEmpty(data.city);
  row[layout.novaPoshtaBranchIndex] = valueOrEmpty(data.novaPoshtaBranch);
  [row[layout.anotherRecipientIndex], row[layout.recipientNameIndex], row[layout.recipientPhoneIndex]] = recipientValues(data);
  return row;
}

function buildMultiMasterRow(request, applicationId, confirmedAt, layout) {
  return buildPhysicalPersonRow({ ...request, documents: {} }, applicationId, confirmedAt, layout);
}

function buildMultiDetailRow(beneficiary, index, layout) {
  const documents = beneficiary?.documents || {};
  const row = emptyLayoutRow(layout);
  row[layout.applicationIdIndex] = `Особа ${index + 1}`;
  row[layout.personNameIndex] = valueOrEmpty(beneficiary?.name);
  row[layout.mainPhoneIndex] = valueOrEmpty(beneficiary?.phone);
  for (const key of Object.keys(layout.documents)) row[layout.documents[key]] = serializeDocuments(documents[key]);
  return row;
}

function buildMilitaryUnitRow(request, applicationId, confirmedAt, layout) {
  const data = request.data || {};
  const documents = request.documents || {};
  const row = emptyLayoutRow(layout);
  row[layout.statusIndex] = DEFAULT_REQUEST_STATUS;
  row[layout.applicationIdIndex] = applicationId;
  row[layout.dateIndex] = formatConfirmedAt(confirmedAt);
  row[layout.needIndex] = valueOrEmpty(data.need);
  row[layout.personNameIndex] = valueOrEmpty(data.name);
  row[layout.mainPhoneIndex] = valueOrEmpty(data.phone);
  row[layout.militaryUnitNumberIndex] = valueOrEmpty(data.militaryUnitNumber);
  row[layout.documents.official_request] = serializeDocuments(documents.official_request);
  row[layout.cityIndex] = valueOrEmpty(data.city);
  row[layout.novaPoshtaBranchIndex] = valueOrEmpty(data.novaPoshtaBranch);
  [row[layout.anotherRecipientIndex], row[layout.recipientNameIndex], row[layout.recipientPhoneIndex]] = recipientValues(data);
  return row;
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

function sheetWriterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function logSheetWriter(event, details = {}) {
  console.info(JSON.stringify({ event, ...details }));
}

export async function runWithSheetWriteLease(spreadsheetId, sheetId, operation, services = {}) {
  const acquire = services.acquire || acquireSheetWriteClaim;
  const renew = services.renew || renewSheetWriteClaim;
  const check = services.check || ownsSheetWriteClaim;
  const release = services.release || releaseSheetWriteClaim;
  const ownerToken = services.ownerToken || randomUUID();
  const ttlSeconds = services.ttlSeconds || SHEET_WRITE_CLAIM_TTL_SECONDS;
  const heartbeatMs = services.heartbeatMs || Math.max(1000, Math.floor(ttlSeconds * 1000 / 3));
  const acquired = await acquire(spreadsheetId, sheetId, ownerToken, { ttlSeconds });
  if (!acquired) throw sheetWriterError("SHEET_WRITE_BUSY", "Google Sheets writer is busy");

  let claimLost = false;
  let renewal = Promise.resolve();
  const renewLease = () => {
    renewal = renewal.then(async () => {
      if (!claimLost && !await renew(spreadsheetId, sheetId, ownerToken, { ttlSeconds })) claimLost = true;
    }).catch(() => { claimLost = true; });
    return renewal;
  };
  const heartbeat = setInterval(renewLease, heartbeatMs);
  heartbeat.unref?.();
  const assertOwnership = async () => {
    await renewal;
    if (claimLost || !await check(spreadsheetId, sheetId, ownerToken)) {
      claimLost = true;
      throw sheetWriterError("SHEET_WRITE_CLAIM_LOST", "Google Sheets writer lease was lost");
    }
    if (!await renew(spreadsheetId, sheetId, ownerToken, { ttlSeconds })) {
      claimLost = true;
      throw sheetWriterError("SHEET_WRITE_CLAIM_LOST", "Google Sheets writer lease was lost");
    }
  };

  try {
    await assertOwnership();
    return await operation(assertOwnership);
  } finally {
    clearInterval(heartbeat);
    await renewal;
    try { await release(spreadsheetId, sheetId, ownerToken); }
    catch (error) { logSheetWriter("sheets_writer_release_failed", { errorCode: error?.code || "UNKNOWN" }); }
  }
}

async function applyDocumentRichText(sheetsApi, spreadsheetId, sheetTitle, rowNumber, documentCells, assertOwnership = async () => {}) {
  const cellsWithDocuments = documentCells.filter(({ richText }) => richText.text);
  if (!cellsWithDocuments.length) return;

  await assertOwnership();
  const sheetId = await getSheetId(sheetsApi, spreadsheetId, sheetTitle);
  await assertOwnership();
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
  await assertOwnership();
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
  await assertOwnership();
}

function documentRichTextUpdates(sheetId, rowNumber, documents, layout) {
  return Object.entries(layout.documents).flatMap(([key, columnIndex]) => {
    const files = documents?.[key];
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
  const { buildRequestCardUrl } = await import("../api/request-card.js");
  return {
    text: applicationId,
    textFormatRuns: [{ startIndex: 0, format: { link: { uri: buildRequestCardUrl(applicationId) } } }],
  };
}

function requestCardLinkUpdate(sheetId, rowNumber, richText, applicationIdIndex) {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: rowNumber - 1,
        endRowIndex: rowNumber,
        startColumnIndex: applicationIdIndex,
        endColumnIndex: applicationIdIndex + 1,
      },
      rows: [{ values: [{
        userEnteredValue: { stringValue: richText.text },
        textFormatRuns: richText.textFormatRuns,
      }] }],
      fields: "userEnteredValue,textFormatRuns",
    },
  };
}

async function applyRequestCardLink(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId, applicationIdIndex, assertOwnership = async () => {}) {
  await assertOwnership();
  const sheetId = await getSheetId(sheetsApi, spreadsheetId, sheetTitle);
  await assertOwnership();
  const richText = await buildRequestCardRichText(applicationId);
  await assertOwnership();
  await sheetsApi.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [requestCardLinkUpdate(sheetId, rowNumber, richText, applicationIdIndex)] },
  });
  await assertOwnership();
}

async function applyRequestCardLinkSafely(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId, applicationIdIndex, assertOwnership = async () => {}) {
  try {
    await applyRequestCardLink(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId, applicationIdIndex, assertOwnership);
    return true;
  } catch (error) {
    if (error?.code === "SHEET_WRITE_CLAIM_LOST") throw error;
    console.error("Request card link formatting failed:", error?.message || "Unknown error");
    return false;
  }
}

function rowHasData(row) {
  return Array.isArray(row) && row.some((value) => value !== "" && value !== null && value !== undefined);
}

async function readSheetRows(sheetsApi, spreadsheetId, sheetTitle, lastColumn, assertOwnership) {
  await assertOwnership();
  const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: sheetRange(sheetTitle, `A1:${lastColumn}`) });
  await assertOwnership();
  return response.data.values || [];
}

function masterRowsInSnapshot(rows, applicationId, applicationIdIndex) {
  const matches = [];
  rows.forEach((row, index) => { if (row?.[applicationIdIndex] === applicationId) matches.push(index + 1); });
  return matches;
}

function nextFreeRow(rows) {
  let lastUsed = 1;
  rows.forEach((row, index) => { if (rowHasData(row)) lastUsed = index + 1; });
  return Math.max(2, lastUsed + 1);
}

function rangesOverlap(left, right) {
  return left.startIndex < right.endIndex && left.endIndex > right.startIndex;
}

async function getSheetLayout(sheetsApi, spreadsheetId, sheetId, assertOwnership) {
  await assertOwnership();
  const response = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,gridProperties(rowCount)),rowGroups(range,depth,collapsed))",
  });
  await assertOwnership();
  const sheet = (response.data.sheets || []).find((item) => item.properties?.sheetId === sheetId);
  if (!sheet) throw sheetWriterError("SHEETS_STRUCTURE_INVALID", "Target sheet metadata is missing");
  return { rowCount: sheet.properties?.gridProperties?.rowCount || 0, rowGroups: sheet.rowGroups || [] };
}

function assertNoGroupOverlap(rowGroups, startRowNumber, endRowNumber) {
  const target = { startIndex: startRowNumber - 1, endIndex: endRowNumber };
  if (rowGroups.some((group) => rangesOverlap(group.range || {}, target))) {
    throw sheetWriterError("SHEETS_GROUP_CONFLICT", `Existing row group overlaps target rows ${startRowNumber}-${endRowNumber}`);
  }
}

async function ensureGridCapacity(sheetsApi, spreadsheetId, sheetId, requiredLastRow, assertOwnership) {
  let layout = await getSheetLayout(sheetsApi, spreadsheetId, sheetId, assertOwnership);
  if (layout.rowCount < requiredLastRow) {
    await assertOwnership();
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ appendDimension: { sheetId, dimension: "ROWS", length: requiredLastRow - layout.rowCount } }] },
    });
    await assertOwnership();
    layout = await getSheetLayout(sheetsApi, spreadsheetId, sheetId, assertOwnership);
  }
  if (layout.rowCount < requiredLastRow) throw sheetWriterError("SHEETS_CAPACITY_FAILED", "Unable to extend sheet row capacity");
  return layout;
}

async function verifyMultiBlock(sheetsApi, spreadsheetId, sheetTitle, masterRowNumber, beneficiaryCount, applicationId, layout, assertOwnership) {
  await assertOwnership();
  const response = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(sheetTitle, `${columnLetter(layout.applicationIdIndex)}${masterRowNumber}:${columnLetter(layout.applicationIdIndex)}${masterRowNumber + beneficiaryCount + 1}`),
  });
  await assertOwnership();
  const labels = Array.from({ length: beneficiaryCount + 2 }, (_, index) => response.data.values?.[index]?.[0] || "");
  if (labels[0] !== applicationId) throw sheetWriterError("SHEETS_VERIFY_FAILED", "Multi request master verification failed");
  for (let index = 0; index < beneficiaryCount; index += 1) {
    if (labels[index + 1] !== `Особа ${index + 1}`) throw sheetWriterError("SHEETS_VERIFY_FAILED", "Multi request detail verification failed");
  }
  if (/^Особа \d+$/.test(labels[beneficiaryCount + 1])) {
    throw sheetWriterError("SHEETS_STRUCTURE_INVALID", "Unexpected extra detail row after multi request");
  }
}

async function ensureMultiRowGroup(sheetsApi, spreadsheetId, sheetId, firstDetailRowNumber, lastDetailRowNumber, assertOwnership) {
  const targetRange = { sheetId, dimension: "ROWS", startIndex: firstDetailRowNumber - 1, endIndex: lastDetailRowNumber };
  let layout = await getSheetLayout(sheetsApi, spreadsheetId, sheetId, assertOwnership);
  let exactGroups = layout.rowGroups.filter((group) => group.range?.startIndex === targetRange.startIndex && group.range?.endIndex === targetRange.endIndex);
  const conflicting = layout.rowGroups.some((group) => rangesOverlap(group.range || {}, targetRange)
    && !(group.range?.startIndex === targetRange.startIndex && group.range?.endIndex === targetRange.endIndex));
  if (conflicting || exactGroups.length > 1) throw sheetWriterError("SHEETS_GROUP_CONFLICT", "Ambiguous or overlapping multi row group");

  if (!exactGroups.length) {
    await assertOwnership();
    await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: [{ addDimensionGroup: { range: targetRange } }] } });
    await assertOwnership();
    layout = await getSheetLayout(sheetsApi, spreadsheetId, sheetId, assertOwnership);
    exactGroups = layout.rowGroups.filter((group) => group.range?.startIndex === targetRange.startIndex && group.range?.endIndex === targetRange.endIndex);
    const postCreateConflict = layout.rowGroups.some((group) => rangesOverlap(group.range || {}, targetRange)
      && !(group.range?.startIndex === targetRange.startIndex && group.range?.endIndex === targetRange.endIndex));
    if (postCreateConflict || exactGroups.length !== 1) throw sheetWriterError("SHEETS_GROUP_CONFLICT", "Unable to create an isolated multi row group");
  }

  const exactGroup = exactGroups[0];
  if (!exactGroup.collapsed) {
    await assertOwnership();
    await sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId,
      requestBody: { requests: [{ updateDimensionGroup: { dimensionGroup: { range: targetRange, depth: exactGroup.depth || 1, collapsed: true }, fields: "collapsed" } }] },
    });
    await assertOwnership();
  }
}

export async function writeConfirmedSingleRequest({ sheetsApi, spreadsheetId, sheetId, sheetTitle, row, documentCells, applicationId, assertOwnership }) {
  let rows = await readSheetRows(sheetsApi, spreadsheetId, sheetTitle, "Z", assertOwnership);
  const layout = resolveOperatorSheetLayout(sheetTitle, rows[0] || []);
  if (!Array.isArray(row) || row.length !== layout.columnCount) throw sheetWriterError("SHEETS_LAYOUT_CHANGED", "Request row does not match current sheet layout");
  const existingMasters = masterRowsInSnapshot(rows, applicationId, layout.applicationIdIndex);
  if (existingMasters.length > 1) throw sheetWriterError("SHEETS_DUPLICATE_MASTER", `Duplicate request master row: ${applicationId}`);
  let rowNumber = existingMasters[0] || null;
  let existing = rowNumber !== null;

  if (existing) {
    if (/^Особа \d+$/.test(rows[rowNumber]?.[layout.applicationIdIndex] || "")) throw sheetWriterError("SHEETS_STRUCTURE_INVALID", "Single request is followed by multi detail rows");
  } else {
    rowNumber = nextFreeRow(rows);
    const gridLayout = await ensureGridCapacity(sheetsApi, spreadsheetId, sheetId, rowNumber, assertOwnership);
    assertNoGroupOverlap(gridLayout.rowGroups, rowNumber, rowNumber);
    rows = await readSheetRows(sheetsApi, spreadsheetId, sheetTitle, layout.lastColumn, assertOwnership);
    if (rowHasData(rows[rowNumber - 1])) throw sheetWriterError("SHEETS_TARGET_NOT_EMPTY", `Target row ${rowNumber} is not empty`);
    await assertOwnership();
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: sheetRange(sheetTitle, `A${rowNumber}:${layout.lastColumn}${rowNumber}`),
      valueInputOption: "RAW",
      requestBody: { values: [row] },
    });
    await assertOwnership();
    rows = await readSheetRows(sheetsApi, spreadsheetId, sheetTitle, layout.lastColumn, assertOwnership);
    if (rows[rowNumber - 1]?.[layout.applicationIdIndex] !== applicationId) throw sheetWriterError("SHEETS_VERIFY_FAILED", "Single request verification failed");
    logSheetWriter("sheets_single_written", { applicationId, rowNumber });
  }

  await applyDocumentRichText(sheetsApi, spreadsheetId, sheetTitle, rowNumber, documentCells, assertOwnership);
  await applyRequestCardLinkSafely(sheetsApi, spreadsheetId, sheetTitle, rowNumber, applicationId, layout.applicationIdIndex, assertOwnership);
  return { spreadsheetId, sheetTitle, existing, rowNumber };
}

export async function appendConfirmedRequest(request, applicationId, confirmedAt, services = {}) {
  const spreadsheet = await (services.getSpreadsheet || getOrCreateApplicationMonthSpreadsheet)(applicationId);
  const sheetsApi = services.sheetsApi || getSheets();
  const isMilitaryUnit = request.type === "military_unit";
  const sheetTitle = isMilitaryUnit ? "Військові частини" : "Фізособи";
  const sheetId = await getSheetId(sheetsApi, spreadsheet.spreadsheetId, sheetTitle);
  return runWithSheetWriteLease(spreadsheet.spreadsheetId, sheetId, async (assertOwnership) => {
    const layout = await readOperatorSheetLayout(sheetsApi, spreadsheet.spreadsheetId, sheetTitle);
    const row = isMilitaryUnit ? buildMilitaryUnitRow(request, applicationId, confirmedAt, layout) : buildPhysicalPersonRow(request, applicationId, confirmedAt, layout);
    const documents = request.documents || {};
    const documentCells = Object.entries(layout.documents).map(([key, columnIndex]) => ({ columnIndex, richText: buildDocumentRichText(documents[key]) }));
    return writeConfirmedSingleRequest({ sheetsApi, spreadsheetId: spreadsheet.spreadsheetId, sheetId, sheetTitle, row, documentCells, applicationId, assertOwnership });
  }, services.leaseServices);
}

export async function writeConfirmedMultiRequest({ sheetsApi, spreadsheetId, sheetId, request, applicationId, confirmedAt, assertOwnership }) {
  const sheetTitle = "Фізособи";
  const beneficiaries = request.beneficiaries;
  let rows = await readSheetRows(sheetsApi, spreadsheetId, sheetTitle, "Z", assertOwnership);
  const requestLayout = resolveOperatorSheetLayout(sheetTitle, rows[0] || []);
  const existingMasters = masterRowsInSnapshot(rows, applicationId, requestLayout.applicationIdIndex);
  if (existingMasters.length > 1) throw sheetWriterError("SHEETS_DUPLICATE_MASTER", `Duplicate multi request master row: ${applicationId}`);
  let masterRowNumber = existingMasters[0] || null;

  if (masterRowNumber === null) {
    masterRowNumber = nextFreeRow(rows);
    const lastDetailRowNumber = masterRowNumber + beneficiaries.length;
    const layout = await ensureGridCapacity(sheetsApi, spreadsheetId, sheetId, lastDetailRowNumber, assertOwnership);
    assertNoGroupOverlap(layout.rowGroups, masterRowNumber, lastDetailRowNumber);
    rows = await readSheetRows(sheetsApi, spreadsheetId, sheetTitle, requestLayout.lastColumn, assertOwnership);
    for (let rowNumber = masterRowNumber; rowNumber <= lastDetailRowNumber; rowNumber += 1) {
      if (rowHasData(rows[rowNumber - 1])) throw sheetWriterError("SHEETS_TARGET_NOT_EMPTY", `Target row ${rowNumber} is not empty`);
    }
    const matrix = [buildMultiMasterRow(request, applicationId, confirmedAt, requestLayout), ...beneficiaries.map((beneficiary, index) => buildMultiDetailRow(beneficiary, index, requestLayout))];
    await assertOwnership();
    await sheetsApi.spreadsheets.values.update({
      spreadsheetId,
      range: sheetRange(sheetTitle, `A${masterRowNumber}:${requestLayout.lastColumn}${lastDetailRowNumber}`),
      valueInputOption: "RAW",
      requestBody: { values: matrix },
    });
    await assertOwnership();
    logSheetWriter("sheets_multi_matrix_written", { applicationId, masterRowNumber, detailCount: beneficiaries.length });
  } else {
    const expectedLabels = beneficiaries.map((_, index) => `Особа ${index + 1}`);
    let prefix = 0;
    while (prefix < expectedLabels.length && rows[masterRowNumber + prefix]?.[requestLayout.applicationIdIndex] === expectedLabels[prefix]) prefix += 1;
    if (prefix < expectedLabels.length) {
      for (let index = prefix; index < expectedLabels.length; index += 1) {
        if (rowHasData(rows[masterRowNumber + index])) {
          throw sheetWriterError("SHEETS_STRUCTURE_INVALID", `Cannot recover non-empty detail row ${masterRowNumber + index + 1}`);
        }
      }
      const firstMissingRow = masterRowNumber + prefix + 1;
      const lastDetailRowNumber = masterRowNumber + beneficiaries.length;
      const layout = await ensureGridCapacity(sheetsApi, spreadsheetId, sheetId, lastDetailRowNumber, assertOwnership);
      assertNoGroupOverlap(layout.rowGroups, firstMissingRow, lastDetailRowNumber);
      await assertOwnership();
      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: sheetRange(sheetTitle, `A${firstMissingRow}:${requestLayout.lastColumn}${lastDetailRowNumber}`),
        valueInputOption: "RAW",
        requestBody: { values: beneficiaries.slice(prefix).map((beneficiary, index) => buildMultiDetailRow(beneficiary, prefix + index, requestLayout)) },
      });
      await assertOwnership();
      logSheetWriter("sheets_multi_suffix_recovered", { applicationId, firstMissingRow, recoveredCount: beneficiaries.length - prefix });
    }
  }

  const firstDetailRowNumber = masterRowNumber + 1;
  const lastDetailRowNumber = masterRowNumber + beneficiaries.length;
  await verifyMultiBlock(sheetsApi, spreadsheetId, sheetTitle, masterRowNumber, beneficiaries.length, applicationId, requestLayout, assertOwnership);
  const masterRichText = await buildRequestCardRichText(applicationId);
  await assertOwnership();
  const formattingRequests = [
    requestCardLinkUpdate(sheetId, masterRowNumber, masterRichText, requestLayout.applicationIdIndex),
    ...beneficiaries.map((_, index) => ({
      updateCells: {
        range: { sheetId, startRowIndex: firstDetailRowNumber + index - 1, endRowIndex: firstDetailRowNumber + index, startColumnIndex: requestLayout.applicationIdIndex, endColumnIndex: requestLayout.applicationIdIndex + 1 },
        rows: [{ values: [{ userEnteredValue: { stringValue: `Особа ${index + 1}` }, textFormatRuns: [] }] }],
        fields: "userEnteredValue,textFormatRuns",
      },
    })),
    ...beneficiaries.flatMap((beneficiary, index) => documentRichTextUpdates(sheetId, firstDetailRowNumber + index, beneficiary.documents, requestLayout)),
  ];
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: formattingRequests } });
  await assertOwnership();
  await ensureMultiRowGroup(sheetsApi, spreadsheetId, sheetId, firstDetailRowNumber, lastDetailRowNumber, assertOwnership);
  await verifyMultiBlock(sheetsApi, spreadsheetId, sheetTitle, masterRowNumber, beneficiaries.length, applicationId, requestLayout, assertOwnership);
  logSheetWriter("sheets_multi_completed", { applicationId, masterRowNumber, detailCount: beneficiaries.length });
  return { spreadsheetId, sheetTitle, masterRowNumber, firstDetailRowNumber, lastDetailRowNumber };
}

export async function appendConfirmedMultiRequest(request, applicationId, confirmedAt, services = {}) {
  if (request.type !== "individual" || request.multiPackage !== true) throw new Error("Invalid individual multi request");
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  const beneficiaries = request.beneficiaries;
  if (!Array.isArray(beneficiaries) || beneficiaries.length < 2 || beneficiaries.length !== request.beneficiaryCount) throw new Error("Invalid multi beneficiaries");
  const spreadsheet = await (services.getSpreadsheet || getOrCreateApplicationMonthSpreadsheet)(applicationId);
  const sheetsApi = services.sheetsApi || getSheets();
  const sheetTitle = "Фізособи";
  const sheetId = await getSheetId(sheetsApi, spreadsheet.spreadsheetId, sheetTitle);
  return runWithSheetWriteLease(spreadsheet.spreadsheetId, sheetId, (assertOwnership) => writeConfirmedMultiRequest({
    sheetsApi, spreadsheetId: spreadsheet.spreadsheetId, sheetId, request, applicationId, confirmedAt, assertOwnership,
  }), services.leaseServices);
}

export async function updateMilitaryRequestDocumentLinks(applicationId, documents) {
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  const spreadsheets = await findMonthlySpreadsheetsForApplicationId(applicationId);
  const sheetsApi = getSheets();
  const matches = [];

  for (const spreadsheet of spreadsheets) {
    const title = "Військові частини";
    const layout = await readOperatorSheetLayout(sheetsApi, spreadsheet.id, title);
    const idColumn = columnLetter(layout.applicationIdIndex);
    const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId: spreadsheet.id, range: sheetRange(title, `${idColumn}2:${idColumn}`) });
    (response.data.values || []).forEach((row, rowOffset) => {
      if (row[0] === applicationId) matches.push({ spreadsheetId: spreadsheet.id, rowNumber: rowOffset + 2, layout });
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
            startColumnIndex: match.layout.documents.official_request,
            endColumnIndex: match.layout.documents.official_request + 1,
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

async function addHeadersIfSheetIsEmpty(sheetsApi, spreadsheetId, title, layout, initializeEmpty) {
  const valuesResponse = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(title, `A1:${layout.lastColumn}`),
  });
  const hasData = (valuesResponse.data.values || []).some((row) => row.some((value) => value !== ""));
  if (hasData) {
    resolveOperatorSheetLayout(title, valuesResponse.data.values?.[0] || []);
    return false;
  }

  if (!initializeEmpty) {
    const error = new Error(`Unknown or incomplete sheet headers: ${title}`);
    error.code = "SHEETS_UNKNOWN_LAYOUT";
    throw error;
  }
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(title, "A1"),
    valueInputOption: "RAW",
    requestBody: { values: [layout.headers] },
  });
  return true;
}

async function initializeReferenceSheetIfEmpty(sheetsApi, spreadsheetId) {
  const response = await sheetsApi.spreadsheets.values.get({ spreadsheetId, range: sheetRange(REFERENCE_SHEET_TITLE, "A1:A") });
  const hasData = (response.data.values || []).some((row) => row.some((value) => value !== ""));
  if (hasData) return;
  await sheetsApi.spreadsheets.values.update({
    spreadsheetId,
    range: sheetRange(REFERENCE_SHEET_TITLE, "A1"),
    valueInputOption: "RAW",
    requestBody: { values: [["Категорія запиту"], ...INITIAL_REQUEST_CATEGORIES.map((category) => [category])] },
  });
}

export function categoryValidationRequest(sheetId) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
      rule: {
        condition: { type: "ONE_OF_RANGE", values: [{ userEnteredValue: REQUEST_CATEGORY_VALIDATION_SOURCE }] },
        strict: true,
        showCustomUi: true,
      },
    },
  };
}

export function clearCategoryValidationRequest(sheetId) {
  return {
    setDataValidation: {
      range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
    },
  };
}

export function categoryNamedRangeRequest(referenceSheetId) {
  return {
    addNamedRange: {
      namedRange: {
        name: REQUEST_CATEGORY_NAMED_RANGE,
        range: { sheetId: referenceSheetId, startRowIndex: 1, startColumnIndex: 0, endColumnIndex: 1 },
      },
    },
  };
}

export function isExpectedCategoryNamedRange(namedRange, referenceSheetId, referenceRowCount) {
  const range = namedRange?.range;
  const endRowIsFullColumn = range?.endRowIndex == null
    || (Number.isInteger(referenceRowCount) && range.endRowIndex === referenceRowCount);
  return namedRange?.name === REQUEST_CATEGORY_NAMED_RANGE
    && range?.sheetId === referenceSheetId
    && range.startRowIndex === 1
    && endRowIsFullColumn
    && range.startColumnIndex === 0
    && range.endColumnIndex === 1;
}

export function newMonthlySpreadsheetSheets() {
  return ALLOWED_SHEET_TITLES.map((title) => ({ properties: { title } }));
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

async function ensureOperatorSheetStructure(spreadsheetId, { initializeEmpty = false } = {}) {
  const sheetsApi = getSheets();
  const metadata = await sheetsApi.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title,sheetType,gridProperties(rowCount)),conditionalFormats),namedRanges(namedRangeId,name,range)",
  });
  const sheetsByTitle = new Map((metadata.data.sheets || []).map((sheet) => [sheet.properties?.title, sheet]));

  const resolvedLayouts = new Map();
  for (const [title, layout] of Object.entries(OPERATOR_SHEET_LAYOUTS)) {
    if (!sheetsByTitle.has(title)) throw new Error(`Required sheet is missing: ${title}`);
    await addHeadersIfSheetIsEmpty(sheetsApi, spreadsheetId, title, layout, initializeEmpty);
    resolvedLayouts.set(title, await readOperatorSheetLayout(sheetsApi, spreadsheetId, title));
  }

  if ([...resolvedLayouts.values()].some((layout) => layout.version === "category") && !sheetsByTitle.has(REFERENCE_SHEET_TITLE)) {
    const error = new Error(`Required sheet is missing: ${REFERENCE_SHEET_TITLE}`);
    error.code = "SHEETS_UNKNOWN_LAYOUT";
    throw error;
  }

  if (initializeEmpty && sheetsByTitle.has(REFERENCE_SHEET_TITLE)) await initializeReferenceSheetIfEmpty(sheetsApi, spreadsheetId);

  const categoryLayouts = [...resolvedLayouts.values()].filter((layout) => layout.version === "category");
  const referenceSheetId = sheetsByTitle.get(REFERENCE_SHEET_TITLE)?.properties?.sheetId;
  const referenceRowCount = sheetsByTitle.get(REFERENCE_SHEET_TITLE)?.properties?.gridProperties?.rowCount;
  const categoryNamedRanges = (metadata.data.namedRanges || []).filter((namedRange) => namedRange.name === REQUEST_CATEGORY_NAMED_RANGE);
  if (categoryLayouts.length && categoryNamedRanges.length > 1) throw new Error(`Duplicate named range: ${REQUEST_CATEGORY_NAMED_RANGE}`);
  if (categoryNamedRanges.length === 1 && !isExpectedCategoryNamedRange(categoryNamedRanges[0], referenceSheetId, referenceRowCount)) {
    throw new Error(`Named range has unexpected target: ${REQUEST_CATEGORY_NAMED_RANGE}`);
  }

  const requests = [
    ...(categoryLayouts.length && !categoryNamedRanges.length ? [categoryNamedRangeRequest(referenceSheetId)] : []),
    ...REQUIRED_SHEET_TITLES.flatMap((title) => {
    const sheet = sheetsByTitle.get(title);
    const sheetId = sheet.properties.sheetId;
    const layout = resolvedLayouts.get(title);
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
      ...(sheetsByTitle.has(REFERENCE_SHEET_TITLE) && layout.version === "category" ? [categoryValidationRequest(sheetId)] : []),
      ...missingStatusConditionalFormatRequests(sheet),
    ];
  }),
  ];
  await sheetsApi.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
}

async function getOrCreateMonthSpreadsheetByName(name) {
  const { rootFolderId } = getGoogleConfig();
  const existing = await findSpreadsheet(name, rootFolderId);
  if (existing) {
    await ensureOperatorSheetStructure(existing.id);
    return { spreadsheetId: existing.id, name: existing.name, created: false };
  }

  const sheetsApi = getSheets();
  const created = await sheetsApi.spreadsheets.create({
    requestBody: {
      properties: { title: name, locale: "uk_UA", timeZone: UKRAINE_TIME_ZONE },
      sheets: newMonthlySpreadsheetSheets(),
    },
    fields: "spreadsheetId,properties.title,sheets.properties",
  });
  const spreadsheetId = created.data.spreadsheetId;
  if (!spreadsheetId) throw new Error("Google Sheets did not return a spreadsheet ID");

  await removeUnexpectedDefaultSheets(spreadsheetId, created.data.sheets);
  await moveSpreadsheetToRootFolder(spreadsheetId, rootFolderId);
  await ensureOperatorSheetStructure(spreadsheetId, { initializeEmpty: true });
  return { spreadsheetId, name: created.data.properties?.title || name, created: true };
}

async function getOrCreateApplicationMonthSpreadsheet(applicationId) {
  return getOrCreateMonthSpreadsheetByName(spreadsheetNameForPeriod(applicationPeriodFromId(applicationId)));
}
