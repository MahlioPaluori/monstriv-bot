import { createClient } from "redis";

const STATE_TTL_SECONDS = 7 * 24 * 60 * 60;

let client;
let connectPromise;

function getClient() {
  if (!client) {
    client = createClient({
      url: process.env.REDIS_URL,
    });

    client.on("error", (error) => {
      console.error("Redis error:", error);
    });
  }

  return client;
}

async function getRedis() {
  const redis = getClient();

  if (!redis.isOpen) {
    if (!connectPromise) {
      connectPromise = redis.connect().finally(() => {
        connectPromise = null;
      });
    }

    await connectPromise;
  }

  return redis;
}

function stateKey(phone) {
  return `wa:user:${phone}`;
}

function profileKey(phone) {
  return `wa:profile:${phone}`;
}

function requestCounterKey() {
  return `requests:counter:${new Date().getUTCFullYear()}`;
}

function documentAckKey(phone, documentKey) {
  return `wa:doc-ack:${phone}:${documentKey}`;
}

export async function getUserState(phone) {
  const redis = await getRedis();
  const raw = await redis.get(stateKey(phone));

  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid Redis state:", error);
    return null;
  }
}

export async function saveUserState(phone, state) {
  const redis = await getRedis();

  const nextState = {
    ...state,
    phone,
    updatedAt: new Date().toISOString(),
  };

  // Redis is temporary session storage, not document storage.
  // Active conversations expire after 7 days of inactivity.
  await redis.set(stateKey(phone), JSON.stringify(nextState), {
    EX: STATE_TTL_SECONDS,
  });

  return nextState;
}

export async function createUserState(phone) {
  return saveUserState(phone, {
    stage: "NEW",
    operatorRequested: false,
    request: null,
    createdAt: new Date().toISOString(),
  });
}

export async function resetUserState(phone) {
  const redis = await getRedis();
  await redis.del(stateKey(phone));

  const keys = await redis.keys(`wa:doc-ack:${phone}:*`);
  if (keys.length) await redis.del(keys);
}

export async function claimDocumentAcknowledgement(phone, documentKey) {
  const redis = await getRedis();
  const result = await redis.set(documentAckKey(phone, documentKey), "1", {
    NX: true,
    EX: STATE_TTL_SECONDS,
  });

  return result === "OK";
}

export async function getApplicantProfile(phone) {
  const redis = await getRedis();
  const raw = await redis.get(profileKey(phone));
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (error) {
    console.error("Invalid applicant profile:", error);
    return null;
  }
}

export async function saveApplicantProfile(phone, request) {
  const redis = await getRedis();
  const now = new Date().toISOString();

  const profile = {
    phone,
    type: request.type,
    data: { ...(request.data || {}), phone },
    documents: request.documents || {},
    lastDocumentsUpdatedAt: now,
    updatedAt: now,
  };

  // Applicant profiles are persistent data, separate from the 7-day session.
  await redis.set(profileKey(phone), JSON.stringify(profile));
  return profile;
}

export async function createApplicationNumber() {
  const redis = await getRedis();
  const year = new Date().getUTCFullYear();
  const sequence = await redis.incr(requestCounterKey());

  return `${year}-${String(sequence).padStart(6, "0")}`;
}
