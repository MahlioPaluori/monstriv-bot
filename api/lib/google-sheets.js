import { google } from "googleapis";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const SHEET_HEADERS = [
  "№ заявки",
  "Дата",
  "Тип заявника",
  "ПІБ / відповідальна особа",
  "Телефон",
  "Номер ВЧ",
  "Місто доставки",
  "Відділення Нової пошти",
  "Отримувач",
  "Телефон отримувача",
  "Потреба",
  "Документи",
];

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken || !rootFolderId) {
    throw new Error("Google Sheets environment variables are missing");
  }

  return { clientId, clientSecret, refreshToken, rootFolderId };
}

function getAuth() {
  const { clientId, clientSecret, refreshToken } = getConfig();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

function getSheets() {
  return google.sheets({ version: "v4", auth: getAuth() });
}

function getDrive() {
  return google.drive({ version: "v3", auth: getAuth() });
}

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function getMonthlySpreadsheetName(date = new Date()) {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `Запити-${month}-${date.getFullYear()}`;
}

async function findMonthlySpreadsheet(name) {
  const { rootFolderId } = getConfig();
  const drive = getDrive();
  const escapedName = escapeQueryValue(name);
  const response = await drive.files.list({
    q: `'${rootFolderId}' in parents and name = '${escapedName}' and mimeType = '${SPREADSHEET_MIME}' and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0] || null;
}

async function ensureHeaders(sheets, spreadsheetId, sheetName) {
  const range = `${sheetName}!A1:L1`;
  const current = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  if (current.data.values?.[0]?.length) return;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [SHEET_HEADERS] },
  });
}

async function getOrCreateMonthlySpreadsheet(date = new Date()) {
  const name = getMonthlySpreadsheetName(date);
  const existing = await findMonthlySpreadsheet(name);
  if (existing) return existing.id;

  const sheets = getSheets();
  const created = await sheets.spreadsheets.create({
    requestBody: {
      properties: { title: name },
      sheets: [
        { properties: { title: process.env.GOOGLE_SHEETS_INDIVIDUAL_SHEET_NAME || "Фізособи" } },
        { properties: { title: process.env.GOOGLE_SHEETS_MILITARY_SHEET_NAME || "Військові частини" } },
      ],
    },
    fields: "spreadsheetId",
  });

  const spreadsheetId = created.data.spreadsheetId;
  const { rootFolderId } = getConfig();
  const drive = getDrive();
  const file = await drive.files.get({ fileId: spreadsheetId, fields: "id,parents", supportsAllDrives: true });
  const oldParents = (file.data.parents || []).join(",");

  await drive.files.update({
    fileId: spreadsheetId,
    addParents: rootFolderId,
    removeParents: oldParents || undefined,
    fields: "id,parents",
    supportsAllDrives: true,
  });

  return spreadsheetId;
}

function documentsToLinks(documents = {}) {
  return Object.entries(documents)
    .flatMap(([key, files]) => (Array.isArray(files) ? files.map((file) => `${key}: ${file.driveUrl || file.driveFileId || ""}`) : []))
    .filter(Boolean)
    .join("\n");
}

export async function appendApplicationToSheet(request) {
  const sheets = getSheets();
  const spreadsheetId = await getOrCreateMonthlySpreadsheet();
  const sheetName = request.type === "military_unit"
    ? (process.env.GOOGLE_SHEETS_MILITARY_SHEET_NAME || "Військові частини")
    : (process.env.GOOGLE_SHEETS_INDIVIDUAL_SHEET_NAME || "Фізособи");
  const data = request.data || {};

  await ensureHeaders(sheets, spreadsheetId, sheetName);

  const row = [
    request.applicationNumber || "",
    new Date().toISOString(),
    request.type === "military_unit" ? "Військова частина" : "Фізична особа",
    data.name || "",
    data.phone || "",
    data.militaryUnitNumber || "",
    data.city || "",
    data.novaPoshtaBranch || "",
    data.recipientAnotherPerson ? (data.recipientName || "") : "Заявник",
    data.recipientAnotherPerson ? (data.recipientPhone || "") : (data.phone || ""),
    data.need || "",
    documentsToLinks(request.documents),
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${sheetName}!A:L`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: [row] },
  });

  return spreadsheetId;
}
