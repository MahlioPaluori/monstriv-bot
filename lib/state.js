import { createClient } from "redis";

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MEDIA_CLAIM_TTL_SECONDS = 10 * 60;
const DOCUMENT_UPLOAD_TTL_SECONDS = 2 * 60;
export const CONFIRMATION_CLAIM_TTL_SECONDS = 2 * 60;
export const SHEET_WRITE_CLAIM_TTL_SECONDS = 2 * 60;
const APPLICATION_PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const APPLICATION_ID_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-\d{4}$/;
const MAX_MONTHLY_APPLICATION_SEQUENCE = 9999;

let client;
let connectPromise;

function getClient() {
  if (!client) {
    client = createClient({ url: process.env.REDIS_URL });
    client.on("error", (error) => console.error("Redis error:", error));
  }
  return client;
}

async function getRedis() {
  const redis = getClient();
  if (!redis.isOpen) {
    if (!connectPromise) connectPromise = redis.connect().finally(() => { connectPromise = null; });
    await connectPromise;
  }
  return redis;
}

function stateKey(phone) { return `wa:user:${phone}`; }
function profileKey(phone) { return `wa:profile:${phone}`; }
function militaryContactProfileKey(phone) { return `wa:military-contact:${phone}`; }
function requestCounterKey(period) { return `requests:counter:${period}`; }
function documentAckKey(phone, documentKey) { return `wa:doc-ack:${phone}:${documentKey}`; }
function mediaClaimKey(phone, mediaId) { return `wa:media:${phone}:${mediaId}`; }
function documentUploadsKey(phone) { return `wa:document-uploads:${phone}`; }
function documentSequenceKey(phone, documentKey) { return `wa:doc-seq:${phone}:${documentKey}`; }
function confirmationClaimKey(phone) { return `wa:confirmation:${phone}`; }
function sheetWriteClaimKey(spreadsheetId, sheetId) { return `sheets:writer:${spreadsheetId}:${sheetId}`; }

const RENEW_OWNED_KEY_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("EXPIRE", KEYS[1], ARGV[2])
  end
  return 0
`;
const RELEASE_OWNED_KEY_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return redis.call("DEL", KEYS[1])
  end
  return 0
`;
const CHECK_OWNED_KEY_SCRIPT = `
  if redis.call("GET", KEYS[1]) == ARGV[1] then
    return 1
  end
  return 0
`;
const ALLOCATE_APPLICATION_SEQUENCE_SCRIPT = `
  local current = tonumber(redis.call("GET", KEYS[1]) or "0")
  local recorded = tonumber(ARGV[1])
  if recorded > current then
    current = recorded
  end
  local next = current + 1
  if next > tonumber(ARGV[2]) then
    return -1
  end
  redis.call("SET", KEYS[1], tostring(next))
  return next
`;

const BEGIN_DOCUMENT_UPLOAD_SCRIPT = `
  local raw = redis.call("GET", KEYS[1])
  if not raw then return "STALE" end
  local state = cjson.decode(raw)
  if state.stage ~= "DOCUMENTS" or not state.request then return "STALE" end
  local request = state.request
  local store = request
  if ARGV[4] ~= "" then
    local beneficiaryIndex = tonumber(ARGV[4])
    if not request.multiPackage or tonumber(request.currentBeneficiaryIndex) ~= beneficiaryIndex then return "STALE" end
    if not request.beneficiaries or not request.beneficiaries[beneficiaryIndex + 1] then return "STALE" end
    store = request.beneficiaries[beneficiaryIndex + 1]
  elseif request.multiPackage then
    return "STALE"
  end
  if tonumber(store.documentIndex or 0) ~= tonumber(ARGV[3]) then return "STALE" end
  local expectedKeys = request.type == "military_unit" and { "official_request" } or { "passport", "rnokpp", "military_id", "ubd" }
  if expectedKeys[tonumber(ARGV[3]) + 1] ~= ARGV[6] then return "STALE" end
  if redis.call("SET", KEYS[2], "processing", "NX", "EX", ARGV[2]) == false then return "DUPLICATE" end
  redis.call("ZREMRANGEBYSCORE", KEYS[3], "-inf", ARGV[1])
  redis.call("ZADD", KEYS[3], tonumber(ARGV[1]) + tonumber(ARGV[2]) * 1000, ARGV[5])
  redis.call("EXPIRE", KEYS[3], ARGV[2])
  return "STARTED"
`;

