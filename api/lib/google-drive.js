import { google } from "googleapis";
import { Readable } from "node:stream";

const FOLDER_MIME = "application/vnd.google-apps.folder";

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;
  if (!clientId || !clientSecret || !refreshToken || !rootFolderId) throw new Error("Google Drive environment variables are missing");
  return { clientId, clientSecret, refreshToken, rootFolderId };
}

function getDrive() {
  const { clientId, clientSecret, refreshToken } = getConfig();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
}

function escapeQueryValue(value) { return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'"); }
function safeFolderName(value) { return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 200) || "Без назви"; }
function safeFileName(value) { return String(value || "file").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 200) || "file"; }

export async function getDriveRootFolder() {
  const { rootFolderId } = getConfig();
  const drive = getDrive();
  const response = await drive.files.get({ fileId: rootFolderId, fields: "id,name,mimeType,trashed", supportsAllDrives: true });
  return response.data;
}

export async function findFolder(name, parentId) {
  const drive = getDrive();
  const escapedName = escapeQueryValue(name);
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name,mimeType)", pageSize: 10, supportsAllDrives: true, includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0] || null;
}

export async function getOrCreateFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;
  const drive = getDrive();
  const response = await drive.files.create({ requestBody: { name: safeFolderName(name), mimeType: FOLDER_MIME, parents: [parentId] }, fields: "id,name,mimeType", supportsAllDrives: true });
  return response.data;
}

export async function getOrCreateRootSubfolder(name) {
  const { rootFolderId } = getConfig();
  return getOrCreateFolder(name, rootFolderId);
}

export async function getOrCreateApplicantFolder(type, identifier) {
  const typeFolder = await getOrCreateRootSubfolder(type === "military_unit" ? "ВЧ" : "ФІЗ");
  return getOrCreateFolder(identifier, typeFolder.id);
}

export async function getOrCreatePhysicalApplicantFolder(identifier) {
  const physicalRoot = await getOrCreateRootSubfolder("Фізособи");
  return getOrCreateFolder(identifier, physicalRoot.id);
}

export async function getOrCreateMilitaryRequestFolder({ unitNumber, responsibleName, applicationNumber, date = new Date() }) {
  if (!unitNumber || !responsibleName || !applicationNumber) throw new Error("Military request folder data is missing");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const year = date.getFullYear();
  const requestsRoot = await getOrCreateRootSubfolder(`Запити-${month}-${year}`);
  const unitsRoot = await getOrCreateFolder("Військові частини", requestsRoot.id);
  const unitFolder = await getOrCreateFolder(unitNumber, unitsRoot.id);
  const responsibleFolder = await getOrCreateFolder(responsibleName, unitFolder.id);
  return getOrCreateFolder(applicationNumber, responsibleFolder.id);
}

export async function getOrCreateRequestFolder(request) {
  if (request.type === "military_unit") {
    return getOrCreateMilitaryRequestFolder({
      unitNumber: request.data?.militaryUnitNumber,
      responsibleName: request.data?.name,
      applicationNumber: request.applicationNumber,
    });
  }
  return getOrCreatePhysicalApplicantFolder(request.data?.name);
}

export async function uploadBufferToDrive({ buffer, name, mimeType, parentId }) {
  const drive = getDrive();
  const response = await drive.files.create({
    requestBody: { name: safeFileName(name), parents: [parentId] },
    media: { mimeType: mimeType || "application/octet-stream", body: Readable.from(buffer) },
    fields: "id,name,mimeType,size,webViewLink",
    supportsAllDrives: true,
  });
  return response.data;
}
