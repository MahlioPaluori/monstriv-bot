import assert from "node:assert/strict";
import test from "node:test";

import {
  backfillKnownUserMarker,
  completeRequestCancellation,
  handleMissingStateMessage,
  isOperatorReturnAction,
  returnFromOperatorToMainMenu,
  shouldIgnoreWebhookMessage,
  shouldSilenceInactiveMessage,
  startRequestFromMainMenu,
} from "../api/webhook.js";
import { messages } from "../lib/messages.js";
import { initializeUserSession, isKnownUser, markUserKnown, resetUserState } from "../lib/state.js";
import { sendApplicationAccepted } from "../lib/whatsapp.js";

function missingStateServices({ known = false, applicantProfile = null, militaryProfile = null } = {}) {
  const calls = [];
  const services = {
    isKnownUser: async () => known,
    markUserKnown: async () => calls.push(["mark-known"]),
    getApplicantProfile: async () => applicantProfile,
    getMilitaryContactProfile: async () => militaryProfile,
    initializeUserSession: async (_phone, action) => {
      calls.push(["initialize", action]);
      return {
        status: "CREATED",
        state: {
          stage: action === "SEND_REQUEST" ? "APPLICANT_TYPE" : action === "OPERATOR" ? "OPERATOR" : "MAIN_MENU",
          request: {},
        },
      };
    },
    getUserState: async () => ({ stage: "MAIN_MENU", request: {} }),
    sendMainMenu: async (_phone, body) => calls.push(["main-menu", body]),
    sendApplicantTypeMenu: async (_phone, body) => calls.push(["applicant-type", body]),
    sendOperatorMenu: async () => calls.push(["operator-menu"]),
    sendText: async (_phone, text) => calls.push(["text", text]),
  };
  return { calls, services };
}

test("a new user's ordinary first message receives one combined interactive main menu", async () => {
  const { calls, services } = missingStateServices();

  assert.equal(await handleMissingStateMessage("user", { text: "Вітаю" }, services), true);
  assert.deepEqual(calls, [
    ["initialize", "NORMAL"],
    ["main-menu", messages.welcome.firstContact],
  ]);
});

test("ordinary messages from a known user without state stay silent across repeated delivery", async () => {
  const { calls, services } = missingStateServices({ known: true });

  await handleMissingStateMessage("user", { text: "Повідомлення оператору" }, services);
  await handleMissingStateMessage("user", { text: "Повідомлення оператору" }, services);
  await handleMissingStateMessage("user", { text: "", buttonId: null }, services);

  assert.deepEqual(calls, []);
});

test("an existing applicant or military profile backfills the known-user marker and stays silent", async () => {
  for (const profile of [
    { applicantProfile: { data: { name: "saved" } } },
    { militaryProfile: { name: "saved" } },
  ]) {
    const { calls, services } = missingStateServices(profile);
    await handleMissingStateMessage("user", { text: "Повідомлення оператору" }, services);
    assert.deepEqual(calls, [["mark-known"]]);
  }
});

test("menu command and explicit application button work immediately without prior state", async () => {
  const menu = missingStateServices({ known: true });
  await handleMissingStateMessage("user", { text: " /START " }, menu.services);
  assert.deepEqual(menu.calls, [["initialize", "MENU"], ["main-menu", undefined]]);

  const application = missingStateServices({ known: true });
  await handleMissingStateMessage("user", { buttonId: "send_request" }, application.services);
  assert.deepEqual(application.calls, [
    ["initialize", "SEND_REQUEST"],
    ["applicant-type", messages.welcome.directRequest],
  ]);
});

