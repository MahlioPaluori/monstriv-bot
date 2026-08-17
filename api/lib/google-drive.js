import { google } from "googleapis";

function getConfig() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  const rootFolderId = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID;

  if (!clientId || !clientSecret || !refreshToken || !rootFolderId) {
    throw new Error("Google Drive environment variables are missing");
  }

  return { clientId, clientSecret, refreshToken, rootFolderId };
}

function getDrive() {
  const { clientId, clientSecret, refreshToken } = getConfig();
  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({ refresh_token: refreshToken });
  return google.drive({ version: "v3", auth });
}

export async function getDriveRootFolder() {
  const { rootFolderId } = getConfig();
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
  const escapedName = name.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const response = await drive.files.list({
    q: `'${parentId}' in parents and name = '${escapedName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`,
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
      name,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    },
    fields: "id,name,mimeType",
    supportsAllDrives: true,
  });

  return response.data;
}

export async function getOrCreateRootSubfolder(name) {
  const { rootFolderId } = getConfig();
  return getOrCreateFolder(name, rootFolderId);
}
