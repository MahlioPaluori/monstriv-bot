import assert from "node:assert/strict";
import test from "node:test";

import { sendYesNoMenu } from "../lib/whatsapp.js";

async function captureMenu(body, yesId, noId) {
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
    await sendYesNoMenu("test-recipient", body, yesId, noId);
    return request;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
}

test("confirmation menu labels edit_request as Редагувати without changing button IDs", async () => {
  const payload = await captureMenu("Підтвердити заявку?", "confirm_request", "edit_request");
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "confirm_request", title: "Так" } },
    { type: "reply", reply: { id: "edit_request", title: "Редагувати" } },
  ]);
});

test("ordinary yes-no menus keep the Ні label", async () => {
  const payload = await captureMenu("Інше питання?", "other_yes", "other_no");
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "other_yes", title: "Так" } },
    { type: "reply", reply: { id: "other_no", title: "Ні" } },
  ]);
});
