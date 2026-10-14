import assert from "node:assert/strict";
import test from "node:test";

import { advanceCurrentDocument, saveIncomingDocument } from "../api/webhook.js";
import { sendDocumentDone } from "../lib/whatsapp.js";

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function coordinator(initialState) {
  let current = clone(initialState);
  const claims = new Set();
  const inFlight = new Set();
  return {
    begin: async (_phone, uploadId, context) => {
      if (claims.has(uploadId)) return "DUPLICATE";
      const store = context.beneficiaryIndex === null ? current.request : current.request.beneficiaries[context.beneficiaryIndex];
      if (current.stage !== "DOCUMENTS" || store.documentIndex !== context.documentIndex) return "STALE";
      claims.add(uploadId); inFlight.add(uploadId); return "STARTED";
    },
    complete: async (_phone, uploadId, context) => {
      const store = context.beneficiaryIndex === null ? current.request : current.request.beneficiaries[context.beneficiaryIndex];
      store.documents[context.documentKey] ||= [];
      if (!store.documents[context.documentKey].some((file) => file.mediaId === context.document.mediaId)) store.documents[context.documentKey].push(context.document);
      inFlight.delete(uploadId);
      return { status: "ADDED", count: store.documents[context.documentKey].length, state: clone(current) };
    },
    fail: async (_phone, uploadId) => { claims.delete(uploadId); inFlight.delete(uploadId); },
    advance: async (_phone, context) => {
      if (inFlight.size) return { status: "BUSY" };
      const store = context.beneficiaryIndex === null ? current.request : current.request.beneficiaries[context.beneficiaryIndex];
      const files = store.documents[context.documentKey] || [];
      if (context.requireFiles && !files.length) return { status: "EMPTY", state: clone(current) };
      store.documentIndex += 1;
      return { status: "ADVANCED", state: clone(current) };
    },
    state: () => clone(current),
  };
}

function baseState(kind = "single") {
  if (kind === "multi") return { stage: "DOCUMENTS", request: { type: "individual", multiPackage: true, data: { name: "Applicant" }, currentBeneficiaryIndex: 1, beneficiaries: [{ documents: {}, documentIndex: 0 }, { name: "Person", documents: {}, documentIndex: 0 }] } };
  return { stage: "DOCUMENTS", request: { type: kind === "military" ? "military_unit" : "individual", multiPackage: false, data: kind === "military" ? { militaryUnitNumber: "A1" } : { name: "Applicant" }, documents: {}, documentIndex: 0 } };
}

function uploadServices(control, delays = {}) {
  return {
    beginDocumentUpload: control.begin,
    completeDocumentUpload: control.complete,
    failDocumentUpload: control.fail,
    downloadWhatsAppMedia: async (fileId) => {
      if (delays[fileId]) await delays[fileId];
      return { buffer: Buffer.from(fileId), mimeType: "image/jpeg", fileSize: fileId.length, extension: ".jpg", validation: { version: 1 } };
    },
    getOrCreateApplicantFolder: async () => ({ id: "folder" }),
    getOrCreateIndividualMultiBeneficiaryFolder: async () => ({ id: "folder" }),
    nextDocumentSequence: (() => { let value = 0; return async () => ++value; })(),
    uploadBufferToDrive: async ({ name }) => ({ id: `drive-${name}`, name, webViewLink: `https://drive.test/${name}` }),
  };
}

for (const completionOrder of [["first", "second"], ["second", "first"]]) {
  test(`two concurrent uploads preserve both files when ${completionOrder[0]} finishes first`, async () => {
    const initial = baseState();
    const control = coordinator(initial);
    const releases = {};
    const delays = Object.fromEntries(completionOrder.map((id) => [id, new Promise((resolve) => { releases[id] = resolve; })]));
    const services = uploadServices(control, delays);
    const first = saveIncomingDocument("phone", clone(initial), { id: "message-1", type: "image" }, "first", { key: "passport" }, services);
    const second = saveIncomingDocument("phone", clone(initial), { id: "message-2", type: "image" }, "second", { key: "passport" }, services);
    await Promise.resolve();
    releases[completionOrder[0]](); await Promise.resolve();
    releases[completionOrder[1]]();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results.map((result) => result.status), ["added", "added"]);
    assert.deepEqual(control.state().request.documents.passport.map((file) => file.mediaId).sort(), ["first", "second"]);
    assert.equal(control.state().request.documents.passport.length, 2);
  });
}

