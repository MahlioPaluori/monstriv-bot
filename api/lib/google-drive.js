import { google } from "googleapis";
import { Readable } from "node:stream";

const FOLDER_MIME = "application/vnd.google-apps.folder";
const APPLICATION_ID_PATTERN = /^\d{4}-\d{6,}$/;

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

function requiredFolderName(value, label) {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) throw new Error(`${label} is missing`);
  const normalized = trimmed.replace(/[\\/:*?"<>|]/g, "_").slice(0, 200);
  if (!normalized) throw new Error(`${label} is invalid`);
  return normalized;
}

function fileExtension(fileName, mimeType) {
  const match = typeof fileName === "string" && fileName.match(/(\.[a-z0-9]+)$/i);
  if (match) return match[1].toLowerCase();
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" }[mimeType] || ".bin";
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

export async function finalizeMilitaryRequestDocuments({ militaryUnitNumber, contactName, applicationId, documents }) {
  const unitNumber = typeof militaryUnitNumber === "string" ? militaryUnitNumber.trim() : "";
  if (!unitNumber) throw new Error("Military unit number is missing");
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  if (!Array.isArray(documents)) throw new Error("Military request documents are invalid");

  const unitFolderName = safeFolderName(unitNumber);
  const contactFolderName = requiredFolderName(contactName, "Military contact name");
  const unitFolder = await getOrCreateApplicantFolder("military_unit", unitFolderName);
  const contactFolder = await getOrCreateFolder(contactFolderName, unitFolder.id);
  const drive = getDrive();
  const finalizedDocuments = [];

  for (let index = 0; index < documents.length; index += 1) {
    const document = documents[index];
    const fileId = document?.driveFileId;
    if (typeof fileId !== "string" || !fileId) throw new Error(`Military request document ${index + 1} has no Drive file ID`);

    const currentResponse = await drive.files.get({
      fileId,
      fields: "id,name,parents,mimeType,webViewLink,trashed",
      supportsAllDrives: true,
    });
    const current = currentResponse.data;
    if (!current.id || current.trashed) throw new Error(`Military request document ${index + 1} is missing or trashed`);

    const metadataExtension = fileExtension(document.fileName);
    const extension = metadataExtension !== ".bin" ? metadataExtension : fileExtension(current.name, current.mimeType);
    const desiredName = safeFileName(`${applicationId}_official_request${index + 1}${extension}`);
    const currentParents = Array.isArray(current.parents) ? current.parents.filter(Boolean) : [];
    const hasTargetParent = currentParents.includes(contactFolder.id);
    const parentsToRemove = currentParents.filter((parentId) => parentId !== contactFolder.id);
    const nameNeedsUpdate = current.name !== desiredName;
    const parentsNeedUpdate = !hasTargetParent || parentsToRemove.length > 0;
    let finalized = current;

    if (nameNeedsUpdate || parentsNeedUpdate) {
      const updateResponse = await drive.files.update({
        fileId,
        addParents: hasTargetParent ? undefined : contactFolder.id,
        removeParents: parentsToRemove.length ? parentsToRemove.join(",") : undefined,
        requestBody: nameNeedsUpdate ? { name: desiredName } : {},
        fields: "id,name,parents,mimeType,webViewLink,trashed",
        supportsAllDrives: true,
      });
      finalized = updateResponse.data;
    }

    finalizedDocuments.push({
      ...document,
      fileName: finalized.name || desiredName,
      driveUrl: finalized.webViewLink || current.webViewLink || document.driveUrl || `https://drive.google.com/file/d/${fileId}/view`,
    });
  }

  return finalizedDocuments;
}
