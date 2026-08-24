import { createClient } from "redis";

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MEDIA_CLAIM_TTL_SECONDS = 10 * 60;

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
function requestCounterKey() { return `requests:counter:${new Date().getUTCFullYear()}`; }
function documentAckKey(phone, documentKey) { return `wa:doc-ack:${phone}:${documentKey}`; }
function mediaClaimKey(phone, mediaId) { return `wa:media:${phone}:${mediaId}`; }
function documentSequenceKey(phone, documentKey) { return `wa:doc-seq:${phone}:${documentKey}`; }

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

export async function saveApplicantProfile(phone, request) {
  const redis = await getRedis();
  const previous = await getApplicantProfile(phone);
  const now = new Date().toISOString();
  if (request.multiPackage) {
    if (!previous) return null;
    const profile = {
      ...previous,
      phone,
      data: { ...(previous.data || {}), name: request.data?.name, phone },
      updatedAt: now,
    };
    await redis.set(profileKey(phone), JSON.stringify(profile));
    return profile;
  }
  const documentsWereUpdated = !request.usingSavedData;
  const lastDocumentsUpdatedAt = documentsWereUpdated ? now : (previous?.lastDocumentsUpdatedAt || request.savedDocumentsUpdatedAt || now);
  const profile = {
    phone,
    type: request.type,
    data: { ...(request.data || {}), phone },
    documents: request.documents || {},
    lastDocumentsUpdatedAt,
    updatedAt: now,
  };
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

export async function createApplicationNumber() {
  const redis = await getRedis();
  const year = new Date().getUTCFullYear();
  const sequence = await redis.incr(requestCounterKey());
  return `${year}-${String(sequence).padStart(6, "0")}`;
}
