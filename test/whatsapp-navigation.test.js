import assert from "node:assert/strict";
import test from "node:test";

import { sendApplicantTypeMenu } from "../lib/whatsapp.js";

async function captureApplicantTypeMenu() {
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
    await sendApplicantTypeMenu("test-recipient");
    return request;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
}

test("applicant type menu includes navigation guidance whenever a request starts", async () => {
  const expectedText = "Хто подає запит?\n\n💡 Навігація: під час заповнення заявки надішліть /menu, щоб відкрити меню, де можна продовжити або скасувати поточну заявку.\n\nВведені дані не видаляються, доки ви не підтвердите скасування.";

  for (const payload of [await captureApplicantTypeMenu(), await captureApplicantTypeMenu()]) {
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "button");
    assert.equal(payload.interactive.body.text, expectedText);
    assert.deepEqual(payload.interactive.action.buttons, [
      { type: "reply", reply: { id: "individual", title: "👤 Фізична особа" } },
      { type: "reply", reply: { id: "military_unit", title: "🏢 Військова частина" } },
    ]);
  }
});
