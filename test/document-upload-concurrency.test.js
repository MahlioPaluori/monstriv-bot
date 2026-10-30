import assert from "node:assert/strict";
import test from "node:test";

import { advanceCurrentDocument, handleDocumentFileUpload, saveIncomingDocument } from "../api/webhook.js";

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
      if (store.documentIndex !== context.documentIndex) return { status: "STALE", state: clone(current) };
      const files = store.documents[context.documentKey] || [];
      if (context.requireFiles && !files.length) return { status: "EMPTY", state: clone(current) };
      delete store.documentActionToken;
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
    renewDocumentUpload: async () => true,
    ownsDocumentUpload: async () => true,
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
  const busy = await advanceCurrentDocument("phone", clone(initial), { key: "passport", uploadPrompt: "passport" }, true, { advanceDocumentStage: control.advance, sendDocumentStepPrompt: async (_phone, _state, issue) => notifications.push(issue), askDocument: async () => assert.fail("busy transition must not continue") });
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

test("two Done callbacks advance a document step only once", async () => {
  const initial = baseState();
  initial.request.documents.passport = [{ mediaId: "saved" }];
  initial.request.documentActionToken = "aabbccddeeff";
  const control = coordinator(initial);
  const continuations = [];
  const services = {
    advanceDocumentStage: control.advance,
    askDocument: async (_phone, state) => continuations.push(state.request.documentIndex),
  };
  const [first, second] = await Promise.all([
    advanceCurrentDocument("phone", clone(initial), { key: "passport" }, true, services),
    advanceCurrentDocument("phone", clone(initial), { key: "passport" }, true, services),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["ADVANCED", "STALE"]);
  assert.equal(control.state().request.documentIndex, 1);
  assert.equal(continuations.length, 1);
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

test("one or several successful files are stored without per-file WhatsApp acknowledgements", async () => {
  const uploads = [];
  const outbound = [];
  const services = {
    saveIncomingDocument: async (_phone, _state, message) => {
      uploads.push(message.id);
      return { status: "added", count: uploads.length };
    },
    sendText: async (_phone, text) => outbound.push(text),
  };

  const state = baseState();
  state.request.documentActionToken = "aabbccddeeff";
  assert.equal((await handleDocumentFileUpload("phone", state, { id: "one", type: "image" }, "media-one", { key: "passport" }, services)).status, "added");
  assert.equal((await handleDocumentFileUpload("phone", state, { id: "two", type: "document" }, "media-two", { key: "passport" }, services)).status, "added");
  assert.deepEqual(uploads, ["one", "two"]);
  assert.deepEqual(outbound, []);
});

test("a Google Drive failure leaves the document stage and collection unchanged", async () => {
  const initial = baseState();
  const control = coordinator(initial);
  const services = {
    ...uploadServices(control),
    uploadBufferToDrive: async () => { throw new Error("mock Drive failure"); },
  };

  await assert.rejects(
    saveIncomingDocument("phone", clone(initial), { id: "failed-message", type: "image" }, "failed-media", { key: "passport" }, services),
    /mock Drive failure/,
  );
  assert.equal(control.state().stage, "DOCUMENTS");
  assert.deepEqual(control.state().request.documents, {});
});
