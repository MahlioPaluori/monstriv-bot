import assert from "node:assert/strict";
import test from "node:test";

import { repeatCurrentPrompt } from "../api/webhook.js";

async function capturePrompt(state) {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  let payload;
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => {
    payload = JSON.parse(options.body);
    return { ok: true, json: async () => ({ messages: [{ id: "mock-message" }] }) };
  };

  try {
    await repeatCurrentPrompt("test-recipient", state);
    return payload;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
}

function documentState(type, documentIndex) {
  return {
    stage: "DOCUMENTS",
    request: {
      type,
      multiPackage: false,
      documentIndex,
      documents: {},
      data: {},
    },
  };
}

test("document recovery prompts clearly request a photo for every supported document", async () => {
  const cases = [
    ["individual", 0, "📸 Надішліть фото паспорта."],
    ["individual", 1, "📸 Надішліть фото РНОКПП (ідентифікаційного коду)."],
    ["individual", 2, "📸 Надішліть фото військово-облікового документа."],
    ["individual", 3, "📸 Надішліть фото посвідчення учасника бойових дій (УБД)."],
    ["military_unit", 0, "📸 Надішліть фото офіційного листа військової частини."],
  ];

  for (const [type, index, expectedPrompt] of cases) {
    const payload = await capturePrompt(documentState(type, index));
    const body = payload.type === "text" ? payload.text.body : payload.interactive.body.text;
    assert.ok(body.startsWith(expectedPrompt), `${type}/${index}: ${body}`);
    assert.match(body, /один або кілька файлів\/фото/);
  }
});

test("optional UBD recovery prompt retains the skip action and optional explanation", async () => {
  const payload = await capturePrompt(documentState("individual", 3));
  assert.equal(payload.interactive.type, "button");
  assert.match(payload.interactive.body.text, /не є обов'язковим/);
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "document_skip", title: "⏭ Пропустити" } },
  ]);
});
