import assert from "node:assert/strict";
import test from "node:test";

import { sendApplicantTypeMenu, sendMainMenu } from "../lib/whatsapp.js";

async function captureMenu(sendMenu) {
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
    await sendMenu("test-recipient");
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
  const expectedText = "Хто подає запит?\n\n💡 Навігація: під час заповнення заявки надішліть команду /menu, щоб відкрити меню, де можна продовжити або скасувати поточну заявку.\n\nВведені дані не видаляються, доки ви не підтвердите скасування.";

  for (const payload of [await captureMenu(sendApplicantTypeMenu), await captureMenu(sendApplicantTypeMenu)]) {
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "button");
    assert.equal(payload.interactive.body.text, expectedText);
    assert.deepEqual(payload.interactive.action.buttons, [
      { type: "reply", reply: { id: "individual", title: "👤 Фізична особа" } },
      { type: "reply", reply: { id: "military_unit", title: "🏢 Військова частина" } },
    ]);
  }
});

test("main menu explains the bot purpose without changing its actions", async () => {
  const payload = await captureMenu(sendMainMenu);

  assert.equal(payload.type, "interactive");
  assert.equal(payload.interactive.type, "button");
  assert.equal(payload.interactive.body.text, "Вітаємо! 👋\n\nЦе бот Благодійного фонду «Корпорація Монстрів» для збору та опрацювання запитів на допомогу.\n\nОберіть, що потрібно зробити:");
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "send_request", title: "📤 Відправити запит" } },
    { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
  ]);
});
