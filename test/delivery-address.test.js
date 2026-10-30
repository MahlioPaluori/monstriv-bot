import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptDeliveryAddress,
  acceptLegacyDeliveryCity,
  applyEditedField,
  beginCombinedDeliveryAddressStep,
  buildConfirmationMessages,
  formatConfirmationSummary,
  repeatCurrentPrompt,
  sendConfirmationFailure,
} from "../api/webhook.js";
import { requestCardPage } from "../api/request-card.js";
import {
  COMBINED_DELIVERY_ADDRESS_FORMAT,
  inferStoredDeliveryAddressFormat,
  normalizeDeliveryAddress,
} from "../lib/delivery-address.js";
import { assertRequestDeliveryAddressWithinSheetsLimit, normalizeRequestRow } from "../lib/google-sheets.js";
import { sendEditMenu } from "../lib/whatsapp.js";

function requestState(type = "individual", multiPackage = false) {
  return {
    stage: "CITY",
    request: {
      type,
      multiPackage,
      data: { name: "Applicant", phone: "380000000000", need: "Need" },
      documents: {},
      beneficiaries: multiPackage ? [] : undefined,
    },
  };
}

test("single, military and multi requests store one unparsed delivery address and leave the branch empty", async () => {
  for (const [type, multiPackage] of [["individual", false], ["military_unit", false], ["individual", true]]) {
    const state = requestState(type, multiPackage);
    const saved = [];
    const menus = [];
    const input = "  Харківська обл\nСлобожанське\n1 відділення\nЧугуївський р-н  ";
    const result = await acceptDeliveryAddress("phone", state, input, {
      saveUserState: async (_phone, value) => saved.push(structuredClone(value)),
      sendYesNoMenu: async (...args) => menus.push(args),
    });
    assert.equal(result.status, "ACCEPTED");
    assert.equal(state.request.data.city, "Харківська обл\nСлобожанське\n1 відділення\nЧугуївський р-н");
    assert.equal(state.request.data.novaPoshtaBranch, "");
    assert.equal(state.request.data.deliveryAddressFormat, COMBINED_DELIVERY_ADDRESS_FORMAT);
    assert.equal(state.stage, "RECIPIENT_CHOICE");
    assert.equal(saved.length, 1);
    assert.equal(menus.length, 1);
  }
});

test("new address workflow is marked before waiting for CITY input", () => {
  const state = requestState();
  beginCombinedDeliveryAddressStep(state);
  assert.equal(state.stage, "CITY");
  assert.equal(state.request.data.deliveryAddressFormat, COMBINED_DELIVERY_ADDRESS_FORMAT);
  assert.equal(state.request.data.city, undefined);
});

test("empty and oversized delivery addresses do not mutate or advance the request", async () => {
  for (const input of ["  \n  ", "x".repeat(50_001)]) {
    const state = requestState();
    const messages = [];
    const result = await acceptDeliveryAddress("phone", state, input, {
      saveUserState: async () => assert.fail("invalid address must not be saved"),
      sendYesNoMenu: async () => assert.fail("invalid address must not advance"),
      sendText: async (_phone, message) => messages.push(message),
    });
    assert.notEqual(result.status, "ACCEPTED");
    assert.equal(state.stage, "CITY");
    assert.equal(state.request.data.city, undefined);
    assert.equal(messages.length, 1);
  }
});

test("Sheets address validation accepts 50,000 characters and rejects 50,001 without truncation", () => {
  assert.doesNotThrow(() => assertRequestDeliveryAddressWithinSheetsLimit({ data: { city: "x".repeat(50_000), novaPoshtaBranch: "" } }));
  assert.throws(
    () => assertRequestDeliveryAddressWithinSheetsLimit({ data: { city: "x".repeat(50_001), novaPoshtaBranch: "" } }),
    { code: "DELIVERY_ADDRESS_TOO_LONG" },
  );
});

test("an oversized restored address returns to safe editing without losing request state", async () => {
  const state = requestState();
  state.stage = "CONFIRMATION";
  state.request.applicationId = "2026-10-0099";
  state.request.data.city = "x".repeat(50_001);
  state.request.data.novaPoshtaBranch = "";
  const originalRequest = state.request;
  const saved = [];
  const notices = [];
  const error = new Error("too long");
  error.code = "DELIVERY_ADDRESS_TOO_LONG";
  const result = await sendConfirmationFailure("phone", state, async () => {}, error, {
    persistState: async (_phone, value) => saved.push(structuredClone(value)),
    sendFailureText: async (_phone, value) => notices.push(value),
  });
  assert.equal(result.needsShorterDeliveryAddress, true);
  assert.equal(state.stage, "EDIT_TEXT");
  assert.equal(state.editField, "deliveryAddress");
  assert.equal(state.request, originalRequest);
  assert.equal(state.request.applicationId, "2026-10-0099");
  assert.equal(saved.length, 1);
  assert.equal(notices.length, 1);
});