function concurrentFirstContactServices() {
  const calls = [];
  let state = null;
  let known = false;
  const baseRequest = { data: { phone: "user" }, documents: {}, documentIndex: 0 };
  const services = {
    isKnownUser: async () => known,
    getApplicantProfile: async () => null,
    getMilitaryContactProfile: async () => null,
    markUserKnown: async () => { known = true; },
    initializeUserSession: async (_phone, action) => {
      known = true;
      if (!state) {
        state = {
          stage: action === "SEND_REQUEST" ? "APPLICANT_TYPE" : action === "OPERATOR" ? "OPERATOR" : "MAIN_MENU",
          request: structuredClone(baseRequest),
        };
        return { status: "CREATED", state: structuredClone(state) };
      }
      if (state.stage === "MAIN_MENU" && action === "SEND_REQUEST") {
        state.stage = "APPLICANT_TYPE";
        return { status: "ROUTED", state: structuredClone(state) };
      }
      return { status: "EXISTING", state: structuredClone(state) };
    },
    getUserState: async () => {
      await Promise.resolve();
      return structuredClone(state);
    },
    sendText: async () => calls.push("welcome"),
    sendMainMenu: async (_phone, body) => calls.push(["main-menu", body]),
    sendApplicantTypeMenu: async (_phone, body) => calls.push(["applicant-type", body]),
    sendOperatorMenu: async () => calls.push("operator-menu"),
  };
  return { calls, services, getState: () => state };
}

test("two concurrent identical first-contact webhooks emit one combined menu", async () => {
  const context = concurrentFirstContactServices();
  await Promise.all([
    handleMissingStateMessage("user", { text: "Вітаю" }, context.services),
    handleMissingStateMessage("user", { text: "Вітаю" }, context.services),
  ]);

  assert.deepEqual(context.calls, [["main-menu", messages.welcome.firstContact]]);
  assert.equal(context.getState().stage, "MAIN_MENU");
});

test("a concurrent send_request wins over ordinary first-contact without a stale main menu", async () => {
  const context = concurrentFirstContactServices();
  await Promise.all([
    handleMissingStateMessage("user", { text: "Вітаю" }, context.services),
    handleMissingStateMessage("user", { buttonId: "send_request" }, context.services),
  ]);

  assert.equal(context.getState().stage, "APPLICANT_TYPE");
  assert.deepEqual(context.calls, [["applicant-type", messages.welcome.directRequest]]);
});

test("NEW state recovery preserves request data and supports menu then send_request", async () => {
  const calls = [];
  const originalRequest = { data: { phone: "user", need: "saved" }, documents: { passport: [{ driveFileId: "file" }] } };
  let state = { stage: "NEW", request: structuredClone(originalRequest) };
  const services = {
    initializeUserSession: async (_phone, action) => {
      if (state.stage === "NEW") {
        state.stage = action === "SEND_REQUEST" ? "APPLICANT_TYPE" : "MAIN_MENU";
        if (action !== "SEND_REQUEST") state.recoveredFromNew = true;
      }
      else if (state.stage === "MAIN_MENU" && action === "SEND_REQUEST") state.stage = "APPLICANT_TYPE";
      return { status: "ROUTED", state: structuredClone(state) };
    },
    getUserState: async () => structuredClone(state),
    sendMainMenu: async () => calls.push("main-menu"),
    sendText: async () => calls.push("welcome"),
    sendApplicantTypeMenu: async () => calls.push("applicant-type"),
  };

  await handleMissingStateMessage("user", { text: "/menu", recoveringNewState: true }, services);
  startRequestFromMainMenu(state, "user");
  calls.push("applicant-type");

  assert.deepEqual(state.request.data, originalRequest.data);
  assert.deepEqual(state.request.documents, originalRequest.documents);
  assert.equal(state.request.documentIndex, 0);
  assert.equal(state.stage, "APPLICANT_TYPE");
  assert.deepEqual(calls, ["main-menu", "applicant-type"]);
});

test("ordinary input recovers a legacy NEW state silently", async () => {
  const { calls, services } = missingStateServices();
  services.initializeUserSession = async () => ({ status: "RECOVERED_SILENT", state: { stage: "MAIN_MENU", request: { data: { need: "saved" } } } });

  await handleMissingStateMessage("user", { text: "операторський текст", recoveringNewState: true }, services);
  assert.deepEqual(calls, []);
});

