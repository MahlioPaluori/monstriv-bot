import { google } from "googleapis";

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const spreadsheetId = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;

  if (!clientId || !clientSecret || !refreshToken || !spreadsheetId) {
    throw new Error("Google Sheets environment variables are missing");
  }

  return { clientId, clientSecret, refreshToken, spreadsheetId };
}

function getSheets() {
  const { clientId, clientSecret, refreshToken } = getConfig();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.sheets({ version: "v4", auth });
}

function documentsToLinks(documents = {}) {
  return Object.entries(documents)
    .flatMap(([key, files]) => (Array.isArray(files) ? files.map((file) => `${key}: ${file.driveUrl || file.driveFileId || ""}`) : []))
    .filter(Boolean)
    .join("\n");
}

export async function appendApplicationToSheet(request) {
  const sheets = getSheets();
  const { spreadsheetId } = getConfig();
  const sheetName = request.type === "military_unit"
    ? (process.env.GOOGLE_SHEETS_MILITARY_SHEET_NAME || "Військові частини")
    : (process.env.GOOGLE_SHEETS_INDIVIDUAL_SHEET_NAME || "Фізособи");
  const data = request.data || {};

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
}
