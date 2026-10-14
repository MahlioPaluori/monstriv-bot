import assert from "node:assert/strict";
import test from "node:test";

import { applyEditedField, getInteractiveReplyId, repeatCurrentPrompt } from "../api/webhook.js";
import { sendEditMenu } from "../lib/whatsapp.js";

async function captureEditMenu(type, multiPackage = false) {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let request;
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messages: [{ id: "mock-message" }] }) };
  };
  try {
    await sendEditMenu("test-recipient", type, multiPackage);
    return request;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
}

function assertValidEditList(payload, expectedRows) {
  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.type, "list");
  assert.equal(payload.interactive.body.text, "Що бажаєте виправити в заявці?");
  assert.equal(payload.interactive.action.button, "Обрати поле");
  assert.equal(payload.interactive.action.sections.length, 1);
  const rows = payload.interactive.action.sections[0].rows;
  assert.deepEqual(rows, expectedRows);
  assert.ok(rows.length >= 1 && rows.length <= 10);
  assert.ok(rows.every((row) => row.title.length <= 24));
}

test("sendEditMenu builds a valid list for an individual single request", async () => {
  assertValidEditList(await captureEditMenu("individual", false), [
    { id: "edit_name", title: "ПІБ" },
    { id: "edit_need", title: "Потребу" },
    { id: "edit_city", title: "Місто" },
    { id: "edit_np", title: "Нову пошту" },
    { id: "edit_recipient", title: "Отримувача" },
  ]);
});

test("sendEditMenu adds only the beneficiary row for an individual multi request", async () => {
  const payload = await captureEditMenu("individual", true);
  assertValidEditList(payload, [
    { id: "edit_name", title: "ПІБ" },
    { id: "edit_need", title: "Потребу" },
    { id: "edit_city", title: "Місто" },
    { id: "edit_np", title: "Нову пошту" },
    { id: "edit_recipient", title: "Отримувача" },
    { id: "edit_beneficiary", title: "Дані особи" },
  ]);
});

test("sendEditMenu adds only the unit-number row for a military request", async () => {
  const payload = await captureEditMenu("military_unit", false);
  assertValidEditList(payload, [
    { id: "edit_name", title: "ПІБ" },
    { id: "edit_unit_number", title: "Номер ВЧ" },
    { id: "edit_need", title: "Потребу" },
    { id: "edit_city", title: "Місто" },
    { id: "edit_np", title: "Нову пошту" },
    { id: "edit_recipient", title: "Отримувача" },
  ]);
});

test("list reply IDs use the existing callback normalization", () => {
  assert.equal(getInteractiveReplyId({ interactive: { list_reply: { id: "edit_need" } } }), "edit_need");
  assert.equal(getInteractiveReplyId({ interactive: { button_reply: { id: "edit_name" } } }), "edit_name");
  assert.equal(getInteractiveReplyId({ button: { payload: "edit_city" } }), "edit_city");
});

test("editing a field returns the request to confirmation without losing its data", async () => {
  const state = {
    stage: "EDIT_TEXT",
    editField: "name",
    request: {
      multiPackage: true,
      data: { name: "Old name", need: "Existing need" },
      beneficiaries: [{ isApplicant: true, name: "Old name", documents: { passport: [{ driveFileId: "file-1" }] } }],
    },
  };
  await applyEditedField("phone", state, "New name", {
    showConfirmation: async (_from, current) => { current.stage = "CONFIRMATION"; },
  });
  assert.equal(state.stage, "CONFIRMATION");
  assert.equal(state.request.data.name, "New name");
  assert.equal(state.request.data.need, "Existing need");
  assert.equal(state.request.beneficiaries[0].name, "New name");
  assert.equal(state.request.beneficiaries[0].documents.passport[0].driveFileId, "file-1");
  assert.equal("editField" in state, false);
});

test("an existing EDIT_MENU state resumes through the production prompt router", async () => {
  const calls = [];
  const state = { stage: "EDIT_MENU", request: { type: "individual", multiPackage: false, data: { need: "Saved" } } };
  await repeatCurrentPrompt("phone", state, {
    sendEditMenu: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [["phone", "individual", false]]);
  assert.equal(state.stage, "EDIT_MENU");
  assert.equal(state.request.data.need, "Saved");
});