const COMPLETE_DOCUMENT_UPLOAD_SCRIPT = `
  if redis.call("GET", KEYS[2]) ~= "processing" then redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" }) end
  local raw = redis.call("GET", KEYS[1])
  if not raw then redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" }) end
  local state = cjson.decode(raw)
  if state.stage ~= "DOCUMENTS" or not state.request then redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" }) end
  local request = state.request
  local store = request
  if ARGV[4] ~= "" then
    local beneficiaryIndex = tonumber(ARGV[4])
    if not request.multiPackage or tonumber(request.currentBeneficiaryIndex) ~= beneficiaryIndex or not request.beneficiaries or not request.beneficiaries[beneficiaryIndex + 1] then
      redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" })
    end
    store = request.beneficiaries[beneficiaryIndex + 1]
  elseif request.multiPackage then
    redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" })
  end
  if tonumber(store.documentIndex or 0) ~= tonumber(ARGV[3]) then redis.call("ZREM", KEYS[3], ARGV[5]); return cjson.encode({ status = "STALE" }) end
  if not store.documents then store.documents = {} end
  local files = store.documents[ARGV[6]] or {}
  local document = cjson.decode(ARGV[7])
  for _, existing in ipairs(files) do
    if existing.mediaId == document.mediaId then
      redis.call("ZREM", KEYS[3], ARGV[5])
      redis.call("SET", KEYS[2], "completed", "EX", ARGV[11])
      return cjson.encode({ status = "DUPLICATE", count = #files, state = state })
    end
  end
  table.insert(files, document)
  store.documents[ARGV[6]] = files
  state.phone = ARGV[8]
  state.updatedAt = ARGV[9]
  redis.call("SET", KEYS[1], cjson.encode(state), "EX", ARGV[10])
  redis.call("ZREM", KEYS[3], ARGV[5])
  redis.call("SET", KEYS[2], "completed", "EX", ARGV[11])
  return cjson.encode({ status = "ADDED", count = #files, state = state })
`;

const FAIL_DOCUMENT_UPLOAD_SCRIPT = `
  redis.call("ZREM", KEYS[1], ARGV[1])
  if redis.call("GET", KEYS[2]) == "processing" then redis.call("DEL", KEYS[2]) end
  return 1
`;

const RENEW_DOCUMENT_UPLOAD_SCRIPT = `
  if redis.call("GET", KEYS[2]) ~= "processing" then return 0 end
  redis.call("ZADD", KEYS[1], tonumber(ARGV[1]) + tonumber(ARGV[2]) * 1000, ARGV[3])
  redis.call("EXPIRE", KEYS[1], ARGV[2])
  redis.call("EXPIRE", KEYS[2], ARGV[2])
  return 1
`;

const ADVANCE_DOCUMENT_STAGE_SCRIPT = `
  redis.call("ZREMRANGEBYSCORE", KEYS[2], "-inf", ARGV[1])
  if redis.call("ZCARD", KEYS[2]) > 0 then return cjson.encode({ status = "BUSY" }) end
  local raw = redis.call("GET", KEYS[1])
  if not raw then return cjson.encode({ status = "STALE" }) end
  local state = cjson.decode(raw)
  if state.stage ~= "DOCUMENTS" or not state.request then return cjson.encode({ status = "STALE", state = state }) end
  local request = state.request
  local store = request
  if ARGV[3] ~= "" then
    local beneficiaryIndex = tonumber(ARGV[3])
    if not request.multiPackage or tonumber(request.currentBeneficiaryIndex) ~= beneficiaryIndex or not request.beneficiaries or not request.beneficiaries[beneficiaryIndex + 1] then return cjson.encode({ status = "STALE", state = state }) end
    store = request.beneficiaries[beneficiaryIndex + 1]
  elseif request.multiPackage then
    return cjson.encode({ status = "STALE", state = state })
  end
  if tonumber(store.documentIndex or 0) ~= tonumber(ARGV[2]) then return cjson.encode({ status = "STALE", state = state }) end
  local files = store.documents and store.documents[ARGV[4]] or nil
  if ARGV[5] == "1" and (not files or #files == 0) then return cjson.encode({ status = "EMPTY", state = state }) end
  store.documentIndex = tonumber(store.documentIndex or 0) + 1
  state.phone = ARGV[6]
  state.updatedAt = ARGV[7]
  redis.call("SET", KEYS[1], cjson.encode(state), "EX", ARGV[8])
  return cjson.encode({ status = "ADVANCED", state = state })
`;