test("editing a delivery address migrates old delivery fields without truncation", async () => {
  const state = requestState();
  state.stage = "EDIT_TEXT";
  state.editField = "deliveryAddress";
  state.request.data.city = "Одеса";
  state.request.data.novaPoshtaBranch = "15";
  let confirmationState;
  await applyEditedField("phone", state, " Київ, НП 23 ", {
    showConfirmation: async (_phone, value) => { confirmationState = structuredClone(value); },
  });
  assert.equal(confirmationState.request.data.city, "Київ, НП 23");
  assert.equal(confirmationState.request.data.novaPoshtaBranch, "");
  assert.equal(confirmationState.request.data.deliveryAddressFormat, COMBINED_DELIVERY_ADDRESS_FORMAT);
  assert.equal(confirmationState.editField, undefined);
});

test("legacy CITY recovery keeps the two-step prompt while marked CITY uses the combined prompt", async () => {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  const prompts = [];
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).text.body);
    return { ok: true, json: async () => ({}) };
  };
  try {
    const legacyCity = requestState();
    await repeatCurrentPrompt("phone", legacyCity);
    const combinedCity = requestState();
    beginCombinedDeliveryAddressStep(combinedCity);
    await repeatCurrentPrompt("phone", combinedCity);
    const legacyBranch = requestState();
    legacyBranch.stage = "NOVA_POSHTA_BRANCH";
    legacyBranch.request.data.city = "Одеса";
    await repeatCurrentPrompt("phone", legacyBranch);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
  assert.match(prompts[0], /місто/);
  assert.match(prompts[1], /Адреса доставки/);
  assert.match(prompts[2], /відділення Нової пошти/);
});

test("legacy CITY answer remains city-only and continues to the branch step", async () => {
  const state = requestState();
  const saved = [];
  const prompts = [];
  const result = await acceptLegacyDeliveryCity("phone", state, "  Одеса  ", {
    saveUserState: async (_phone, value) => saved.push(structuredClone(value)),
    sendText: async (_phone, value) => prompts.push(value),
  });
  assert.equal(result.status, "ACCEPTED");
  assert.equal(state.request.data.city, "Одеса");
  assert.equal(state.request.data.deliveryAddressFormat, undefined);
  assert.equal(state.stage, "NOVA_POSHTA_BRANCH");
  assert.equal(saved.length, 1);
  assert.match(prompts[0], /відділення Нової пошти/);
});

test("confirmation uses one address line for new requests and two legacy fields for old requests", () => {
  const combined = requestState();
  combined.request.data.city = "Одеса, відділення №15";
  combined.request.data.novaPoshtaBranch = "";
  combined.request.data.deliveryAddressFormat = COMBINED_DELIVERY_ADDRESS_FORMAT;
  const combinedText = formatConfirmationSummary(combined);
  assert.match(combinedText, /Адреса доставки: Одеса, відділення №15/);
  assert.doesNotMatch(combinedText, /Відділення Нової пошти:/);

  const legacy = requestState();
  legacy.request.data.city = "Одеса";
  legacy.request.data.novaPoshtaBranch = "15";
  const legacyText = formatConfirmationSummary(legacy);
  assert.match(legacyText, /Місто: Одеса/);
  assert.match(legacyText, /Відділення Нової пошти: 15/);

  combined.request.multiPackage = true;
  combined.request.beneficiaries = [];
  assert.match(buildConfirmationMessages("phone", combined).at(-1), /Адреса доставки: Одеса, відділення №15/);
});

