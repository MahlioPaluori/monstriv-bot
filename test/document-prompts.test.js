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
      documentActionToken: "aabbccddeeff",
      documents: {},
      data: {},
    },
  };
}

test("document recovery prompts clearly request a photo for every supported document", async () => {
  const cases = [
    ["individual", 0, "📕 *Паспорт*\n\n📸 Надішліть фото першої сторінки паспорта."],
    ["individual", 1, "🪪 *РНОКПП (ідентифікаційний код)*\n\n📸 Надішліть фото РНОКПП"],
    ["individual", 2, "📄 *Військово-обліковий або службовий документ*"],
    ["individual", 3, "🏅 *Посвідчення учасника бойових дій (УБД)*"],
    ["military_unit", 0, "📄 *Офіційний лист військової частини*"],
  ];

  for (const [type, index, expectedPrompt] of cases) {
    const payload = await capturePrompt(documentState(type, index));
    assert.equal(payload.type, "interactive");
    assert.equal(payload.interactive.type, "button");
    const body = payload.interactive.body.text;
    assert.ok(body.startsWith(expectedPrompt), `${type}/${index}: ${body}`);
    assert.match(body, /не більше 5 МБ/);
    assert.match(body, /натисніть \*«Готово»\*/);
    assert.equal(payload.interactive.action.buttons[0].reply.id, `document_done_taabbccddeeff_${type === "military_unit" ? "official_request" : ["passport", "rnokpp", "military_id", "ubd"][index]}`);
  }
});

test("military document prompt uses the approved focused instructions", async () => {
  const payload = await capturePrompt(documentState("individual", 2));
  const body = payload.interactive.body.text;
  assert.match(body, /• Військовий квиток\n• Посвідчення офіцера\n• Службове посвідчення/);
  assert.match(body, /\*Для військового квитка потрібні 2 сторінки:\*/);
  assert.match(body, /1\. Перша сторінка з особистими даними\./);
  assert.match(body, /2\. Розділ 17 із зазначенням актуальної військової частини\./);
  assert.doesNotMatch(body, /всі сторінки|Міністерств|відомств/iu);
});

test("optional UBD recovery prompt retains the skip action and optional explanation", async () => {
  const payload = await capturePrompt(documentState("individual", 3));
  assert.equal(payload.interactive.type, "button");
  assert.ok(payload.interactive.body.text.startsWith("🏅 *Посвідчення учасника бойових дій (УБД)*"));
  assert.match(payload.interactive.body.text, /лише за наявності/);
  assert.match(payload.interactive.body.text, /не є обов'язковим/);
  assert.deepEqual(payload.interactive.action.buttons, [
    { type: "reply", reply: { id: "document_done_taabbccddeeff_ubd", title: "✅ Готово" } },
    { type: "reply", reply: { id: "document_skip_taabbccddeeff_ubd", title: "⏭ Пропустити" } },
  ]);
});

test("multi document prompts retain beneficiary-scoped Done and Skip IDs", async () => {
  const state = {
    stage: "DOCUMENTS",
    request: {
      type: "individual",
      multiPackage: true,
      currentBeneficiaryIndex: 1,
      beneficiaries: [
        { documents: {}, documentIndex: 0 },
        { documents: {}, documentIndex: 3, documentActionToken: "112233aabbcc" },
      ],
    },
  };
  const payload = await capturePrompt(state);
  assert.deepEqual(payload.interactive.action.buttons.map((button) => button.reply.id), [
    "document_done_t112233aabbcc_1_ubd",
    "document_skip_t112233aabbcc_1_ubd",
  ]);
});

test("pressing Done before upload repeats the full current document instructions", async () => {
  const prompts = ["passport", "military", "official request"];
  for (const uploadPrompt of prompts) {
    const messages = [];
    const state = documentState("individual", 0);
    const result = await advanceCurrentDocument("phone", state, { key: "passport", uploadPrompt }, true, {
      advanceDocumentStage: async () => ({ status: "EMPTY", state }),
      sendDocumentStepPrompt: async (_phone, _state, issue) => messages.push(issue),
      askDocument: async () => assert.fail("empty document must not advance"),
    });
    assert.equal(result.status, "EMPTY");
    assert.equal(messages[0], "Спочатку надішліть хоча б один файл для поточного документа.");
  }
});