test("ROUTED send_request uses the standard applicant menu without the combined introduction", async () => {
  const calls = [];
  await handleMissingStateMessage("user", { buttonId: "send_request" }, {
    initializeUserSession: async () => ({ status: "ROUTED", state: { stage: "APPLICANT_TYPE", request: {} } }),
    sendApplicantTypeMenu: async (_phone, body) => calls.push(["applicant-type", body]),
  });

  assert.deepEqual(calls, [["applicant-type", undefined]]);
});

test("operator return persists MAIN_MENU and sends one combined menu", async () => {
  assert.equal(isOperatorReturnAction({ stage: "OPERATOR" }, "/menu", null), true);
  assert.equal(isOperatorReturnAction({ stage: "OPERATOR" }, "", "back_to_menu"), true);
  assert.equal(isOperatorReturnAction({ stage: "OPERATOR" }, "звичайний текст", null), false);
  assert.equal(isOperatorReturnAction({ stage: "MAIN_MENU" }, "/menu", null), false);

  const calls = [];
  const state = { stage: "OPERATOR", operatorRequested: true, request: null };
  await returnFromOperatorToMainMenu("user", state, {
    saveUserState: async (_phone, savedState) => calls.push(["save", structuredClone(savedState)]),
    sendMainMenu: async (_phone, body) => calls.push(["main-menu", body]),
  });

  assert.equal(state.stage, "MAIN_MENU");
  assert.equal(state.operatorRequested, false);
  assert.deepEqual(calls, [
    ["save", { stage: "MAIN_MENU", operatorRequested: false, request: null }],
    ["main-menu", messages.navigation.returnedToMainMenu],
  ]);
});

test("confirmed cancellation resets each request type and sends one combined menu without touching known marker", async () => {
  for (const request of [
    { type: "individual", multiPackage: false },
    { type: "military_unit" },
    { type: "individual", multiPackage: true },
  ]) {
    const calls = [];
    let activeRequest = structuredClone(request);
    const freshState = { stage: "NEW", request: { type: null, data: { phone: "user" }, documents: {}, documentIndex: 0 } };
    const state = await completeRequestCancellation("user", {
      resetUserState: async () => {
        assert.deepEqual(activeRequest, request);
        activeRequest = null;
        calls.push(["reset"]);
      },
      createUserState: async () => {
        assert.equal(activeRequest, null);
        calls.push(["create"]);
        return freshState;
      },
      saveUserState: async (_phone, savedState) => calls.push(["save", structuredClone(savedState)]),
      sendMainMenu: async (_phone, body) => calls.push(["main-menu", body]),
    });

    assert.equal(state.stage, "MAIN_MENU");
    assert.deepEqual(calls, [
      ["reset"],
      ["create"],
      ["save", { stage: "MAIN_MENU", request: { type: null, data: { phone: "user" }, documents: {}, documentIndex: 0 } }],
      ["main-menu", messages.navigation.requestCancelled],
    ]);
    assert.equal(calls.some(([event]) => event === "mark-known" || event === "delete-known"), false);
  }
});

test("atomic session initialization cannot leave a marker through separate SET calls", async () => {
  const calls = [];
  const redis = {
    eval: async (script, options) => {
      calls.push({ script, options });
      throw new Error("atomic initialization failed");
    },
    set: async () => { throw new Error("separate SET must not run"); },
  };

  await assert.rejects(initializeUserSession("user", "NORMAL", { redis }), /atomic initialization failed/);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].options.keys, ["wa:user:user", "wa:known:user"]);
  assert.match(calls[0].script, /redis\.call\("SET", KEYS\[2\], "1"\)/);
  assert.ok(
    calls[0].script.indexOf('redis.call("SET", KEYS[1], cjson.encode(state), "EX", ARGV[3])')
      < calls[0].script.indexOf('redis.call("SET", KEYS[2], "1")'),
    "the recoverable state write must precede the persistent marker write",
  );
});