export async function acquireConfirmationClaim(phone, ownerToken, { redis: suppliedRedis, ttlSeconds = CONFIRMATION_CLAIM_TTL_SECONDS } = {}) {
  if (typeof ownerToken !== "string" || !ownerToken) throw new Error("Confirmation claim owner token is required");
  const redis = suppliedRedis || await getRedis();
  const result = await redis.set(confirmationClaimKey(phone), ownerToken, { NX: true, EX: ttlSeconds });
  return result === "OK";
}

export async function renewConfirmationClaim(phone, ownerToken, { redis: suppliedRedis, ttlSeconds = CONFIRMATION_CLAIM_TTL_SECONDS } = {}) {
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(RENEW_OWNED_KEY_SCRIPT, {
    keys: [confirmationClaimKey(phone)],
    arguments: [ownerToken, String(ttlSeconds)],
  });
  return Number(result) === 1;
}

export async function ownsConfirmationClaim(phone, ownerToken, { redis: suppliedRedis } = {}) {
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(CHECK_OWNED_KEY_SCRIPT, {
    keys: [confirmationClaimKey(phone)],
    arguments: [ownerToken],
  });
  return Number(result) === 1;
}

export async function releaseConfirmationClaim(phone, ownerToken, { redis: suppliedRedis } = {}) {
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(RELEASE_OWNED_KEY_SCRIPT, {
    keys: [confirmationClaimKey(phone)],
    arguments: [ownerToken],
  });
  return Number(result) === 1;
}

function validateSheetWriteClaim(spreadsheetId, sheetId, ownerToken) {
  if (typeof spreadsheetId !== "string" || !spreadsheetId) throw new Error("Spreadsheet ID is required");
  if (!Number.isInteger(sheetId)) throw new Error("Sheet ID is required");
  if (typeof ownerToken !== "string" || !ownerToken) throw new Error("Sheet writer owner token is required");
}

export async function acquireSheetWriteClaim(spreadsheetId, sheetId, ownerToken, { redis: suppliedRedis, ttlSeconds = SHEET_WRITE_CLAIM_TTL_SECONDS } = {}) {
  validateSheetWriteClaim(spreadsheetId, sheetId, ownerToken);
  const redis = suppliedRedis || await getRedis();
  const result = await redis.set(sheetWriteClaimKey(spreadsheetId, sheetId), ownerToken, { NX: true, EX: ttlSeconds });
  return result === "OK";
}

export async function renewSheetWriteClaim(spreadsheetId, sheetId, ownerToken, { redis: suppliedRedis, ttlSeconds = SHEET_WRITE_CLAIM_TTL_SECONDS } = {}) {
  validateSheetWriteClaim(spreadsheetId, sheetId, ownerToken);
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(RENEW_OWNED_KEY_SCRIPT, {
    keys: [sheetWriteClaimKey(spreadsheetId, sheetId)],
    arguments: [ownerToken, String(ttlSeconds)],
  });
  return Number(result) === 1;
}

export async function ownsSheetWriteClaim(spreadsheetId, sheetId, ownerToken, { redis: suppliedRedis } = {}) {
  validateSheetWriteClaim(spreadsheetId, sheetId, ownerToken);
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(CHECK_OWNED_KEY_SCRIPT, {
    keys: [sheetWriteClaimKey(spreadsheetId, sheetId)],
    arguments: [ownerToken],
  });
  return Number(result) === 1;
}

export async function releaseSheetWriteClaim(spreadsheetId, sheetId, ownerToken, { redis: suppliedRedis } = {}) {
  validateSheetWriteClaim(spreadsheetId, sheetId, ownerToken);
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(RELEASE_OWNED_KEY_SCRIPT, {
    keys: [sheetWriteClaimKey(spreadsheetId, sheetId)],
    arguments: [ownerToken],
  });
  return Number(result) === 1;
}

export async function getUserState(phone) {
  const redis = await getRedis();
  const raw = await redis.get(stateKey(phone));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (error) { console.error("Invalid Redis state:", error); return null; }
}

export async function saveUserState(phone, state) {
  const redis = await getRedis();
  const nextState = { ...state, phone, updatedAt: new Date().toISOString() };
  await redis.set(stateKey(phone), JSON.stringify(nextState), { EX: STATE_TTL_SECONDS });
  return nextState;
}

export async function createUserState(phone) {
  return saveUserState(phone, { stage: "NEW", operatorRequested: false, request: null, createdAt: new Date().toISOString() });
}

