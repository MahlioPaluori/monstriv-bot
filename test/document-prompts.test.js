import assert from "node:assert/strict";
import test from "node:test";

import { advanceCurrentDocument, repeatCurrentPrompt } from "../api/webhook.js";

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
    ["individual", 0, "📸 Надішліть фото першої сторінки паспорта.\n\nНам потрібна лише перша сторінка.\n\nРозмір кожного файлу — не більше 5 МБ."],
    ["individual", 1, "📸 Надішліть фото РНОКПП (ідентифікаційного коду). Розмір кожного файлу — не більше 5 МБ."],
    ["individual", 2, "📸 Надішліть фото військово-облікового документа.\n\nПотрібні дві сторінки:\n\n1. Перша сторінка.\n2. Сторінка з актуальною військовою частиною та посадою (розділ 17).\n\nРозмір кожного файлу — не більше 5 МБ."],
    ["individual", 3, "📸 Надішліть фото посвідчення учасника бойових дій (УБД). Розмір кожного файлу — не більше 5 МБ."],
    ["military_unit", 0, "📸 Надішліть фото листа-запиту від військової частини.\n\nРозмір кожного файлу — не більше 5 МБ."],
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
  assert.ok(payload.interactive.body.text.startsWith("📸 Надішліть фото посвідчення учасника бойових дій (УБД). Розмір кожного файлу — не більше 5 МБ."));
  assert.match(payload.interactive.body.text, /лише за наявності/);
  assert.match(payload.interactive.body.text, /не є обов'язковим/);
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "document_skip", title: "⏭ Пропустити" } },
  ]);
});

test("pressing Done before upload repeats the full current document instructions", async () => {
  const prompts = [
    "📸 Надішліть фото першої сторінки паспорта.\n\nНам потрібна лише перша сторінка.\n\nРозмір кожного файлу — не більше 5 МБ.",
    "📸 Надішліть фото військово-облікового документа.\n\nПотрібні дві сторінки:\n\n1. Перша сторінка.\n2. Сторінка з актуальною військовою частиною та посадою (розділ 17).\n\nРозмір кожного файлу — не більше 5 МБ.",
    "📸 Надішліть фото листа-запиту від військової частини.\n\nРозмір кожного файлу — не більше 5 МБ.",
  ];
  for (const uploadPrompt of prompts) {
    const messages = [];
    const state = documentState("individual", 0);
    const result = await advanceCurrentDocument("phone", state, { key: "passport", uploadPrompt }, true, {
      advanceDocumentStage: async () => ({ status: "EMPTY", state }),
      sendText: async (_phone, text) => messages.push(text),
      askDocument: async () => assert.fail("empty document must not advance"),
    });
    assert.equal(result.status, "EMPTY");
    assert.equal(messages[0], `Спочатку виконайте цей крок:\n\n${uploadPrompt}`);
  }
});
