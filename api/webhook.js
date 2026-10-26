import { randomUUID } from "node:crypto";
import {
  acquireConfirmationClaim,
  advanceDocumentStage,
  beginDocumentUpload,
  CONFIRMATION_CLAIM_TTL_SECONDS,
  completeDocumentUpload,
  createApplicationNumber,
  createUserState,
  failDocumentUpload,
  getApplicantProfile,
  getMilitaryContactProfile,
  getUserState,
  initializeUserSession,
  isKnownUser,
  getKyivApplicationPeriod,
  markUserKnown,
  nextDocumentSequence,
  ownsConfirmationClaim,
  releaseConfirmationClaim,
  renewDocumentUpload,
  renewConfirmationClaim,
  resetUserState,
  saveApplicantProfile,
  saveMilitaryContactProfile,
  saveUserState,
} from "../lib/state.js";
import { downloadWhatsAppMedia } from "../lib/meta-media.js";
import { filterValidatedDocuments, isValidatedDocument, MediaValidationError } from "../lib/media-validation.js";
import { messages } from "../lib/messages.js";
import { createCanonicalApplicantDocumentCopies, finalizeIndividualMultiRequestDocuments, finalizeMilitaryRequestDocuments, getOrCreateApplicantFolder, getOrCreateIndividualMultiBeneficiaryFolder, uploadBufferToDrive } from "../lib/google-drive.js";
import { appendConfirmedMultiRequest, appendConfirmedRequest, assertRequestNeedWithinSheetsLimit, findRequestByApplicationId, getMaxApplicationSequenceForPeriod, MAX_SHEETS_CELL_CHARACTERS, sheetsTextLength, updateMilitaryRequestDocumentLinks } from "../lib/google-sheets.js";
import {
  sendActiveRequestNavigation,
  sendApplicationAccepted,
  sendApplicantTypeMenu,
  sendBeneficiaryEditFieldMenu,
  sendCancelRequestConfirmation,
  sendDocumentDone,
  sendEditMenu,
  sendMainMenu,
  sendMultiApplicantIncludedMenu,
  sendMultiSavedDocumentsMenu,
  sendOperatorMenu,
  sendOptionalDocumentPrompt,
  sendPackageModeMenu,
  sendReturningApplicantMenu,
  sendText,
  sendYesNoMenu,
} from "../lib/whatsapp.js";

const PHYSICAL_DOCUMENTS = [
  { key: "passport", ...messages.documents.definitions.passport },
  { key: "rnokpp", ...messages.documents.definitions.rnokpp },
  { key: "military_id", ...messages.documents.definitions.militaryId },
  { key: "ubd", ...messages.documents.definitions.ubd, optional: true },
];
const MILITARY_UNIT_DOCUMENTS = [{ key: "official_request", ...messages.documents.definitions.officialRequest }];
const MAX_MULTI_BENEFICIARIES = 5;
const REQUIRED_PHYSICAL_DOCUMENT_KEYS = PHYSICAL_DOCUMENTS.filter((doc) => !doc.optional).map((doc) => doc.key);
const MENU_COMMANDS = new Set(["/menu", "меню", "/start", "start", "старт"]);
const ICE_BREAKER_TEXT = "натисніть на це повідомлення, щоб почати";
const EDIT_FIELD_PROMPTS = messages.editing.fieldPrompts;
const NEED_TOO_LONG_MESSAGE = messages.confirmation.needTooLong({ limit: MAX_SHEETS_CELL_CHARACTERS });

function requestNeedFitsSheets(value) {
  const lengths = sheetsTextLength(value);
  return lengths.codePoints <= MAX_SHEETS_CELL_CHARACTERS
    && lengths.utf16CodeUnits <= MAX_SHEETS_CELL_CHARACTERS;
}

function logRejectedNeed(stage, value) {
  const lengths = sheetsTextLength(value);
  console.info(JSON.stringify({
    event: "request_need_rejected",
    stage,
    errorCode: "REQUEST_NEED_TOO_LONG",
    codePointLength: lengths.codePoints,
    utf16CodeUnitLength: lengths.utf16CodeUnits,
    limit: MAX_SHEETS_CELL_CHARACTERS,
  }));
}

function docs(state) { return state.request?.type === "military_unit" ? MILITARY_UNIT_DOCUMENTS : PHYSICAL_DOCUMENTS; }
function activeBeneficiary(state) { return state.request?.multiPackage ? state.request.beneficiaries?.[state.request.currentBeneficiaryIndex] || null : null; }
function activeDocumentStore(state) { return activeBeneficiary(state) || state.request; }
function currentDoc(state) { return docs(state)[activeDocumentStore(state).documentIndex || 0] || null; }
export function formatDocumentSummary(documents, requestType = "individual") {
  const definitions = requestType === "military_unit" ? MILITARY_UNIT_DOCUMENTS : PHYSICAL_DOCUMENTS;
  const lines = definitions.flatMap((definition) => {
    const files = documents?.[definition.key];
    return Array.isArray(files) && files.length ? [messages.documents.summaryLine({ label: definition.confirmationLabel, count: files.length })] : [];
  });
  return [messages.documents.summaryHeading, ...lines].join("\n");
}
function normalizePhone(value) {
  const compact = String(value || "").trim().replace(/[\s()-]/g, "");
  if (!/^\+?\d{7,15}$/.test(compact)) return null;
  return compact;
}
function beneficiaryIsComplete(beneficiary) {
  return Boolean(beneficiary?.name?.trim()
    && normalizePhone(beneficiary.phone)
    && REQUIRED_PHYSICAL_DOCUMENT_KEYS.every((key) => beneficiary.documents?.[key]?.length));
}
function beneficiariesAreComplete(state) {
  const request = state.request;
  return Boolean(request?.multiPackage
    && Number.isInteger(request.beneficiaryCount)
    && request.beneficiaryCount >= 2
    && request.beneficiaryCount <= MAX_MULTI_BENEFICIARIES
    && request.beneficiaries?.length === request.beneficiaryCount
    && request.beneficiaries.every(beneficiaryIsComplete));
}
function clearSavedMultiFields(request, from) {
  const applicantName = request.data?.name;
  const need = request.data?.need;
  request.data = { name: applicantName, phone: from, need };
  request.documents = {};
  request.documentIndex = 0;
  request.multiPackage = true;
  request.usingSavedApplicantIdentity = Boolean(request.usingSavedData);
  request.usingSavedData = false;
  delete request.savedDocumentsUpdatedAt;
  delete request.profile;
}
function emptyBeneficiaries(count) {
  return Array.from({ length: count }, () => ({ name: "", phone: "", documents: {}, documentIndex: 0 }));
}
function hasCompleteSavedApplicantPackage(request) {
  return Boolean(request?.usingSavedData
    && request.data?.name?.trim()
    && normalizePhone(request.data.phone)
    && REQUIRED_PHYSICAL_DOCUMENT_KEYS.every((key) => request.documents?.[key]?.length
      && request.documents[key].every((document) => typeof document?.driveFileId === "string" && document.driveFileId && isValidatedDocument(document)))
    && PHYSICAL_DOCUMENTS.every(({ key }) => !request.documents?.[key]
      || request.documents[key].every((document) => typeof document?.driveFileId === "string" && document.driveFileId && isValidatedDocument(document))));
}
function savedApplicantSourceDocuments(documents) {
  return Object.fromEntries(PHYSICAL_DOCUMENTS.map(({ key }) => [key, (documents?.[key] || []).map((document) => ({
    ...document,
    sourceDriveFileId: document.driveFileId,
    sourceDriveUrl: document.driveUrl,
    driveFileId: null,
    driveUrl: null,
    reusedFromApplicantProfile: true,
  }))]));
}
function startMultiCollection(request, from, applicantMode = "none") {
  const savedDocuments = applicantMode === "saved" ? savedApplicantSourceDocuments(request.documents) : null;
  const applicantName = request.data?.name;
  const applicantPhone = request.data?.phone || from;
  const count = request.beneficiaryCount;
  clearSavedMultiFields(request, from);
  request.refreshApplicantProfileDocuments = applicantMode === "replace";
  delete request.canonicalApplicantDocuments;
  delete request.canonicalApplicantDocumentsUpdatedAt;
  request.beneficiaries = emptyBeneficiaries(count);
  request.currentBeneficiaryIndex = 0;
  if (applicantMode === "saved" || applicantMode === "replace") {
    request.beneficiaries[0] = {
      name: applicantName,
      phone: applicantPhone,
      documents: savedDocuments || {},
      documentIndex: applicantMode === "saved" ? PHYSICAL_DOCUMENTS.length : 0,
      isApplicant: true,
    };
    request.currentBeneficiaryIndex = applicantMode === "saved" ? 1 : 0;
  }
}
function parseMultiDocumentButton(buttonId) {
  const match = /^document_(done|skip)_(\d+)_(passport|rnokpp|military_id|ubd)$/.exec(buttonId || "");
  return match ? { action: match[1], beneficiaryIndex: Number(match[2]), documentKey: match[3] } : null;
}
function mediaId(message) {
  if (message.type === "image") return message.image?.id || null;
  if (message.type === "document") return message.document?.id || null;
  return null;
}
function documentsAreOlderThanYear(dateString) {
  if (!dateString) return true;
  const updated = new Date(dateString).getTime();
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated > 365 * 24 * 60 * 60 * 1000;
}