test("document_done cannot advance while an upload is unfinished", async () => {
  const initial = baseState();
  const control = coordinator(initial);
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const upload = saveIncomingDocument("phone", clone(initial), { id: "message-1", type: "image" }, "first", { key: "passport" }, uploadServices(control, { first: pending }));
  await Promise.resolve();
  const notifications = [];
  const busy = await advanceCurrentDocument("phone", clone(initial), { key: "passport", uploadPrompt: "passport" }, true, { advanceDocumentStage: control.advance, sendText: async (_phone, text) => notifications.push(text), askDocument: async () => assert.fail("busy transition must not continue") });
  assert.equal(busy.status, "BUSY");
  assert.match(notifications[0], /триває завантаження/);
  assert.equal(control.state().request.documentIndex, 0);
  release(); await upload;
  const stateAfterUpload = control.state();
  const advanced = await advanceCurrentDocument("phone", stateAfterUpload, { key: "passport", uploadPrompt: "passport" }, true, { advanceDocumentStage: control.advance, askDocument: async () => {} });
  assert.equal(advanced.status, "ADVANCED");
  assert.equal(control.state().request.documentIndex, 1);
  assert.equal(control.state().request.documents.passport.length, 1);
});

test("a repeated webhook does not upload or append the same file twice", async () => {
  const initial = baseState();
  const control = coordinator(initial);
  let driveUploads = 0;
  const services = { ...uploadServices(control), uploadBufferToDrive: async ({ name }) => { driveUploads += 1; return { id: name, name }; } };
  const first = await saveIncomingDocument("phone", clone(initial), { id: "same-message", type: "image" }, "same-media", { key: "passport" }, services);
  const repeated = await saveIncomingDocument("phone", control.state(), { id: "same-message", type: "image" }, "same-media", { key: "passport" }, services);
  assert.equal(first.status, "added");
  assert.equal(repeated.status, "duplicate");
  assert.equal(driveUploads, 1);
  assert.equal(control.state().request.documents.passport.length, 1);
});

test("single, military and multi uploads append to the correct document collection", async () => {
  for (const [kind, key] of [["single", "passport"], ["military", "official_request"], ["multi", "passport"]]) {
    const initial = baseState(kind);
    const control = coordinator(initial);
    const result = await saveIncomingDocument("phone", clone(initial), { id: `${kind}-message`, type: "image" }, `${kind}-media`, { key }, uploadServices(control));
    const documents = kind === "multi" ? control.state().request.beneficiaries[1].documents : control.state().request.documents;
    assert.equal(result.count, 1);
    assert.equal(documents[key].length, 1);
  }
});

test("every successful photo acknowledgement includes the current file count and Done button", async () => {
  const previousPhoneId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const previousToken = process.env.WHATSAPP_ACCESS_TOKEN;
  const previousFetch = globalThis.fetch;
  const payloads = [];
  process.env.WHATSAPP_PHONE_NUMBER_ID = "test-phone";
  process.env.WHATSAPP_ACCESS_TOKEN = "test-token";
  globalThis.fetch = async (_url, options) => { payloads.push(JSON.parse(options.body)); return { ok: true, json: async () => ({ messages: [{ id: "sent" }] }) }; };
  try {
    await sendDocumentDone("phone", "📕 Паспорт", 1);
    await sendDocumentDone("phone", "📕 Паспорт", 2);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousPhoneId === undefined) delete process.env.WHATSAPP_PHONE_NUMBER_ID; else process.env.WHATSAPP_PHONE_NUMBER_ID = previousPhoneId;
    if (previousToken === undefined) delete process.env.WHATSAPP_ACCESS_TOKEN; else process.env.WHATSAPP_ACCESS_TOKEN = previousToken;
  }
  assert.equal(payloads.length, 2);
  assert.match(payloads[0].interactive.body.text, /Усього файлів цього документа: 1/);
  assert.match(payloads[1].interactive.body.text, /Усього файлів цього документа: 2/);
  assert.equal(payloads[1].interactive.action.buttons[0].reply.id, "document_done");
});