export async function resetUserState(phone) {
  const redis = await getRedis();
  await redis.del(stateKey(phone));
  await redis.del(documentUploadsKey(phone));
  const keys = await redis.keys(`wa:doc-ack:${phone}:*`);
  if (keys.length) await redis.del(keys);
  const mediaKeys = await redis.keys(`wa:media:${phone}:*`);
  if (mediaKeys.length) await redis.del(mediaKeys);
  const sequenceKeys = await redis.keys(`wa:doc-seq:${phone}:*`);
  if (sequenceKeys.length) await redis.del(sequenceKeys);
}

export async function claimDocumentAcknowledgement(phone, documentKey) {
  const redis = await getRedis();
  const result = await redis.set(documentAckKey(phone, documentKey), "1", { NX: true, EX: STATE_TTL_SECONDS });
  return result === "OK";
}

export async function claimMediaUpload(phone, mediaId) {
  const redis = await getRedis();
  const result = await redis.set(mediaClaimKey(phone, mediaId), "1", { NX: true, EX: MEDIA_CLAIM_TTL_SECONDS });
  return result === "OK";
}

export async function releaseMediaUploadClaim(phone, mediaId) {
  const redis = await getRedis();
  await redis.del(mediaClaimKey(phone, mediaId));
}

export async function beginDocumentUpload(phone, uploadId, { documentIndex, beneficiaryIndex = null, documentKey } = {}, { redis: suppliedRedis, ttlSeconds = DOCUMENT_UPLOAD_TTL_SECONDS } = {}) {
  const redis = suppliedRedis || await getRedis();
  return redis.eval(BEGIN_DOCUMENT_UPLOAD_SCRIPT, {
    keys: [stateKey(phone), mediaClaimKey(phone, uploadId), documentUploadsKey(phone)],
    arguments: [String(Date.now()), String(ttlSeconds), String(documentIndex), beneficiaryIndex === null ? "" : String(beneficiaryIndex), uploadId, documentKey],
  });
}

export async function completeDocumentUpload(phone, uploadId, { documentIndex, beneficiaryIndex = null, documentKey, document }, { redis: suppliedRedis, ttlSeconds = DOCUMENT_UPLOAD_TTL_SECONDS } = {}) {
  const redis = suppliedRedis || await getRedis();
  const now = new Date().toISOString();
  const raw = await redis.eval(COMPLETE_DOCUMENT_UPLOAD_SCRIPT, {
    keys: [stateKey(phone), mediaClaimKey(phone, uploadId), documentUploadsKey(phone)],
    arguments: [String(Date.now()), String(ttlSeconds), String(documentIndex), beneficiaryIndex === null ? "" : String(beneficiaryIndex), uploadId, documentKey, JSON.stringify(document), phone, now, String(STATE_TTL_SECONDS), String(STATE_TTL_SECONDS)],
  });
  return JSON.parse(raw);
}

export async function failDocumentUpload(phone, uploadId, { redis: suppliedRedis } = {}) {
  const redis = suppliedRedis || await getRedis();
  await redis.eval(FAIL_DOCUMENT_UPLOAD_SCRIPT, {
    keys: [documentUploadsKey(phone), mediaClaimKey(phone, uploadId)],
    arguments: [uploadId],
  });
}

export async function renewDocumentUpload(phone, uploadId, { redis: suppliedRedis, ttlSeconds = DOCUMENT_UPLOAD_TTL_SECONDS } = {}) {
  const redis = suppliedRedis || await getRedis();
  const result = await redis.eval(RENEW_DOCUMENT_UPLOAD_SCRIPT, {
    keys: [documentUploadsKey(phone), mediaClaimKey(phone, uploadId)],
    arguments: [String(Date.now()), String(ttlSeconds), uploadId],
  });
  return Number(result) === 1;
}

export async function advanceDocumentStage(phone, { documentIndex, beneficiaryIndex = null, documentKey, requireFiles = true }, { redis: suppliedRedis } = {}) {
  const redis = suppliedRedis || await getRedis();
  const now = new Date().toISOString();
  const raw = await redis.eval(ADVANCE_DOCUMENT_STAGE_SCRIPT, {
    keys: [stateKey(phone), documentUploadsKey(phone)],
    arguments: [String(Date.now()), String(documentIndex), beneficiaryIndex === null ? "" : String(beneficiaryIndex), documentKey, requireFiles ? "1" : "0", phone, now, String(STATE_TTL_SECONDS)],
  });
  return JSON.parse(raw);
}

export async function nextDocumentSequence(phone, documentKey) {
  const redis = await getRedis();
  return redis.incr(documentSequenceKey(phone, documentKey));
}