export function prepareSavedDocumentsForReuse(documents) {
  const savedDocuments = JSON.parse(JSON.stringify(documents || {}));
  const validatedDocuments = filterValidatedDocuments(savedDocuments);
  const savedCount = Object.values(savedDocuments).reduce((count, files) => count + (Array.isArray(files) ? files.length : 0), 0);
  const validatedCount = Object.values(validatedDocuments).reduce((count, files) => count + files.length, 0);
  const legacyDocumentsRequireUpload = savedCount > validatedCount;
  return {
    documents: legacyDocumentsRequireUpload ? {} : validatedDocuments,
    legacyDocumentsRequireUpload,
  };
}

function documentCollections(request) {
  const collections = [request?.documents];
  if (Array.isArray(request?.beneficiaries)) collections.push(...request.beneficiaries.map((beneficiary) => beneficiary?.documents));
  return collections.filter((documents) => documents && typeof documents === "object" && !Array.isArray(documents));
}

export function requestDocumentsHaveValidation(request) {
  for (const documents of documentCollections(request)) {
    for (const files of Object.values(documents)) {
      if (!Array.isArray(files) || files.some((document) => !isValidatedDocument(document))) return false;
    }
  }
  return true;
}

export function assertRequestDocumentsHaveValidation(request) {
  if (!requestDocumentsHaveValidation(request)) {
    throw new MediaValidationError("UNVALIDATED_REQUEST_DOCUMENTS", "Request contains documents without current validation metadata");
  }
}

export async function restartRequestWithUnvalidatedDocuments(from, state, services = {}) {
  if (requestDocumentsHaveValidation(state.request)) return false;
  const persistState = services.saveUserState || saveUserState;
  const notify = services.sendText || sendText;
  const showApplicantTypes = services.sendApplicantTypeMenu || sendApplicantTypeMenu;
  state.stage = "APPLICANT_TYPE";
  state.request = { type: null, data: { phone: from }, documents: {}, documentIndex: 0 };
  delete state.editField;
  delete state.editBeneficiaryIndex;
  delete state.editBeneficiaryField;
  delete state.cancelReturnStage;
  await persistState(from, state);
  await notify(from, messages.documents.legacyRequestRestart);
  await showApplicantTypes(from);
  return true;
}