test("a failure after atomic stage creation leaves menu recovery available", async () => {
  const calls = [];
  let state = null;
  const services = {
    isKnownUser: async () => false,
    getApplicantProfile: async () => null,
    getMilitaryContactProfile: async () => null,
    initializeUserSession: async (_phone, action) => {
      const created = !state;
      if (created) state = { stage: "MAIN_MENU", request: {} };
      return { status: created ? "CREATED" : "EXISTING", state: structuredClone(state) };
    },
    getUserState: async () => { throw new Error("post-initialize read failed"); },
    sendMainMenu: async () => calls.push("main-menu"),
    sendText: async () => calls.push("welcome"),
  };

  await assert.rejects(
    handleMissingStateMessage("user", { text: "Вітаю" }, services),
    /post-initialize read failed/,
  );
  assert.equal(state.stage, "MAIN_MENU");
  assert.deepEqual(calls, []);

  await handleMissingStateMessage("user", { text: "/menu" }, services);
  assert.deepEqual(calls, ["main-menu"]);
});

test("active request continues when known-marker backfill lookup fails", async () => {
  const logs = [];
  let activeStepHandled = false;
  const result = await backfillKnownUserMarker("user", {
    isKnownUser: async () => { throw Object.assign(new Error("redis unavailable"), { code: "ECONNRESET" }); },
    markUserKnown: async () => { throw new Error("must not run"); },
    logFailure: (details) => logs.push(details),
  });
  if (!result) activeStepHandled = true;

  assert.equal(result, false);
  assert.equal(activeStepHandled, true);
  assert.deepEqual(logs, [{ event: "known_user_marker_backfill_failed", errorCode: "ECONNRESET" }]);
});

test("inactive states suppress ordinary text and media but not commands or explicit buttons", () => {
  const inactive = { stage: "MAIN_MENU", request: null };
  const operator = { stage: "OPERATOR", request: null };
  const active = { stage: "DOCUMENTS", request: { documents: {} } };

  assert.equal(shouldSilenceInactiveMessage(inactive, "текст", null), true);
  assert.equal(shouldSilenceInactiveMessage(operator, "", null), true);
  assert.equal(shouldSilenceInactiveMessage(inactive, "/menu", null), false);
  assert.equal(shouldSilenceInactiveMessage(inactive, "", "send_request"), false);
  assert.equal(shouldSilenceInactiveMessage(active, "текст", null), false);
});

test("WhatsApp reactions are ignored before state handling", () => {
  assert.equal(shouldIgnoreWebhookMessage({ type: "reaction" }), true);
  assert.equal(shouldIgnoreWebhookMessage({ type: "text" }), false);
  assert.equal(shouldIgnoreWebhookMessage(null), false);
});

test("known-user marker has no TTL option and survives request-state reset", async () => {
  const values = new Map();
  const setCalls = [];
  const redis = {
    get: async (key) => values.get(key) ?? null,
    set: async (key, value, options) => {
      setCalls.push({ key, value, options });
      values.set(key, value);
    },
    del: async (...keys) => keys.forEach((key) => values.delete(key)),
    keys: async () => [],
  };

  await markUserKnown("user", { redis });
  values.set("wa:user:user", "state");
  await resetUserState("user", { redis });

  assert.equal(await isKnownUser("user", { redis }), true);
  assert.deepEqual(setCalls, [{ key: "wa:known:user", value: "1", options: undefined }]);
  assert.equal(values.has("wa:user:user"), false);
});

test("Redis lookup errors do not produce fallback bot messages", async () => {
  const { calls, services } = missingStateServices();
  services.isKnownUser = async () => { throw new Error("redis unavailable"); };

  await assert.rejects(
    handleMissingStateMessage("user", { text: "Повідомлення оператору" }, services),
    /redis unavailable/,
  );
  assert.deepEqual(calls, []);
});

test("successful application message includes immediate repeat-application instruction", async () => {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let payload;
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messages: [{ id: "mock" }] }) };
  };
  try {
    await sendApplicationAccepted("user", "2026-10-0001");
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }

  assert.match(payload.interactive.body.text, /Щоб подати ще одну заявку, надішліть \/menu$/);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), ["send_request", "operator"]);
});