export async function getApplicantProfile(phone) {
  const redis = await getRedis();
  const raw = await redis.get(profileKey(phone));
  if (!raw) return null;
  try { return JSON.parse(raw); }
  catch (error) { console.error("Invalid applicant profile:", error); return null; }
}

export function buildApplicantProfile(previous, phone, request, now = new Date().toISOString()) {
  if (request.multiPackage) {
    if (!previous) return null;
    const refreshedDocuments = request.refreshApplicantProfileDocuments
      ? request.canonicalApplicantDocuments
      : null;
    if (request.refreshApplicantProfileDocuments && (!refreshedDocuments || typeof refreshedDocuments !== "object")) {
      throw new Error("Canonical applicant documents are missing");
    }
    return {
      ...previous,
      phone,
      data: { ...(previous.data || {}), name: request.data?.name, phone },
      ...(refreshedDocuments ? {
        documents: refreshedDocuments,
        lastDocumentsUpdatedAt: request.canonicalApplicantDocumentsUpdatedAt || now,
      } : {}),
      updatedAt: now,
    };
  }
  const documentsWereUpdated = !request.usingSavedData;
  const lastDocumentsUpdatedAt = documentsWereUpdated ? now : (previous?.lastDocumentsUpdatedAt || request.savedDocumentsUpdatedAt || now);
  return {
    phone,
    type: request.type,
    data: { ...(request.data || {}), phone },
    documents: request.documents || {},
    lastDocumentsUpdatedAt,
    updatedAt: now,
  };
}

export async function saveApplicantProfile(phone, request) {
  const redis = await getRedis();
  const previous = await getApplicantProfile(phone);
  const now = new Date().toISOString();
  const profile = buildApplicantProfile(previous, phone, request, now);
  if (!profile) return null;
  await redis.set(profileKey(phone), JSON.stringify(profile));
  return profile;
}

export async function getMilitaryContactProfile(phone) {
  const redis = await getRedis();
  const raw = await redis.get(militaryContactProfileKey(phone));
  if (!raw) return null;
  try {
    const profile = JSON.parse(raw);
    if (!profile || typeof profile !== "object" || Array.isArray(profile)) return null;
    if (profile.phone !== phone || typeof profile.name !== "string" || !profile.name.trim()) return null;
    return {
      phone,
      name: profile.name.trim(),
      createdAt: profile.createdAt,
      updatedAt: profile.updatedAt,
    };
  } catch (error) {
    console.error("Invalid military contact profile:", error);
    return null;
  }
}

export async function saveMilitaryContactProfile(phone, name) {
  const normalizedName = typeof name === "string" ? name.trim() : "";
  if (!normalizedName) return null;
  const redis = await getRedis();
  const previous = await getMilitaryContactProfile(phone);
  const now = new Date().toISOString();
  const profile = {
    phone,
    name: normalizedName,
    createdAt: typeof previous?.createdAt === "string" && previous.createdAt ? previous.createdAt : now,
    updatedAt: now,
  };
  await redis.set(militaryContactProfileKey(phone), JSON.stringify(profile));
  return profile;
}

export function getKyivApplicationPeriod(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Kyiv",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(now);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const period = `${year}-${month}`;
  if (!APPLICATION_PERIOD_PATTERN.test(period)) throw new Error("Unable to determine Kyiv application period");
  return period;
}

export async function createApplicationNumber(period, recordedMaxSequence = 0, { redis: suppliedRedis } = {}) {
  if (!APPLICATION_PERIOD_PATTERN.test(period)) throw new Error("Invalid application period");
  if (!Number.isInteger(recordedMaxSequence) || recordedMaxSequence < 0 || recordedMaxSequence > MAX_MONTHLY_APPLICATION_SEQUENCE) {
    throw new Error("Invalid recorded application sequence");
  }
  const redis = suppliedRedis || await getRedis();
  const sequence = Number(await redis.eval(ALLOCATE_APPLICATION_SEQUENCE_SCRIPT, {
    keys: [requestCounterKey(period)],
    arguments: [String(recordedMaxSequence), String(MAX_MONTHLY_APPLICATION_SEQUENCE)],
  }));
  if (sequence < 1 || sequence > MAX_MONTHLY_APPLICATION_SEQUENCE) {
    throw new Error(`Monthly application number limit reached for ${period}`);
  }
  const applicationId = `${period}-${String(sequence).padStart(4, "0")}`;
  if (!APPLICATION_ID_PATTERN.test(applicationId)) throw new Error("Unable to generate a valid application ID");
  return applicationId;
}