export async function saveIncomingDocument(from, state, message, fileId, doc, services = {}) {
  const beginUpload = services.beginDocumentUpload || beginDocumentUpload;
  const completeUpload = services.completeDocumentUpload || completeDocumentUpload;
  const failUpload = services.failDocumentUpload || failDocumentUpload;
  const renewUpload = services.renewDocumentUpload || renewDocumentUpload;
  const downloadMedia = services.downloadWhatsAppMedia || downloadWhatsAppMedia;
  const uploadDrive = services.uploadBufferToDrive || uploadBufferToDrive;
  const getApplicantFolder = services.getOrCreateApplicantFolder || getOrCreateApplicantFolder;
  const getMultiFolder = services.getOrCreateIndividualMultiBeneficiaryFolder || getOrCreateIndividualMultiBeneficiaryFolder;
  const nextSequence = services.nextDocumentSequence || nextDocumentSequence;
  const beneficiary = activeBeneficiary(state);
  const documentIndex = activeDocumentStore(state).documentIndex || 0;
  const beneficiaryIndex = beneficiary ? state.request.currentBeneficiaryIndex : null;
  const uploadId = message.id || fileId;
  const beginStatus = await beginUpload(from, uploadId, { documentIndex, beneficiaryIndex, documentKey: doc.key });
  if (beginStatus !== "STARTED") return { status: String(beginStatus).toLowerCase() };
  const heartbeat = setInterval(() => {
    renewUpload(from, uploadId).catch((error) => console.error("Document upload lease renewal failed:", error?.message || "Unknown error"));
  }, 30_000);
  heartbeat.unref?.();
  try {
    const media = await downloadMedia(fileId);
    let folder;
    if (beneficiary) {
      folder = await getMultiFolder(state.request.data.name, beneficiary.name);
    } else {
      const identifier = state.request.type === "military_unit" ? state.request.data.militaryUnitNumber : state.request.data.name;
      if (!identifier) throw new Error("Applicant identifier is missing for Drive folder");
      folder = await getApplicantFolder(state.request.type, identifier);
    }
    const sequenceScope = beneficiary ? `multi:${state.request.currentBeneficiaryIndex}:${doc.key}` : doc.key;
    const sequence = await nextSequence(from, sequenceScope);
    const extension = media.extension;
    if (!extension || !media.validation) throw new MediaValidationError("INVALID_MEDIA", "Validated media metadata is missing");
    const fileName = `${doc.key}${sequence}${extension}`;
    const driveFile = await uploadDrive({ buffer: media.buffer, name: fileName, mimeType: media.mimeType, parentId: folder.id });
    const document = { mediaId: fileId, type: message.type, receivedAt: new Date().toISOString(), driveFileId: driveFile.id, driveUrl: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`, fileName: driveFile.name, mimeType: media.mimeType, fileSize: media.fileSize, validation: media.validation };
    const result = await completeUpload(from, uploadId, { documentIndex, beneficiaryIndex, documentKey: doc.key, document });
    if (result.state) Object.assign(state, result.state);
    if (result.status !== "ADDED") return { status: String(result.status).toLowerCase(), count: result.count || 0 };
    return { status: "added", count: result.count, document };
  } catch (error) {
    await failUpload(from, uploadId);
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

async function showConfirmation(from, state) {
  if (state.request?.multiPackage && !beneficiariesAreComplete(state)) {
    await sendText(from, messages.multipleApplicants.incompleteRequest);
    return askDocument(from, state);
  }
  state.stage = "CONFIRMATION";
  await saveUserState(from, state);
  for (const message of buildConfirmationMessages(from, state)) await sendText(from, message);
  await sendYesNoMenu(from, messages.confirmation.confirmQuestion, "confirm_request", "edit_request");
}

async function sendConfirmationRetryMenu(from) {
  return sendYesNoMenu(from, messages.confirmation.retryQuestion, "confirm_request", "edit_request");
}

function confirmationLog(event, request, details = {}) {
  console.info(JSON.stringify({
    event,
    applicationId: request?.applicationId || null,
    requestType: request?.type === "individual" && request?.multiPackage ? "individual_multi" : request?.type || "unknown",
    ...details,
  }));
}

function isMenuCommand(text) {
  return MENU_COMMANDS.has(String(text || "").trim().toLowerCase());
}

function hasActiveRequest(state) {
  return Boolean(state?.request) && !["NEW", "MAIN_MENU", "OPERATOR", "CONFIRMED"].includes(state.stage);
}

export function startRequestFromMainMenu(state, from) {
  const recoveredRequest = state.recoveredFromNew && state.request && typeof state.request === "object"
    ? state.request
    : null;
  state.operatorRequested = false;
  state.stage = "APPLICANT_TYPE";
  state.request = recoveredRequest || { type: null, data: { phone: from }, documents: {}, documentIndex: 0 };
  state.request.data ||= { phone: from };
  state.request.data.phone ||= from;
  state.request.documents ||= {};
  state.request.documentIndex ??= 0;
  delete state.recoveredFromNew;
  return state;
}

export function shouldSilenceInactiveMessage(state, text, buttonId) {
  return !hasActiveRequest(state) && !isMenuCommand(text) && !buttonId;
}

export function isIceBreakerMessageText(text) {
  const normalizedText = String(text || "").trim().replace(/\s+/g, " ").toLocaleLowerCase("uk-UA");
  return normalizedText === ICE_BREAKER_TEXT;
}

export async function handleIceBreakerMessage(from, text, state, services = {}) {
  if (!isIceBreakerMessageText(text)) return false;
  if (hasActiveRequest(state)) await (services.sendActiveRequestNavigation || sendActiveRequestNavigation)(from);
  else await (services.sendMainMenu || sendMainMenu)(from);
  return true;
}

export function shouldIgnoreWebhookMessage(message) {
  return message?.type === "reaction";
}

export async function handleMissingStateMessage(from, input, services = {}) {
  const { text = "", buttonId = null, recoveringNewState = false } = input;
  const knownUser = services.isKnownUser || isKnownUser;
  const markKnown = services.markUserKnown || markUserKnown;
  const loadApplicantProfile = services.getApplicantProfile || getApplicantProfile;
  const loadMilitaryProfile = services.getMilitaryContactProfile || getMilitaryContactProfile;
  const loadState = services.getUserState || getUserState;
  const initializeSession = services.initializeUserSession || initializeUserSession;
  const showMainMenu = services.sendMainMenu || sendMainMenu;
  const showActiveNavigation = services.sendActiveRequestNavigation || sendActiveRequestNavigation;
  const showApplicantTypeMenu = services.sendApplicantTypeMenu || sendApplicantTypeMenu;
  const showOperatorMenu = services.sendOperatorMenu || sendOperatorMenu;
  const sendWelcome = services.sendText || sendText;

  if (buttonId === "confirm_request") return true;

  const action = buttonId === "send_request"
    ? "SEND_REQUEST"
    : buttonId === "operator"
      ? "OPERATOR"
      : isMenuCommand(text) || isIceBreakerMessageText(text)
        ? "MENU"
        : "NORMAL";

  if (action === "NORMAL" && !recoveringNewState) {
    let known = await knownUser(from);
    if (!known) {
      const applicantProfile = await loadApplicantProfile(from);
      const militaryProfile = applicantProfile ? null : await loadMilitaryProfile(from);
      known = Boolean(applicantProfile || militaryProfile);
      if (known) await markKnown(from);
    }
    if (known) return true;
  }

  const result = await initializeSession(from, action);
  if (action === "MENU") {
    if (hasActiveRequest(result.state)) await showActiveNavigation(from);
    else await showMainMenu(from);
  } else if (action === "SEND_REQUEST" && ["CREATED", "ROUTED"].includes(result.status)) {
    if (result.status === "CREATED") {
      await sendWelcome(from, messages.welcome.directRequest);
    }
    await showApplicantTypeMenu(from);
  } else if (action === "OPERATOR" && ["CREATED", "ROUTED"].includes(result.status)) {
    await showOperatorMenu(from);
  } else if (action === "NORMAL" && result.status === "CREATED") {
    const latestState = await loadState(from);
    if (latestState?.stage !== "MAIN_MENU") return true;
    await sendWelcome(from, messages.welcome.firstContact);
    const stateBeforeMenu = await loadState(from);
    if (stateBeforeMenu?.stage !== "MAIN_MENU") return true;
    await showMainMenu(from);
  }
  return true;
}

export async function backfillKnownUserMarker(from, services = {}) {
  const knownUser = services.isKnownUser || isKnownUser;
  const markKnown = services.markUserKnown || markUserKnown;
  const logFailure = services.logFailure || ((details) => console.error(JSON.stringify(details)));
  try {
    if (!await knownUser(from)) await markKnown(from);
    return true;
  } catch (error) {
    logFailure({ event: "known_user_marker_backfill_failed", errorCode: error?.code || "UNKNOWN" });
    return false;
  }
}

export async function handleDocumentStageFallback(from, state, input, services = {}) {
  if (state.stage !== "DOCUMENTS") return false;
  const { message, text, buttonId, fileId } = input;
  if (!text && !buttonId && !fileId) {
    const logUnsupported = services.logUnsupported || ((details) => console.info(JSON.stringify(details)));
    logUnsupported({
      messageId: message?.id || null,
      messageType: message?.type || null,
      stage: state.stage,
      hasText: Boolean(text),
      hasButtonId: Boolean(buttonId),
      hasFileId: Boolean(fileId),
    });
    return true;
  }
  if (text && !isMenuCommand(text)) {
    const notify = services.sendText || sendText;
    const repeatPrompt = services.repeatCurrentPrompt || repeatCurrentPrompt;
    await notify(from, messages.documents.expectedFileInsteadOfText);
    await repeatPrompt(from, state);
    return true;
  }
  return false;
}

function isValidButtonForStage(state, buttonId) {
  if (!buttonId) return true;
  const buttonsByStage = {
    APPLICANT_TYPE: ["individual", "military_unit"],
    RETURNING_CHOICE: ["use_saved_data", "enter_data_again"],
    PACKAGE_MODE: ["package_single", "package_multi"],
    MULTI_APPLICANT_INCLUDED: ["multi_applicant_yes", "multi_applicant_no"],
    MULTI_SAVED_DOCUMENTS_DECISION: ["multi_saved_use", "multi_saved_replace"],
    DOCUMENT_UPDATE_DECISION: ["update_documents_yes", "update_documents_no"],
    RECIPIENT_CHOICE: ["recipient_other_yes", "recipient_other_no"],
    CONFIRMATION: ["confirm_request", "edit_request"],
    EDIT_BENEFICIARY_FIELD: ["edit_beneficiary_name", "edit_beneficiary_phone"],
    EDIT_RECIPIENT_CHOICE: ["edit_recipient_other_yes", "edit_recipient_other_no"],
  };
  if (state.stage === "DOCUMENTS") {
    if (state.request?.multiPackage) {
      const parsed = parseMultiDocumentButton(buttonId);
      const doc = currentDoc(state);
      return Boolean(parsed && doc
        && parsed.beneficiaryIndex === state.request.currentBeneficiaryIndex
        && parsed.documentKey === doc.key
        && (parsed.action === "done" || (parsed.action === "skip" && doc.optional)));
    }
    const doc = currentDoc(state);
    return buttonId === "document_done" || (buttonId === "document_skip" && doc?.optional);
  }
  if (state.stage === "EDIT_MENU") {
    const valid = ["edit_name", "edit_need", "edit_city", "edit_np", "edit_recipient"];
    if (state.request?.type === "military_unit") valid.push("edit_unit_number");
    if (state.request?.multiPackage) valid.push("edit_beneficiary");
    return valid.includes(buttonId);
  }
  return (buttonsByStage[state.stage] || []).includes(buttonId);
}
async function continueAfterSavedData(from, state) {
  if (!state.request.documents || !Object.keys(state.request.documents).length) return showConfirmation(from, state);
  if (documentsAreOlderThanYear(state.request.savedDocumentsUpdatedAt)) {
    state.stage = "DOCUMENT_UPDATE_DECISION";
    await saveUserState(from, state);
    return sendYesNoMenu(from, messages.documents.oldDocumentsQuestion, "update_documents_yes", "update_documents_no");
  }
  await showConfirmation(from, state);
}
async function askDocument(from, state) {
  const doc = currentDoc(state);
  if (!doc) {
    if (state.request.multiPackage) {
      if (!beneficiaryIsComplete(activeBeneficiary(state))) {
        return sendText(from, messages.multipleApplicants.incompleteBeneficiary);
      }
      if (state.request.currentBeneficiaryIndex + 1 < state.request.beneficiaryCount) {
        state.request.currentBeneficiaryIndex += 1;
        state.stage = "BENEFICIARY_NAME";
        await saveUserState(from, state);
        return sendText(from, messages.multipleApplicants.beneficiaryName({ number: state.request.currentBeneficiaryIndex + 1 }));
      }
    }
    if (state.request.usingSavedData) return showConfirmation(from, state);
    state.stage = "CITY";
    await saveUserState(from, state);
    return sendText(from, messages.applicant.city);
  }
  if (doc.optional) {
    const beneficiary = activeBeneficiary(state);
    const context = beneficiary ? { beneficiaryIndex: state.request.currentBeneficiaryIndex, documentKey: doc.key } : null;
    return sendOptionalDocumentPrompt(from, doc.uploadPrompt, context);
  }
  await sendText(from, messages.documents.uploadMore({ prompt: doc.uploadPrompt }));
}

export async function advanceCurrentDocument(from, state, doc, requireFiles, services = {}) {
  const advance = services.advanceDocumentStage || advanceDocumentStage;
  const notify = services.sendText || sendText;
  const continueFlow = services.askDocument || askDocument;
  const store = activeDocumentStore(state);
  const result = await advance(from, {
    documentIndex: store.documentIndex || 0,
    beneficiaryIndex: state.request.multiPackage ? state.request.currentBeneficiaryIndex : null,
    documentKey: doc.key,
    requireFiles,
  });
  if (result.status === "BUSY") {
    await notify(from, messages.documents.uploadStillRunning);
    return result;
  }
  if (result.status === "EMPTY") {
    await notify(from, messages.documents.currentStepFirst({ prompt: doc.uploadPrompt }));
    return result;
  }
  if (result.status !== "ADVANCED") return result;
  Object.assign(state, result.state);
  await continueFlow(from, state);
  return result;
}
export function formatConfirmationSummary(state) {
  const r = state.request || {}, d = r.data || {};
  return messages.confirmation.singleSummary({
    ...d,
    type: r.type,
    phone: d.phone || state.phone,
    documentSummary: formatDocumentSummary(r.documents, r.type),
  });
}

export function buildConfirmationMessages(from, state) {
  if (!state.request?.multiPackage) return [formatConfirmationSummary(state)];
  const { data, beneficiaries } = state.request;
  return [
    messages.confirmation.multiApplicantSummary({ ...data, phone: data.phone || from }),
    ...beneficiaries.map((beneficiary, index) => messages.confirmation.multiBeneficiarySummary({
      number: index + 1,
      ...beneficiary,
      documentSummary: formatDocumentSummary(beneficiary.documents),
    })),
    messages.confirmation.multiDeliverySummary(data),
  ];
}
async function recipientChoice(from, state, another) {
  state.request.data.recipientAnotherPerson = another;
  if (another) {
    state.stage = "RECIPIENT_NAME";
    await saveUserState(from, state);
    return sendText(from, messages.applicant.otherRecipientName);
  }
  await showConfirmation(from, state);
}

export async function repeatCurrentPrompt(from, state, services = {}) {
  const repeatMultiApplicantIncluded = services.sendMultiApplicantIncludedMenu || sendMultiApplicantIncludedMenu;
  const repeatMultiSavedDocuments = services.sendMultiSavedDocumentsMenu || sendMultiSavedDocumentsMenu;
  const repeatConfirmation = services.showConfirmation || showConfirmation;
  const repeatEditMenu = services.sendEditMenu || sendEditMenu;
  const prompts = {
    IDENTIFICATION: state.request?.type === "military_unit" ? messages.applicant.identifyMilitaryContact : messages.applicant.identifyIndividual,
    MILITARY_UNIT_NUMBER: messages.military.unitNumber,
    REQUEST_TYPE: messages.applicant.repeatRequestNeed,
    PACKAGE_COUNT: messages.multipleApplicants.packageCount({ max: MAX_MULTI_BENEFICIARIES }),
    BENEFICIARY_NAME: messages.multipleApplicants.beneficiaryName({ number: (state.request?.currentBeneficiaryIndex || 0) + 1 }),
    BENEFICIARY_PHONE: messages.multipleApplicants.beneficiaryPhone,
    CITY: messages.applicant.city,
    NOVA_POSHTA_BRANCH: messages.applicant.novaPoshtaBranch,
    RECIPIENT_NAME: messages.applicant.otherRecipientName,
    RECIPIENT_PHONE: messages.applicant.otherRecipientPhone,
    EDIT_BENEFICIARY_SELECT: messages.editing.beneficiarySelect({ count: state.request?.beneficiaryCount || 1 }),
    EDIT_BENEFICIARY_TEXT: state.editBeneficiaryField === "phone" ? messages.editing.beneficiaryPhone : messages.editing.beneficiaryName,
    EDIT_RECIPIENT_NAME: messages.editing.recipientName,
    EDIT_RECIPIENT_PHONE: messages.editing.recipientPhone,
  };
  if (prompts[state.stage]) return sendText(from, prompts[state.stage]);
  if (state.stage === "APPLICANT_TYPE") return sendApplicantTypeMenu(from);
  if (state.stage === "RETURNING_CHOICE") return sendReturningApplicantMenu(from, state.request?.profile?.lastDocumentsUpdatedAt);
  if (state.stage === "PACKAGE_MODE") return sendPackageModeMenu(from);
  if (state.stage === "MULTI_APPLICANT_INCLUDED") return repeatMultiApplicantIncluded(from);
  if (state.stage === "MULTI_SAVED_DOCUMENTS_DECISION") return repeatMultiSavedDocuments(from);
  if (state.stage === "DOCUMENTS") {
    const doc = currentDoc(state);
    const store = activeDocumentStore(state);
    const hasFiles = Boolean(doc && store?.documents?.[doc.key]?.length);
    if (hasFiles) {
      const context = state.request?.multiPackage ? { beneficiaryIndex: state.request.currentBeneficiaryIndex, documentKey: doc.key } : null;
      return sendDocumentDone(from, doc.label, store.documents[doc.key].length, Boolean(doc.optional), context);
    }
    return askDocument(from, state);
  }
  if (state.stage === "DOCUMENT_UPDATE_DECISION") return sendYesNoMenu(from, messages.documents.oldDocumentsQuestion, "update_documents_yes", "update_documents_no");
  if (state.stage === "RECIPIENT_CHOICE") return sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "recipient_other_yes", "recipient_other_no");
  if (state.stage === "CONFIRMATION") return repeatConfirmation(from, state);
  if (state.stage === "EDIT_MENU") return repeatEditMenu(from, state.request?.type, state.request?.multiPackage);
  if (state.stage === "EDIT_BENEFICIARY_FIELD") return sendBeneficiaryEditFieldMenu(from, (state.editBeneficiaryIndex || 0) + 1);
  if (state.stage === "EDIT_RECIPIENT_CHOICE") return sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "edit_recipient_other_yes", "edit_recipient_other_no");
  if (state.stage === "EDIT_TEXT") {
    const prompt = EDIT_FIELD_PROMPTS[state.editField];
    if (prompt) return sendText(from, prompt);
    delete state.editField;
    state.stage = "EDIT_MENU";
    await saveUserState(from, state);
    await sendText(from, messages.editing.unknownField);
    return sendEditMenu(from, state.request?.type, state.request?.multiPackage);
  }
  return sendText(from, messages.navigation.continueCurrentStep);
}

export function getInteractiveReplyId(message) {
  return message?.interactive?.button_reply?.id
    || message?.button?.payload
    || message?.interactive?.list_reply?.id
    || null;
}

export async function applyEditedField(from, state, text, services = {}) {
  const editedField = state.editField;
  if (editedField === "need" && !requestNeedFitsSheets(text)) {
    logRejectedNeed("EDIT_TEXT", text);
    return (services.sendText || sendText)(from, NEED_TOO_LONG_MESSAGE);
  }
  state.request.data[editedField] = text;
  if (editedField === "name" && state.request.multiPackage && state.request.beneficiaries?.[0]?.isApplicant) {
    state.request.beneficiaries[0].name = text;
  }
  delete state.editField;
  const returnToConfirmation = services.showConfirmation || showConfirmation;
  return returnToConfirmation(from, state);
}

export async function openEditMenu(from, state, services = {}) {
  const persistState = services.saveUserState || saveUserState;
  const showEditMenu = services.sendEditMenu || sendEditMenu;
  state.stage = "EDIT_MENU";
  await persistState(from, state);
  return showEditMenu(from, state.request.type, state.request.multiPackage);
}

async function allocateNextApplicationId(assertClaimOwnership) {
  const period = getKyivApplicationPeriod();
  await assertClaimOwnership();
  const recordedMaximum = await getMaxApplicationSequenceForPeriod(period);
  await assertClaimOwnership();
  const applicationId = await createApplicationNumber(period, recordedMaximum);
  await assertClaimOwnership();
  return applicationId;
}

export async function confirmRequest(from, state, assertClaimOwnership, services = {}) {
  const operations = {
    nextApplicationId: allocateNextApplicationId,
    persistState: saveUserState,
    finalizeMultiDocuments: finalizeIndividualMultiRequestDocuments,
    appendMultiRequest: appendConfirmedMultiRequest,
    createCanonicalCopies: createCanonicalApplicantDocumentCopies,
    persistApplicantProfile: saveApplicantProfile,
    appendRequest: appendConfirmedRequest,
    finalizeMilitaryDocuments: finalizeMilitaryRequestDocuments,
    updateMilitaryLinks: updateMilitaryRequestDocumentLinks,
    persistMilitaryProfile: saveMilitaryContactProfile,
    sendAccepted: sendApplicationAccepted,
    clearState: resetUserState,
    ...services,
  };
  const request = state.request;
  assertRequestNeedWithinSheetsLimit(request);
  assertRequestDocumentsHaveValidation(request);
  await assertClaimOwnership();
  let persistedConfirmationData = false;
  if (!request.applicationId) {
    request.applicationId = await operations.nextApplicationId(assertClaimOwnership);
    await assertClaimOwnership();
    persistedConfirmationData = true;
  }
  if (!request.confirmedAt) {
    request.confirmedAt = new Date().toISOString();
    persistedConfirmationData = true;
  }
  if (request.sheetsRecorded !== true && request.sheetsRecorded !== false) {
    request.sheetsRecorded = false;
    persistedConfirmationData = true;
  }
  if (persistedConfirmationData) await operations.persistState(from, state);
  await assertClaimOwnership();

  if (request.type === "individual" && request.multiPackage) {
    request.beneficiaries = await operations.finalizeMultiDocuments({
      applicantName: request.data.name,
      applicationId: request.applicationId,
      beneficiaries: request.beneficiaries,
      assertOwnership: assertClaimOwnership,
      onDocumentFinalized: async () => {
        await assertClaimOwnership();
        await operations.persistState(from, state);
        await assertClaimOwnership();
      },
    });
    await assertClaimOwnership();
    await operations.persistState(from, state);
    await assertClaimOwnership();

    if (!request.sheetsRecorded) {
      confirmationLog("confirmation_sheets_started", request, { step: "multi_write" });
      await operations.appendMultiRequest(request, request.applicationId, request.confirmedAt);
      await assertClaimOwnership();
      confirmationLog("confirmation_sheets_completed", request, { step: "multi_write" });
      request.sheetsRecorded = true;
      await operations.persistState(from, state);
      await assertClaimOwnership();
    }
    await assertClaimOwnership();

    if (request.refreshApplicantProfileDocuments) {
      request.canonicalApplicantDocuments ||= {};
      request.canonicalApplicantDocuments = await operations.createCanonicalCopies({
        applicantName: request.data.name,
        applicationId: request.applicationId,
        documents: request.beneficiaries[0]?.documents,
        assertOwnership: assertClaimOwnership,
        onDocumentCopied: async ({ documentKey, fileIndex, document }) => {
          await assertClaimOwnership();
          request.canonicalApplicantDocuments[documentKey] ||= [];
          request.canonicalApplicantDocuments[documentKey][fileIndex] = document;
          await operations.persistState(from, state);
          await assertClaimOwnership();
        },
      });
      request.canonicalApplicantDocumentsUpdatedAt ||= new Date().toISOString();
      await operations.persistState(from, state);
      await assertClaimOwnership();
    }

    await assertClaimOwnership();
    await operations.persistApplicantProfile(from, request);
    await assertClaimOwnership();
    try {
      await operations.sendAccepted(from, request.applicationId);
    } catch (error) {
      confirmationLog("confirmation_success_message_failed", request, {
        errorCode: error?.code || "UNKNOWN",
      });
    }
    await assertClaimOwnership();
    await operations.clearState(from);
    return;
  }

  if (!request.sheetsRecorded) {
    await assertClaimOwnership();
    confirmationLog("confirmation_sheets_started", request, { step: "single_write" });
    await operations.appendRequest(request, request.applicationId, request.confirmedAt);
    await assertClaimOwnership();
    confirmationLog("confirmation_sheets_completed", request, { step: "single_write" });
    request.sheetsRecorded = true;
    await operations.persistState(from, state);
    await assertClaimOwnership();
  }

  if (request.type === "individual") {
    await assertClaimOwnership();
    await operations.persistApplicantProfile(from, request);
    await assertClaimOwnership();
  }
  if (request.type === "military_unit") {
    await assertClaimOwnership();
    request.documents.official_request = await operations.finalizeMilitaryDocuments({
      militaryUnitNumber: request.data.militaryUnitNumber,
      contactName: request.data.name,
      applicationId: request.applicationId,
      documents: request.documents.official_request,
    });
    await assertClaimOwnership();
    await operations.persistState(from, state);
    await assertClaimOwnership();
    await operations.updateMilitaryLinks(request.applicationId, request.documents.official_request);
    await assertClaimOwnership();
    await operations.persistMilitaryProfile(from, request.data.name);
    await assertClaimOwnership();
  }
  await assertClaimOwnership();
  try {
    await operations.sendAccepted(from, request.applicationId);
  } catch (error) {
    confirmationLog("confirmation_success_message_failed", request, {
      errorCode: error?.code || "UNKNOWN",
    });
  }
  await assertClaimOwnership();
  await operations.clearState(from);
}

export async function sendConfirmationFailure(from, state, assertClaimOwnership, error, services = {}) {
  const lookupRequest = services.lookupRequest || findRequestByApplicationId;
  const sendFailureText = services.sendFailureText || sendText;
  const sendRetryMenu = services.sendRetryMenu || sendConfirmationRetryMenu;
  const applicationId = state.request?.applicationId;
  let sheetsRecorded = false;

  if (error?.code === "REQUEST_NEED_TOO_LONG") {
    await assertClaimOwnership();
    state.stage = "EDIT_TEXT";
    state.editField = "need";
    const persistState = services.persistState || saveUserState;
    await persistState(from, state);
    await assertClaimOwnership();
    logRejectedNeed("CONFIRMATION", state.request?.data?.need);
    await sendFailureText(from, NEED_TOO_LONG_MESSAGE);
    await assertClaimOwnership();
    return { failed: true, needsShorterNeed: true };
  }

  await assertClaimOwnership();
  if (applicationId) {
    const lookup = await lookupRequest(applicationId);
    await assertClaimOwnership();
    sheetsRecorded = lookup?.result === "found" || lookup?.result === "duplicate";
    if (sheetsRecorded) {
      state.request.sheetsRecorded = true;
      const persistState = services.persistState || saveUserState;
      await persistState(from, state);
      await assertClaimOwnership();
    }
  }

  const profileRefreshPending = sheetsRecorded
    && state.request?.type === "individual"
    && state.request?.multiPackage
    && state.request?.refreshApplicantProfileDocuments;
  const message = profileRefreshPending
    ? messages.confirmation.registeredProfilePending
    : sheetsRecorded
      ? messages.confirmation.registeredProcessingPending
      : messages.confirmation.temporaryFailure;
  await assertClaimOwnership();
  await sendFailureText(from, message);
  await assertClaimOwnership();
  if (!sheetsRecorded) {
    await sendRetryMenu(from);
    await assertClaimOwnership();
  }
  confirmationLog("confirmation_recoverable_failure", state.request, {
    sheetsRecorded,
    errorCode: error?.code || "UNKNOWN",
    needLength: sheetsTextLength(state.request?.data?.need),
  });
  return { failed: true, sheetsRecorded };
}

export async function handleConfirmationResult(from, state, result, services = {}) {
  const sendMessage = services.sendText || sendText;
  const sendRetryMenu = services.sendRetryMenu || sendConfirmationRetryMenu;
  if (result?.busy) {
    confirmationLog("confirmation_claim_busy", state.request);
  } else if (result?.claimLost) {
    const acquireClaim = services.acquireClaim || acquireConfirmationClaim;
    const renewClaim = services.renewClaim || renewConfirmationClaim;
    const releaseClaim = services.releaseClaim || releaseConfirmationClaim;
    const loadState = services.loadState || getUserState;
    const lookupRequest = services.lookupRequest || findRequestByApplicationId;
    const recoveryOwner = services.recoveryOwner || randomUUID();
    if (!await acquireClaim(from, recoveryOwner)) return result;
    try {
      const latestState = await loadState(from);
      if (latestState?.stage !== "CONFIRMATION" || !latestState.request) return result;
      const applicationId = latestState.request.applicationId;
      if (applicationId) {
        const lookup = await lookupRequest(applicationId);
        if (lookup?.result === "found" || lookup?.result === "duplicate") return result;
      }
      if (!await renewClaim(from, recoveryOwner)) return result;
      await sendMessage(from, messages.confirmation.claimInterrupted);
      if (!await renewClaim(from, recoveryOwner)) return result;
      await sendRetryMenu(from);
    } finally {
      await releaseClaim(from, recoveryOwner);
    }
  }
  return result;
}

export async function runClaimedConfirmation(from, dependencies = {}) {
  const acquireClaim = dependencies.acquireClaim || acquireConfirmationClaim;
  const renewClaim = dependencies.renewClaim || renewConfirmationClaim;
  const checkClaim = dependencies.checkClaim || ownsConfirmationClaim;
  const releaseClaim = dependencies.releaseClaim || releaseConfirmationClaim;
  const loadState = dependencies.loadState || getUserState;
  const performConfirmation = dependencies.performConfirmation || confirmRequest;
  const handleFailure = dependencies.handleFailure || sendConfirmationFailure;
  const sendProcessingStarted = dependencies.sendProcessingStarted || sendText;
  const ownerToken = dependencies.ownerToken || randomUUID();
  const heartbeatMs = dependencies.heartbeatMs || Math.max(1000, Math.floor(CONFIRMATION_CLAIM_TTL_SECONDS * 1000 / 3));
  const acquired = await acquireClaim(from, ownerToken);
  if (!acquired) return { busy: true };

  let claimLost = false;
  let renewal = Promise.resolve();
  const renew = () => {
    renewal = renewal.then(async () => {
      if (!claimLost && !await renewClaim(from, ownerToken)) claimLost = true;
    }).catch(() => { claimLost = true; });
    return renewal;
  };
  const heartbeat = setInterval(renew, heartbeatMs);
  heartbeat.unref?.();
  const assertClaimOwnership = async () => {
    await renewal;
    if (claimLost || !await checkClaim(from, ownerToken)) {
      claimLost = true;
      const error = new Error("Confirmation claim was lost");
      error.code = "CONFIRMATION_CLAIM_LOST";
      throw error;
    }
    if (!await renewClaim(from, ownerToken)) {
      claimLost = true;
      const error = new Error("Confirmation claim was lost");
      error.code = "CONFIRMATION_CLAIM_LOST";
      throw error;
    }
  };

  try {
    const latestState = await loadState(from);
    if (latestState?.stage !== "CONFIRMATION" || !latestState.request) return { stale: true };
    try {
      assertRequestNeedWithinSheetsLimit(latestState.request);
      await assertClaimOwnership();
      try {
        await sendProcessingStarted(from, messages.confirmation.processing);
      } catch (error) {
        confirmationLog("confirmation_processing_message_failed", latestState.request, {
          errorCode: error?.code || "UNKNOWN",
        });
      }
      await assertClaimOwnership();
      await performConfirmation(from, latestState, assertClaimOwnership, dependencies.confirmationServices);
      return { completed: true };
    } catch (error) {
      if (error?.code === "CONFIRMATION_CLAIM_LOST" || claimLost) {
        confirmationLog("confirmation_claim_lost", latestState.request);
        return { claimLost: true };
      }
      try {
        return await handleFailure(from, latestState, assertClaimOwnership, error, dependencies.failureServices);
      } catch (failureError) {
        if (failureError?.code === "CONFIRMATION_CLAIM_LOST" || claimLost) {
          confirmationLog("confirmation_claim_lost", latestState.request);
          return { claimLost: true };
        }
        confirmationLog("confirmation_failure_notification_failed", latestState.request, {
          errorCode: failureError?.code || "UNKNOWN",
        });
        return { failed: true, notificationFailed: true };
      }
    }
  } finally {
    clearInterval(heartbeat);
    await renewal;
    try { await releaseClaim(from, ownerToken); }
    catch (error) { console.error("Confirmation claim release failed:", error?.message || "Unknown error"); }
  }
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return res.status(200).send("EVENT_RECEIVED");
    if (shouldIgnoreWebhookMessage(message)) return res.status(200).send("EVENT_RECEIVED");
    const from = message.from, text = message.text?.body?.trim() || "", buttonId = getInteractiveReplyId(message), fileId = mediaId(message);

    if (["/reset", "reset"].includes(text.toLowerCase())) {
      await markUserKnown(from); await resetUserState(from); await sendText(from, messages.navigation.resetComplete); await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
    }
    let state = await getUserState(from);
    if (!state) {
      await handleMissingStateMessage(from, { text, buttonId });
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "NEW") {
      await handleMissingStateMessage(from, { text, buttonId, recoveringNewState: true });
      return res.status(200).send("EVENT_RECEIVED");
    }
    await backfillKnownUserMarker(from);
    if (await handleIceBreakerMessage(from, text, state)) return res.status(200).send("EVENT_RECEIVED");
    if (shouldSilenceInactiveMessage(state, text, buttonId)) return res.status(200).send("EVENT_RECEIVED");
    if (await restartRequestWithUnvalidatedDocuments(from, state)) return res.status(200).send("EVENT_RECEIVED");
    if (await handleDocumentStageFallback(from, state, { message, text, buttonId, fileId })) return res.status(200).send("EVENT_RECEIVED");
    if (!text && !buttonId && !fileId) {
      if (state.stage === "MULTI_APPLICANT_INCLUDED" || state.stage === "MULTI_SAVED_DOCUMENTS_DECISION") {
        await repeatCurrentPrompt(from, state);
        return res.status(200).send("EVENT_RECEIVED");
      }
      if (state.stage !== "OPERATOR") await sendText(from, messages.navigation.unsupportedMessage);
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "OPERATOR" && (buttonId === "back_to_menu" || isMenuCommand(text))) {
      state.operatorRequested = false; state.stage = "MAIN_MENU"; await saveUserState(from, state);
      await sendText(from, messages.navigation.returnedToMainMenu); await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "MAIN_MENU" && isMenuCommand(text)) { await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED"); }

    if (state.stage === "CANCEL_CONFIRMATION") {
      if (buttonId === "confirm_cancel_request") {
        await resetUserState(from); state = await createUserState(from); state.stage = "MAIN_MENU"; await saveUserState(from, state);
        await sendText(from, messages.navigation.requestCancelled); await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
      }
      if (buttonId === "keep_request") {
        state.stage = state.cancelReturnStage; delete state.cancelReturnStage; await saveUserState(from, state);
        await repeatCurrentPrompt(from, state); return res.status(200).send("EVENT_RECEIVED");
      }
      await sendCancelRequestConfirmation(from); return res.status(200).send("EVENT_RECEIVED");
    }

    const activeRequest = hasActiveRequest(state);
    if (activeRequest && isMenuCommand(text)) { await sendActiveRequestNavigation(from); return res.status(200).send("EVENT_RECEIVED"); }
    if (activeRequest && buttonId === "resume_request") { await repeatCurrentPrompt(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (activeRequest && buttonId === "cancel_request") {
      state.cancelReturnStage = state.stage; state.stage = "CANCEL_CONFIRMATION"; await saveUserState(from, state);
      await sendCancelRequestConfirmation(from); return res.status(200).send("EVENT_RECEIVED");
    }
    if (activeRequest && buttonId && !isValidButtonForStage(state, buttonId)) {
      await sendText(from, messages.navigation.staleButton);
      await repeatCurrentPrompt(from, state); return res.status(200).send("EVENT_RECEIVED");
    }

    if (state.stage === "MAIN_MENU" && buttonId === "operator") { state.operatorRequested = true; state.stage = "OPERATOR"; await saveUserState(from, state); await sendOperatorMenu(from); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "MAIN_MENU" && buttonId === "send_request") { startRequestFromMainMenu(state, from); await saveUserState(from, state); await sendApplicantTypeMenu(from); return res.status(200).send("EVENT_RECEIVED"); }

    if (state.stage === "APPLICANT_TYPE") {
      if (buttonId === "individual" || buttonId === "military_unit") {
        state.request.type = buttonId === "individual" ? "individual" : "military_unit";
        if (buttonId === "individual") {
          const profile = await getApplicantProfile(from);
          if (profile) { state.request.profile = profile; state.stage = "RETURNING_CHOICE"; await saveUserState(from, state); await sendReturningApplicantMenu(from, profile.lastDocumentsUpdatedAt); return res.status(200).send("EVENT_RECEIVED"); }
        } else {
          const profile = await getMilitaryContactProfile(from);
          if (profile) { state.request.data.name = profile.name; state.stage = "MILITARY_UNIT_NUMBER"; await saveUserState(from, state); await sendText(from, messages.military.unitNumber); return res.status(200).send("EVENT_RECEIVED"); }
        }
        state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, buttonId === "individual" ? messages.applicant.identifyIndividual : messages.applicant.identifyMilitaryContact);
      } else await sendApplicantTypeMenu(from);
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "RETURNING_CHOICE") {
      const profile = state.request.profile;
      if (!profile) { state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, messages.applicant.identifyIndividual); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "use_saved_data") {
        const reuse = prepareSavedDocumentsForReuse(profile.documents);
        state.request.type = "individual"; state.request.data = { ...(profile.data || {}), phone: from }; state.request.documents = reuse.documents; state.request.documentIndex = 0; state.request.savedDocumentsUpdatedAt = profile.lastDocumentsUpdatedAt; state.request.usingSavedData = true; state.request.legacyDocumentsRequireUpload = reuse.legacyDocumentsRequireUpload; state.stage = "REQUEST_TYPE"; await saveUserState(from, state);
        if (state.request.legacyDocumentsRequireUpload) await sendText(from, messages.applicant.legacySavedDocuments);
        await sendText(from, messages.applicant.savedDataUsed); return res.status(200).send("EVENT_RECEIVED");
      }
      if (buttonId === "enter_data_again") { state.request = { type: "individual", data: { phone: from }, documents: {}, documentIndex: 0 }; state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, messages.applicant.enterNameAgain); return res.status(200).send("EVENT_RECEIVED"); }
      await sendReturningApplicantMenu(from, profile.lastDocumentsUpdatedAt); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "IDENTIFICATION" && text) { state.request.data.name = text; if (state.request.type === "military_unit") { state.stage = "MILITARY_UNIT_NUMBER"; await saveUserState(from, state); await sendText(from, messages.military.unitNumber); } else { state.stage = "REQUEST_TYPE"; await saveUserState(from, state); await sendText(from, messages.applicant.requestNeed); } return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "MILITARY_UNIT_NUMBER" && text) { state.request.data.militaryUnitNumber = text; state.stage = "REQUEST_TYPE"; await saveUserState(from, state); await sendText(from, messages.applicant.requestNeed); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "REQUEST_TYPE" && text) { if (!requestNeedFitsSheets(text)) { logRejectedNeed("REQUEST_TYPE", text); await sendText(from, NEED_TOO_LONG_MESSAGE); return res.status(200).send("EVENT_RECEIVED"); } state.request.data.need = text; if (state.request.type === "individual") { state.stage = "PACKAGE_MODE"; await saveUserState(from, state); await sendPackageModeMenu(from); } else { state.stage = "DOCUMENTS"; state.request.documentIndex = 0; await saveUserState(from, state); await askDocument(from, state); } return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "PACKAGE_MODE") {
      if (buttonId === "package_single") { state.request.multiPackage = false; if (state.request.usingSavedData && Object.keys(state.request.documents || {}).length) { await saveUserState(from, state); await continueAfterSavedData(from, state); } else { state.stage = "DOCUMENTS"; state.request.documentIndex = 0; await saveUserState(from, state); await askDocument(from, state); } }
      else if (buttonId === "package_multi") { state.request.multiPackage = true; state.request.usingSavedApplicantIdentity = Boolean(state.request.usingSavedData); state.stage = "PACKAGE_COUNT"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.packageCount({ max: MAX_MULTI_BENEFICIARIES })); }
      else await sendPackageModeMenu(from);
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "PACKAGE_COUNT") {
      const count = /^\d+$/.test(text) ? Number(text) : NaN;
      if (!Number.isInteger(count) || count < 2 || count > MAX_MULTI_BENEFICIARIES) { await sendText(from, messages.multipleApplicants.invalidPackageCount({ max: MAX_MULTI_BENEFICIARIES })); return res.status(200).send("EVENT_RECEIVED"); }
      state.request.beneficiaryCount = count;
      if (hasCompleteSavedApplicantPackage(state.request)) {
        state.stage = "MULTI_APPLICANT_INCLUDED"; await saveUserState(from, state); await sendMultiApplicantIncludedMenu(from); return res.status(200).send("EVENT_RECEIVED");
      }
      startMultiCollection(state.request, from); state.stage = "BENEFICIARY_NAME"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.beneficiaryName({ number: 1 })); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "MULTI_APPLICANT_INCLUDED") {
      if (buttonId === "multi_applicant_no") {
        startMultiCollection(state.request, from); state.stage = "BENEFICIARY_NAME"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.beneficiaryName({ number: 1 })); return res.status(200).send("EVENT_RECEIVED");
      }
      if (buttonId === "multi_applicant_yes") {
        if (documentsAreOlderThanYear(state.request.savedDocumentsUpdatedAt)) {
          state.stage = "MULTI_SAVED_DOCUMENTS_DECISION"; await saveUserState(from, state); await sendMultiSavedDocumentsMenu(from); return res.status(200).send("EVENT_RECEIVED");
        }
        startMultiCollection(state.request, from, "saved"); state.stage = "BENEFICIARY_NAME"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.beneficiaryName({ number: 2 })); return res.status(200).send("EVENT_RECEIVED");
      }
      await repeatCurrentPrompt(from, state); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "MULTI_SAVED_DOCUMENTS_DECISION") {
      if (buttonId === "multi_saved_use") {
        startMultiCollection(state.request, from, "saved"); state.stage = "BENEFICIARY_NAME"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.beneficiaryName({ number: 2 })); return res.status(200).send("EVENT_RECEIVED");
      }
      if (buttonId === "multi_saved_replace") {
        startMultiCollection(state.request, from, "replace"); state.stage = "DOCUMENTS"; await saveUserState(from, state); await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED");
      }
      await repeatCurrentPrompt(from, state); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "BENEFICIARY_NAME" && text) { const beneficiary = activeBeneficiary(state); beneficiary.name = text; state.stage = "BENEFICIARY_PHONE"; await saveUserState(from, state); await sendText(from, messages.multipleApplicants.beneficiaryPhone); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "BENEFICIARY_PHONE") { const phone = normalizePhone(text); if (!phone) { await sendText(from, messages.applicant.invalidPhone); return res.status(200).send("EVENT_RECEIVED"); } const beneficiary = activeBeneficiary(state); beneficiary.phone = phone; beneficiary.documentIndex = 0; state.stage = "DOCUMENTS"; await saveUserState(from, state); await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "DOCUMENT_UPDATE_DECISION") { if (buttonId === "update_documents_yes") { state.request.documents = {}; state.request.documentIndex = 0; state.request.usingSavedData = false; state.stage = "DOCUMENTS"; await saveUserState(from, state); await askDocument(from, state); } else if (buttonId === "update_documents_no") await showConfirmation(from, state); else await sendYesNoMenu(from, messages.documents.oldDocumentsQuestion, "update_documents_yes", "update_documents_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "DOCUMENTS") {
      const doc = currentDoc(state); if (!doc) { await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED"); }
      const store = activeDocumentStore(state); const multiContext = state.request.multiPackage ? { beneficiaryIndex: state.request.currentBeneficiaryIndex, documentKey: doc.key } : null;
      if (fileId) {
        try {
          const upload = await saveIncomingDocument(from, state, message, fileId, doc);
          if (upload.status !== "added") return res.status(200).send("EVENT_RECEIVED");
          await sendDocumentDone(from, doc.label, upload.count, Boolean(doc.optional), multiContext);
        } catch (error) {
          if (!(error instanceof MediaValidationError)) throw error;
          await sendText(from, error.userMessage);
        }
        return res.status(200).send("EVENT_RECEIVED");
      }
      const parsedButton = state.request.multiPackage ? parseMultiDocumentButton(buttonId) : null;
      if (state.request.multiPackage && buttonId?.startsWith("document_") && (!parsedButton || parsedButton.beneficiaryIndex !== state.request.currentBeneficiaryIndex || parsedButton.documentKey !== doc.key)) return res.status(200).send("EVENT_RECEIVED");
      const donePressed = state.request.multiPackage ? parsedButton?.action === "done" : buttonId === "document_done";
      const skipPressed = state.request.multiPackage ? parsedButton?.action === "skip" : buttonId === "document_skip";
      if (donePressed || (skipPressed && doc.optional)) {
        const result = await advanceCurrentDocument(from, state, doc, donePressed);
        if (result.status !== "ADVANCED" && result.status !== "BUSY" && result.status !== "EMPTY") await repeatCurrentPrompt(from, result.state || state);
        return res.status(200).send("EVENT_RECEIVED");
      }
    }
    if (state.stage === "CITY" && text) { state.request.data.city = text; state.stage = "NOVA_POSHTA_BRANCH"; await saveUserState(from, state); await sendText(from, messages.applicant.novaPoshtaBranch); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "NOVA_POSHTA_BRANCH" && text) { state.request.data.novaPoshtaBranch = text; state.stage = "RECIPIENT_CHOICE"; await saveUserState(from, state); await sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "recipient_other_yes", "recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_CHOICE") { if (buttonId === "recipient_other_yes") await recipientChoice(from, state, true); else if (buttonId === "recipient_other_no") await recipientChoice(from, state, false); else await sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "recipient_other_yes", "recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_NAME" && text) { state.request.data.recipientName = text; state.stage = "RECIPIENT_PHONE"; await saveUserState(from, state); await sendText(from, messages.applicant.otherRecipientPhone); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_PHONE" && text) { state.request.data.recipientPhone = text; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }

    if (state.stage === "EDIT_MENU") {
      const prompts = { edit_name: "name", edit_need: "need", edit_unit_number: "militaryUnitNumber", edit_city: "city", edit_np: "novaPoshtaBranch" };
      if (buttonId === "edit_recipient") { state.stage = "EDIT_RECIPIENT_CHOICE"; await saveUserState(from, state); await sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "edit_recipient_other_yes", "edit_recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "edit_beneficiary" && state.request.multiPackage) { state.stage = "EDIT_BENEFICIARY_SELECT"; await saveUserState(from, state); await sendText(from, messages.editing.beneficiarySelect({ count: state.request.beneficiaryCount })); return res.status(200).send("EVENT_RECEIVED"); }
      const selected = prompts[buttonId]; if (selected) { state.editField = selected; state.stage = "EDIT_TEXT"; await saveUserState(from, state); await sendText(from, EDIT_FIELD_PROMPTS[selected]); return res.status(200).send("EVENT_RECEIVED"); }
      await sendEditMenu(from, state.request.type, state.request.multiPackage); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "EDIT_BENEFICIARY_SELECT") { const selected = /^\d+$/.test(text) ? Number(text) - 1 : NaN; if (!Number.isInteger(selected) || selected < 0 || selected >= state.request.beneficiaryCount) { await sendText(from, messages.editing.invalidBeneficiarySelect({ count: state.request.beneficiaryCount })); return res.status(200).send("EVENT_RECEIVED"); } state.editBeneficiaryIndex = selected; state.stage = "EDIT_BENEFICIARY_FIELD"; await saveUserState(from, state); await sendBeneficiaryEditFieldMenu(from, selected + 1); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_BENEFICIARY_FIELD") { if (buttonId === "edit_beneficiary_name" || buttonId === "edit_beneficiary_phone") { state.editBeneficiaryField = buttonId === "edit_beneficiary_name" ? "name" : "phone"; state.stage = "EDIT_BENEFICIARY_TEXT"; await saveUserState(from, state); await sendText(from, state.editBeneficiaryField === "name" ? messages.editing.beneficiaryName : messages.editing.beneficiaryPhone); } else await sendBeneficiaryEditFieldMenu(from, state.editBeneficiaryIndex + 1); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_BENEFICIARY_TEXT") { const beneficiary = state.request.beneficiaries?.[state.editBeneficiaryIndex]; if (!beneficiary) { await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); } if (state.editBeneficiaryField === "phone") { const phone = normalizePhone(text); if (!phone) { await sendText(from, messages.editing.beneficiaryPhoneShortError); return res.status(200).send("EVENT_RECEIVED"); } beneficiary.phone = phone; } else if (state.editBeneficiaryField === "name" && text) beneficiary.name = text; else { await sendText(from, messages.editing.emptyBeneficiaryName); return res.status(200).send("EVENT_RECEIVED"); } delete state.editBeneficiaryIndex; delete state.editBeneficiaryField; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_TEXT" && text) { await applyEditedField(from, state, text); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_CHOICE") { if (buttonId === "edit_recipient_other_yes") { state.request.data.recipientAnotherPerson = true; state.stage = "EDIT_RECIPIENT_NAME"; await saveUserState(from, state); await sendText(from, messages.editing.recipientName); } else if (buttonId === "edit_recipient_other_no") { state.request.data.recipientAnotherPerson = false; delete state.request.data.recipientName; delete state.request.data.recipientPhone; await showConfirmation(from, state); } else await sendYesNoMenu(from, messages.applicant.otherRecipientQuestion, "edit_recipient_other_yes", "edit_recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_NAME" && text) { state.request.data.recipientName = text; state.stage = "EDIT_RECIPIENT_PHONE"; await saveUserState(from, state); await sendText(from, messages.editing.recipientPhone); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_PHONE" && text) { state.request.data.recipientPhone = text; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "CONFIRMATION") {
      if (buttonId === "confirm_request") {
        try {
          const result = await runClaimedConfirmation(from);
          await handleConfirmationResult(from, state, result);
        } catch (error) {
          confirmationLog("confirmation_handler_failed", state.request, { errorCode: error?.code || "UNKNOWN" });
        }
      } else if (buttonId === "edit_request") {
        await openEditMenu(from, state);
      } else {
        await repeatCurrentPrompt(from, state);
      }
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "OPERATOR") return res.status(200).send("EVENT_RECEIVED");
    if (!hasActiveRequest(state)) return res.status(200).send("EVENT_RECEIVED");
    await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
