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

export async function getOrCreateIndividualMultiBeneficiaryFolder(applicantName, beneficiaryName) {
  const physicalRootFolder = await getOrCreateRootSubfolder("ФІЗ");
  const applicantFolder = await getOrCreateFolder(requiredFolderName(applicantName, "Individual applicant name"), physicalRootFolder.id);
  return getOrCreateFolder(requiredFolderName(beneficiaryName, "Individual beneficiary name"), applicantFolder.id);
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

async function cleanupEmptyMultiParentFolder(drive, folderId, protectedFolderIds, assertOwnership = async () => {}) {
  if (!folderId || protectedFolderIds.has(folderId)) return;
  try {
    await assertOwnership();
    const folderResponse = await drive.files.get({
      fileId: folderId,
      fields: "id,mimeType,trashed",
      supportsAllDrives: true,
    });
    await assertOwnership();
    const folder = folderResponse.data;
    if (!folder.id || folder.trashed || folder.mimeType !== FOLDER_MIME) return;

    await assertOwnership();
    const childrenResponse = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: "files(id)",
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    await assertOwnership();
    if (childrenResponse.data.files?.length) return;

    await assertOwnership();
    await drive.files.update({
      fileId: folderId,
      requestBody: { trashed: true },
      fields: "id,trashed",
      supportsAllDrives: true,
    });
    await assertOwnership();
  } catch (error) {
    if (error?.code === "CONFIRMATION_CLAIM_LOST") throw error;
    console.error("Empty multi folder cleanup failed:", error?.message || "Unknown error");
  }
}

function selectMarkedCopy(files, markerKey, marker) {
  const validCopies = (files || [])
    .filter((file) => typeof file?.id === "string"
      && file.id
      && file.trashed !== true
      && file.appProperties?.[markerKey] === marker)
    .sort((left, right) => left.id.localeCompare(right.id));
  if ((files || []).length && !validCopies.length) throw new Error(`Drive copies for marker ${markerKey} have incomplete metadata`);
  if (validCopies.length > 1) console.warn(`Multiple Drive copies found for ${markerKey}; using deterministic copy ${validCopies[0].id}`);
  return validCopies[0] || null;
}

async function findOrCreateMarkedCopy({ drive, sourceFileId, targetFolderId, desiredName, markerKey, marker, assertOwnership = async () => {} }) {
  const escapedMarker = escapeQueryValue(marker);
  const existingCopies = [];
  let pageToken;
  do {
    await assertOwnership();
    const existingResponse = await drive.files.list({
      q: `appProperties has { key='${markerKey}' and value='${escapedMarker}' } and trashed = false`,
      fields: "nextPageToken,files(id,name,parents,mimeType,webViewLink,trashed,appProperties)",
      pageSize: 1000,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    await assertOwnership();
    existingCopies.push(...(existingResponse.data.files || []));
    pageToken = existingResponse.data.nextPageToken || null;
  } while (pageToken);
  let copy = selectMarkedCopy(existingCopies, markerKey, marker);
  if (!copy) {
    await assertOwnership();
    const sourceResponse = await drive.files.get({
      fileId: sourceFileId,
      fields: "id,name,mimeType,trashed",
      supportsAllDrives: true,
    });
    await assertOwnership();
    const source = sourceResponse.data;
    if (!source.id || source.trashed) throw new Error(`Drive copy source ${sourceFileId} is missing or trashed`);
    await assertOwnership();
    const copyResponse = await drive.files.copy({
      fileId: sourceFileId,
      requestBody: {
        name: desiredName,
        parents: [targetFolderId],
        appProperties: { [markerKey]: marker },
      },
      fields: "id,name,parents,mimeType,webViewLink,trashed,appProperties",
      supportsAllDrives: true,
    });
    await assertOwnership();
    copy = copyResponse.data;
  }

  if (!copy?.id || copy.trashed || copy.appProperties?.[markerKey] !== marker) throw new Error(`Created Drive copy for ${markerKey} has incomplete metadata`);
  const currentParents = Array.isArray(copy.parents) ? copy.parents.filter(Boolean) : [];
  const hasTargetParent = currentParents.includes(targetFolderId);
  const parentsToRemove = currentParents.filter((parentId) => parentId !== targetFolderId);
  if (copy.name !== desiredName || !hasTargetParent || parentsToRemove.length) {
    await assertOwnership();
    const updateResponse = await drive.files.update({
      fileId: copy.id,
      addParents: hasTargetParent ? undefined : targetFolderId,
      removeParents: parentsToRemove.length ? parentsToRemove.join(",") : undefined,
      requestBody: copy.name === desiredName ? {} : { name: desiredName },
      fields: "id,name,parents,mimeType,webViewLink,trashed,appProperties",
      supportsAllDrives: true,
    });
    await assertOwnership();
    copy = updateResponse.data;
  }
  if (!copy?.id || copy.trashed || !Array.isArray(copy.parents) || !copy.parents.includes(targetFolderId) || !copy.name) {
    throw new Error(`Final Drive copy for ${markerKey} has incomplete metadata`);
  }
  return copy;
}

export async function materializeReusedApplicantDocument({ drive, applicationId, beneficiaryIndex, documentKey, fileIndex, beneficiaryFolder, document, assertOwnership = async () => {} }) {
  const sourceFileId = document?.sourceDriveFileId;
  if (typeof sourceFileId !== "string" || !sourceFileId) throw new Error(`Reused ${documentKey} file ${fileIndex + 1} has no source Drive file ID`);
  const copyMarker = `${applicationId}:person${beneficiaryIndex + 1}:${documentKey}:${fileIndex + 1}:${sourceFileId}`;
  let extension = fileExtension(document.fileName);
  if (extension === ".bin") {
    await assertOwnership();
    const sourceResponse = await drive.files.get({ fileId: sourceFileId, fields: "id,name,mimeType,trashed", supportsAllDrives: true });
    await assertOwnership();
    if (!sourceResponse.data?.id || sourceResponse.data.trashed) throw new Error(`Reused source ${documentKey} file ${fileIndex + 1} is missing or trashed`);
    extension = fileExtension(sourceResponse.data.name, sourceResponse.data.mimeType);
  }
  const desiredName = safeFileName(`${applicationId}_person${beneficiaryIndex + 1}_${documentKey}${fileIndex + 1}${extension}`);
  const copy = await findOrCreateMarkedCopy({
    drive,
    sourceFileId,
    targetFolderId: beneficiaryFolder.id,
    desiredName,
    markerKey: "monstrivReusedDocument",
    marker: copyMarker,
    assertOwnership,
  });

  const finalizedDocument = {
    ...document,
    driveFileId: copy.id,
    fileName: copy.name || desiredName,
    driveUrl: copy.webViewLink || `https://drive.google.com/file/d/${copy.id}/view`,
  };
  delete finalizedDocument.reusedFromApplicantProfile;
  return finalizedDocument;
}

export async function finalizeIndividualMultiRequestDocuments({ applicantName, applicationId, beneficiaries, onDocumentFinalized = null, assertOwnership = async () => {} }) {
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  if (!Array.isArray(beneficiaries) || beneficiaries.length < 2) throw new Error("Multi request beneficiaries are invalid");

  const applicantFolderName = requiredFolderName(applicantName, "Individual applicant name");
  await assertOwnership();
  const physicalRootFolder = await getOrCreateRootSubfolder("ФІЗ");
  await assertOwnership();
  const applicantFolder = await getOrCreateFolder(applicantFolderName, physicalRootFolder.id);
  await assertOwnership();
  const drive = getDrive();
  const documentKeys = ["passport", "rnokpp", "military_id", "ubd"];
  const finalizedBeneficiaries = [];

  for (let beneficiaryIndex = 0; beneficiaryIndex < beneficiaries.length; beneficiaryIndex += 1) {
    const beneficiary = beneficiaries[beneficiaryIndex];
    const beneficiaryFolderName = requiredFolderName(beneficiary?.name, `Beneficiary ${beneficiaryIndex + 1} name`);
    await assertOwnership();
    const beneficiaryFolder = await getOrCreateFolder(beneficiaryFolderName, applicantFolder.id);
    await assertOwnership();
    const finalizedDocuments = {};

    for (const documentKey of documentKeys) {
      const documents = beneficiary?.documents?.[documentKey] || [];
      if (!Array.isArray(documents)) throw new Error(`Beneficiary ${beneficiaryIndex + 1} ${documentKey} documents are invalid`);
      finalizedDocuments[documentKey] = [];

      for (let fileIndex = 0; fileIndex < documents.length; fileIndex += 1) {
        const document = documents[fileIndex];
        if (document?.reusedFromApplicantProfile) {
          const finalizedDocument = await materializeReusedApplicantDocument({
            drive,
            applicationId,
            beneficiaryIndex,
            documentKey,
            fileIndex,
            beneficiaryFolder,
            document,
            assertOwnership,
          });
          finalizedDocuments[documentKey].push(finalizedDocument);
          beneficiary.documents[documentKey][fileIndex] = finalizedDocument;
          if (typeof onDocumentFinalized === "function") await onDocumentFinalized({ beneficiaryIndex, documentKey, fileIndex, document: finalizedDocument });
          continue;
        }
        const fileId = document?.driveFileId;
        if (typeof fileId !== "string" || !fileId) throw new Error(`Beneficiary ${beneficiaryIndex + 1} ${documentKey} file ${fileIndex + 1} has no Drive file ID`);

        await assertOwnership();
        const currentResponse = await drive.files.get({
          fileId,
          fields: "id,name,parents,mimeType,webViewLink,trashed",
          supportsAllDrives: true,
        });
        await assertOwnership();
        const current = currentResponse.data;
        if (!current.id || current.trashed) throw new Error(`Beneficiary ${beneficiaryIndex + 1} ${documentKey} file ${fileIndex + 1} is missing or trashed`);

        const metadataExtension = fileExtension(document.fileName);
        const currentNameExtension = fileExtension(current.name);
        const mimeExtension = fileExtension("", current.mimeType);
        const extension = metadataExtension !== ".bin"
          ? metadataExtension
          : currentNameExtension !== ".bin"
            ? currentNameExtension
            : mimeExtension;
        const desiredName = safeFileName(`${applicationId}_person${beneficiaryIndex + 1}_${documentKey}${fileIndex + 1}${extension}`);
        const currentParents = Array.isArray(current.parents) ? current.parents.filter(Boolean) : [];
        const hasTargetParent = currentParents.includes(beneficiaryFolder.id);
        const parentsToRemove = currentParents.filter((parentId) => parentId !== beneficiaryFolder.id);
        const nameNeedsUpdate = current.name !== desiredName;
        const parentsNeedUpdate = !hasTargetParent || parentsToRemove.length > 0;
        let finalized = current;

        if (nameNeedsUpdate || parentsNeedUpdate) {
          await assertOwnership();
          const updateResponse = await drive.files.update({
            fileId,
            addParents: hasTargetParent ? undefined : beneficiaryFolder.id,
            removeParents: parentsToRemove.length ? parentsToRemove.join(",") : undefined,
            requestBody: nameNeedsUpdate ? { name: desiredName } : {},
            fields: "id,name,parents,mimeType,webViewLink,trashed",
            supportsAllDrives: true,
          });
          await assertOwnership();
          finalized = updateResponse.data;
        }

        const protectedFolderIds = new Set([physicalRootFolder.id, applicantFolder.id, beneficiaryFolder.id]);
        for (const previousParentId of parentsToRemove) {
          await cleanupEmptyMultiParentFolder(drive, previousParentId, protectedFolderIds, assertOwnership);
        }

        const finalizedDocument = {
          ...document,
          driveFileId: fileId,
          fileName: finalized.name || desiredName,
          driveUrl: finalized.webViewLink || current.webViewLink || document.driveUrl || `https://drive.google.com/file/d/${fileId}/view`,
        };
        finalizedDocuments[documentKey].push(finalizedDocument);
        beneficiary.documents[documentKey][fileIndex] = finalizedDocument;
        if (typeof onDocumentFinalized === "function") await onDocumentFinalized({ beneficiaryIndex, documentKey, fileIndex, document: finalizedDocument });
      }
    }

    finalizedBeneficiaries.push({ ...beneficiary, documents: finalizedDocuments });
  }

  return finalizedBeneficiaries;
}

export async function createCanonicalApplicantDocumentCopies({ applicantName, applicationId, documents, onDocumentCopied = null, drive: suppliedDrive = null, profileFolder: suppliedProfileFolder = null, assertOwnership = async () => {} }) {
  if (typeof applicationId !== "string" || !APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Invalid application ID");
  let profileFolder = suppliedProfileFolder;
  if (!profileFolder) {
    const applicantFolderName = requiredFolderName(applicantName, "Individual applicant name");
    await assertOwnership();
    const physicalRootFolder = await getOrCreateRootSubfolder("ФІЗ");
    await assertOwnership();
    const applicantFolder = await getOrCreateFolder(applicantFolderName, physicalRootFolder.id);
    await assertOwnership();
    profileFolder = await getOrCreateFolder("Збережені документи", applicantFolder.id);
    await assertOwnership();
  }
  if (!profileFolder?.id) throw new Error("Applicant profile folder is missing");
  const drive = suppliedDrive || getDrive();
  const documentKeys = ["passport", "rnokpp", "military_id", "ubd"];
  const canonicalDocuments = {};

  for (const documentKey of documentKeys) {
    const sourceDocuments = documents?.[documentKey] || [];
    if (!Array.isArray(sourceDocuments)) throw new Error(`Applicant ${documentKey} documents are invalid`);
    canonicalDocuments[documentKey] = [];
    for (let fileIndex = 0; fileIndex < sourceDocuments.length; fileIndex += 1) {
      const document = sourceDocuments[fileIndex];
      const sourceFileId = document?.driveFileId;
      if (typeof sourceFileId !== "string" || !sourceFileId) throw new Error(`Applicant ${documentKey} file ${fileIndex + 1} has no Drive file ID`);
      let extension = fileExtension(document.fileName);
      if (extension === ".bin") extension = fileExtension("", document.mimeType);
      const marker = `${applicationId}:profile:${documentKey}:${fileIndex + 1}:${sourceFileId}`;
      const desiredName = safeFileName(`${applicationId}_profile_${documentKey}${fileIndex + 1}${extension}`);
      const copy = await findOrCreateMarkedCopy({
        drive,
        sourceFileId,
        targetFolderId: profileFolder.id,
        desiredName,
        markerKey: "monstrivCanonicalApplicantDocument",
        marker,
        assertOwnership,
      });
      const canonicalDocument = {
        ...document,
        driveFileId: copy.id,
        fileName: copy.name,
        driveUrl: copy.webViewLink || `https://drive.google.com/file/d/${copy.id}/view`,
        receivedAt: document.receivedAt || new Date().toISOString(),
      };
      delete canonicalDocument.sourceDriveFileId;
      delete canonicalDocument.sourceDriveUrl;
      delete canonicalDocument.reusedFromApplicantProfile;
      canonicalDocuments[documentKey].push(canonicalDocument);
      if (typeof onDocumentCopied === "function") await onDocumentCopied({ documentKey, fileIndex, document: canonicalDocument });
    }
  }
  return canonicalDocuments;
}
