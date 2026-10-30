import assert from "node:assert/strict";
import test from "node:test";

import { handleDocumentStageFallback } from "../api/webhook.js";

function documentState(documentIndex, documents = {}) {
  return {
    stage: "DOCUMENTS",
    request: {
      type: "individual",
      multiPackage: false,
      data: { name: "Test" },
      documentIndex,
      documentActionToken: "aabbccddeeff",
      documents,
    },
  };
}

async function captureDocumentTextResponse(state, text) {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  const payloads = [];
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone-id";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => {
    payloads.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ messages: [{ id: "mock-message" }] }) };
  };
  try {
    const handled = await handleDocumentStageFallback("test-recipient", state, {
      message: { id: "text-message", type: "text", text: { body: text } },
      text,
      buttonId: null,
      fileId: null,
    });
    return { handled, payloads };
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID;
    else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN;
    else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
}

test("unsupported message type in DOCUMENTS is logged safely and sends no menu instruction", async () => {
  const state = documentState(0);
  const before = structuredClone(state);
  const logs = [];
  const handled = await handleDocumentStageFallback("private-phone", state, {
    message: { id: "wamid.unsupported", type: "sticker", sticker: { id: "private-media" } },
    text: "",
    buttonId: null,
    fileId: null,
  }, {
    logUnsupported: (details) => logs.push(details),
    sendText: async () => assert.fail("unsupported DOCUMENTS event must stay silent"),
    repeatCurrentPrompt: async () => assert.fail("unsupported DOCUMENTS event must not repeat a prompt"),
  });
  assert.equal(handled, true);
  assert.deepEqual(state, before);
  assert.deepEqual(logs, [{
    messageId: "wamid.unsupported",
    messageType: "sticker",
    stage: "DOCUMENTS",
    hasText: false,
    hasButtonId: false,
    hasFileId: false,
  }]);
  assert.doesNotMatch(JSON.stringify(logs), /private-phone|private-media/);
});

test("numeric RNOKPP text requests a photo or PDF and repeats the RNOKPP prompt without losing files", async () => {
  const passport = [{ mediaId: "passport-media", driveFileId: "passport-drive" }];
  const state = documentState(1, { passport });
  const before = structuredClone(state);
  const { handled, payloads } = await captureDocumentTextResponse(state, "1234567890");
  assert.equal(handled, true);
  assert.equal(payloads.length, 1);
  assert.equal(payloads[0].type, "interactive");
  assert.match(payloads[0].interactive.body.text, /^Будь ласка, надішліть фото або PDF-файл замість тексту\./);
  assert.match(payloads[0].interactive.body.text, /РНОКПП/);
  assert.equal(payloads[0].interactive.action.buttons[0].reply.id, "document_done_taabbccddeeff_rnokpp");
  assert.deepEqual(state, before);
  assert.equal(state.request.documentIndex, 1);
  assert.deepEqual(state.request.documents.passport, passport);
});

test("arbitrary passport text gets the same explanation and repeats the passport prompt", async () => {
  const state = documentState(0);
  const before = structuredClone(state);
  const { handled, payloads } = await captureDocumentTextResponse(state, "це мій паспорт");
  assert.equal(handled, true);
  assert.equal(payloads.length, 1);
  assert.match(payloads[0].interactive.body.text, /надішліть фото або PDF-файл замість тексту/i);
  assert.match(payloads[0].interactive.body.text, /📕 \*Паспорт\*/);
  assert.deepEqual(state, before);
});

test("menu commands, valid image or PDF, and other stages keep their existing routing", async () => {
  const state = documentState(0);
  const calls = [];
  const services = {
    logUnsupported: () => calls.push("log"),
    sendText: async () => calls.push("text"),
    repeatCurrentPrompt: async () => calls.push("repeat"),
  };
  assert.equal(await handleDocumentStageFallback("phone", state, { message: { id: "menu", type: "text" }, text: "/menu", buttonId: null, fileId: null }, services), false);
  assert.equal(await handleDocumentStageFallback("phone", state, { message: { id: "image", type: "image" }, text: "", buttonId: null, fileId: "image-media" }, services), false);
  assert.equal(await handleDocumentStageFallback("phone", state, { message: { id: "pdf", type: "document" }, text: "", buttonId: null, fileId: "pdf-media" }, services), false);
  assert.equal(await handleDocumentStageFallback("phone", { ...state, stage: "CITY" }, { message: { id: "location", type: "location" }, text: "", buttonId: null, fileId: null }, services), false);
  assert.deepEqual(calls, []);
});
