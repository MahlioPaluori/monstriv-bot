import { google } from "googleapis";
import { getDrive, getGoogleAuth, getGoogleConfig } from "./google-drive.js";

const SPREADSHEET_MIME = "application/vnd.google-apps.spreadsheet";
const REQUIRED_SHEET_TITLES = ["Фізособи", "Військові частини"];
const UKRAINE_TIME_ZONE = "Europe/Kyiv";

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

export async function getOrCreateCurrentMonthSpreadsheet() {
  const { rootFolderId } = getGoogleConfig();
  const name = getCurrentMonthSpreadsheetName();
  const existing = await findSpreadsheet(name, rootFolderId);
  if (existing) return { spreadsheetId: existing.id, name: existing.name, created: false };

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

  return {
    success: missingSheetTitles.length === 0,
    created: spreadsheet.created,
    spreadsheetId: response.data.spreadsheetId || spreadsheet.spreadsheetId,
    name: response.data.properties?.title || spreadsheet.name,
    timeZone: response.data.properties?.timeZone || null,
    sheets: sheetTitles,
    missingSheetTitles,
  };
}