test("Sheets infer combined delivery from a filled city and empty branch without text heuristics", () => {
  const combined = normalizeRequestRow("individual", [
    "Нова", "2026-10-0001", "30.10.2026", "Need", "Person", "phone", "", "", "", "",
    "Одеса, відділення №15", "", "Ні", "", "",
  ]);
  assert.equal(combined.city, "Одеса, відділення №15");
  assert.equal(combined.novaPoshtaBranch, "");
  assert.equal(combined.deliveryAddressFormat, COMBINED_DELIVERY_ADDRESS_FORMAT);
  assert.equal(inferStoredDeliveryAddressFormat("Київ, НП 23", ""), COMBINED_DELIVERY_ADDRESS_FORMAT);
  assert.equal(inferStoredDeliveryAddressFormat("Одеса 15", ""), COMBINED_DELIVERY_ADDRESS_FORMAT);

  const legacy = normalizeRequestRow("military_unit", [
    "Нова", "2026-10-0002", "30.10.2026", "Need", "Contact", "phone", "A1234", "",
    "Одеса", "15", "Ні", "", "",
  ]);
  assert.equal(legacy.deliveryAddressFormat, null);
  assert.equal(inferStoredDeliveryAddressFormat("Одеса", ""), COMBINED_DELIVERY_ADDRESS_FORMAT);
  assert.equal(inferStoredDeliveryAddressFormat("", ""), null);
  assert.equal(normalizeDeliveryAddress(" A\nB "), "A\nB");
});

test("request cards render multiline combined addresses and retain legacy delivery fields", () => {
  const common = {
    type: "individual", applicationId: "2026-10-0001", date: "30.10.2026", personName: "Person",
    mainPhone: "phone", need: "Need", actualRecipientName: "Person", actualRecipientPhone: "phone", documents: {},
  };
  const combined = requestCardPage({ ...common, city: "Область\nМісто\nвідділення №1", novaPoshtaBranch: "", deliveryAddressFormat: COMBINED_DELIVERY_ADDRESS_FORMAT });
  assert.match(combined, /Адреса доставки:<\/strong>/);
  assert.match(combined, /Область\nМісто\nвідділення №1/);
  assert.doesNotMatch(combined, /Нова пошта:<\/strong>/);
  assert.match(combined, /white-space: pre-wrap/);

  const legacy = requestCardPage({ ...common, city: "Одеса", novaPoshtaBranch: "15" });
  assert.match(legacy, /Місто:<\/strong>/);
  assert.match(legacy, /Нова пошта:<\/strong>/);
});

test("request cards support heuristic-free fallback and omit empty delivery fields", () => {
  const common = {
    type: "individual", applicationId: "2026-10-0001", date: "30.10.2026", personName: "Person",
    mainPhone: "phone", need: "Need", actualRecipientName: "Person", actualRecipientPhone: "phone", documents: {},
  };
  const sheetFallback = requestCardPage({
    ...common,
    city: "Одеса 15",
    novaPoshtaBranch: "",
    deliveryAddressFormat: inferStoredDeliveryAddressFormat("Одеса 15", ""),
  });
  assert.match(sheetFallback, /Адреса доставки:<\/strong> <span>Одеса 15<\/span>/);
  assert.doesNotMatch(sheetFallback, /Місто:<\/strong>|Нова пошта:<\/strong>/);

  const oldRequest = requestCardPage({ ...common, city: "Одеса", novaPoshtaBranch: "15" });
  assert.match(oldRequest, /Місто:<\/strong> <span>Одеса<\/span>/);
  assert.match(oldRequest, /Нова пошта:<\/strong> <span>15<\/span>/);

  const empty = requestCardPage({ ...common, city: "", novaPoshtaBranch: "" });
  assert.doesNotMatch(empty, /Адреса доставки:<\/strong>|Місто:<\/strong>|Нова пошта:<\/strong>/);

  const explicitMarker = requestCardPage({
    ...common,
    city: "Область\nСело\n15",
    novaPoshtaBranch: "legacy-value",
    deliveryAddressFormat: COMBINED_DELIVERY_ADDRESS_FORMAT,
  });
  assert.match(explicitMarker, /Адреса доставки:<\/strong>/);
  assert.match(explicitMarker, /Область\nСело\n15/);
  assert.doesNotMatch(explicitMarker, /Нова пошта:<\/strong>/);
});

test("new-format edit menus expose one delivery row and keep legacy callback IDs compatible", async () => {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let payload;
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => { payload = JSON.parse(options.body); return { ok: true, json: async () => ({}) }; };
  try {
    await sendEditMenu("phone", "military_unit", false, true);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
  const rows = payload.interactive.action.sections[0].rows;
  assert.deepEqual(rows.filter(({ id }) => id === "edit_city" || id === "edit_np"), [{ id: "edit_city", title: "Адресу доставки" }]);
});
