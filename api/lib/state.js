import { createClient } from "redis";

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

export async function getUserState(phone) {
  const redis = await getRedis();
  const raw = await redis.get(stateKey(phone));

  if (!raw) {
    return null;
  }

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

  await redis.set(stateKey(phone), JSON.stringify(nextState));

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
