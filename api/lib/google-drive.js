import { google } from "googleapis";
import { Readable } from "node:stream";

const FOLDER_MIME = "application/vnd.google-apps.folder";

export function getGoogleConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken || !rootFolderId) {
    throw new Error("Google Drive environment variables are missing");
  }

  return { clientId, clientSecret, refreshToken, rootFolderId };
}

export function getGoogleAuth() {
  const { clientId, clientSecret, refreshToken } = getGoogleConfig();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return auth;
}

export function getDrive() {
  const auth = getGoogleAuth();
  return google.drive({ version: "v3", auth });
}

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function safeFolderName(value) {
  return String(value || "").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 200) || "Без назви";
}

function safeFileName(value) {
  return String(value || "file").trim().replace(/[\\/:*?"<>|]/g, "_").slice(0, 200) || "file";
}

export async function getDriveRootFolder() {
  const { rootFolderId } = getGoogleConfig();
  const drive = getDrive();
  const response = await drive.files.get({
    fileId: rootFolderId,
    fields: "id,name,mimeType,trashed",
    supportsAllDrives: true,
  });
  return response.data;
}

export async function findFolder(name, parentId) {
  const drive = getDrive();
  const escapedName = escapeQueryValue(name);
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = '${FOLDER_MIME}' and trashed = false`,
    fields: "files(id,name,mimeType)",
    pageSize: 10,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return response.data.files?.[0] || null;
}

export async function getOrCreateFolder(name, parentId) {
  const existing = await findFolder(name, parentId);
  if (existing) return existing;

  const drive = getDrive();
  const response = await drive.files.create({
    requestBody: {
      name: safeFolderName(name),
      mimeType: FOLDER_MIME,
      parents: [parentId],
    },
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });
  return response.data;
}

export async function getOrCreateRootSubfolder(name) {
  const { rootFolderId } = getGoogleConfig();
  return getOrCreateFolder(name, rootFolderId);
}

export async function getOrCreateApplicantFolder(type, identifier) {
  const typeFolder = await getOrCreateRootSubfolder(type === "military_unit" ? "ВЧ" : "ФІЗ");
  return getOrCreateFolder(identifier, typeFolder.id);
}

export async function uploadBufferToDrive({ buffer, name, mimeType, parentId }) {
  const drive = getDrive();
  const response = await drive.files.create({
    requestBody: {
      name: safeFileName(name),
      parents: [parentId],
    },
    media: {
      mimeType: mimeType || "application/octet-stream",
      body: Readable.from(buffer),
    },
    fields: "id,name,mimeType,size,webViewLink",
    supportsAllDrives: true,
  });
  return response.data;
}
