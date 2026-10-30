import assert from "node:assert/strict";
import test from "node:test";

import {
  advanceCurrentDocument,
  documentButtonMatchesState,
  handleDocumentFileUpload,
  parseDocumentButton,
  saveIncomingDocument,
  sendDocumentStepPrompt,
} from "../api/webhook.js";
import {
  beginDocumentUpload,
  completeDocumentUpload,
  ensureDocumentActionToken,
  failDocumentUpload,
  ownsDocumentUpload,
  renewDocumentUpload,
  DOCUMENT_UPLOAD_PENDING_TTL_SECONDS,
} from "../lib/state.js";

function stateFor({ index = 0, token, multi = false, beneficiaryIndex = 0 } = {}) {
  if (multi) {
    return {
      stage: "DOCUMENTS",
      request: {
        type: "individual",
        multiPackage: true,
        data: { name: "Applicant" },
        currentBeneficiaryIndex: beneficiaryIndex,
        beneficiaries: [{ name: "Person", documentIndex: index, documentActionToken: token, documents: {} }],
      },
    };
  }
  return {
    stage: "DOCUMENTS",
    request: {
      type: "individual",
      multiPackage: false,
      data: { name: "Applicant" },
      documentIndex: index,
      documentActionToken: token,
      documents: {},
    },
  };
}

function uploadServices(overrides = {}) {
  return {
    beginDocumentUpload: async () => "STARTED",
    renewDocumentUpload: async () => true,
    ownsDocumentUpload: async () => true,
    failDocumentUpload: async () => true,
    downloadWhatsAppMedia: async () => ({ buffer: Buffer.from("file"), mimeType: "image/jpeg", fileSize: 4, extension: ".jpg", validation: { version: 1 } }),
    getOrCreateApplicantFolder: async () => ({ id: "folder" }),
    nextDocumentSequence: async () => 1,
    uploadBufferToDrive: async ({ name }) => ({ id: "drive", name, webViewLink: "https://drive.test/file" }),
    completeDocumentUpload: async (_phone, _uploadId, { document }) => ({
      status: "ADDED",
      count: 1,
      state: { ...stateFor(), request: { ...stateFor().request, documents: { passport: [document] } } },
    }),
    getUserState: async () => null,
    ownerToken: "upload-owner",
    ...overrides,
  };
}

test("definite and unknown upload failures return one current interactive prompt", async () => {
  for (const [code, expected] of [
    ["DRIVE_REJECTED", /Не вдалося зберегти файл/],
    ["DRIVE_UPLOAD_RESULT_UNKNOWN", /Не вдалося підтвердити результат/],
  ]) {
    const calls = [];
    const error = new Error("safe test error");
    error.code = code;
    const result = await handleDocumentFileUpload("phone", stateFor({ token: "aabbccddeeff" }), { id: "message", type: "image" }, "media", { key: "passport" }, {
      saveIncomingDocument: async () => { throw error; },
      sendDocumentStepPrompt: async (_phone, _state, issue) => calls.push(issue),
      sendText: async () => assert.fail("non-validation failure must use the combined prompt"),
    });
    assert.equal(result.status, "failed");
    assert.equal(calls.length, 1);
    assert.match(calls[0], expected);
  }
});

test("Redis completion failure retries registration and a later webhook reuses the same Drive marker", async () => {
  const filesByMarker = new Map();
  let creates = 0;
  let completionCalls = 0;
  const state = stateFor();
  const services = uploadServices({
    uploadBufferToDrive: async ({ name, idempotencyMarker }) => {
      if (filesByMarker.has(idempotencyMarker)) return filesByMarker.get(idempotencyMarker);
      creates += 1;
      const file = { id: `drive-${creates}`, name, webViewLink: "https://drive.test/file" };
      filesByMarker.set(idempotencyMarker, file);
      return file;
    },
    completeDocumentUpload: async (_phone, _uploadId, { document }) => {
      completionCalls += 1;
      if (completionCalls <= 2) throw new Error("Redis unavailable");
      state.request.documents.passport = [document];
      return { status: "ADDED", count: 1, state };
    },
  });

  await assert.rejects(
    saveIncomingDocument("phone", structuredClone(state), { id: "same-message", type: "image" }, "media", { key: "passport" }, services),
    { code: "DOCUMENT_UPLOAD_RESULT_UNKNOWN" },
  );
  const retried = await saveIncomingDocument("phone", structuredClone(state), { id: "same-message", type: "image" }, "media", { key: "passport" }, services);
  assert.equal(retried.status, "added");
  assert.equal(creates, 1);
  assert.equal(state.request.documents.passport.length, 1);
});

test("parallel delivery of one media message starts one Drive upload", async () => {
  let claimed = false;
  let creates = 0;
  const state = stateFor();
  const services = uploadServices({
    beginDocumentUpload: async () => {
      if (claimed) return "DUPLICATE";
      claimed = true;
      return "STARTED";
    },
    uploadBufferToDrive: async ({ name }) => {
      creates += 1;
      return { id: "drive", name };
    },
  });
  const [first, second] = await Promise.all([
    saveIncomingDocument("phone", structuredClone(state), { id: "same-message", type: "image" }, "media", { key: "passport" }, services),
    saveIncomingDocument("phone", structuredClone(state), { id: "same-message", type: "image" }, "media", { key: "passport" }, services),
  ]);
  assert.deepEqual([first.status, second.status].sort(), ["added", "duplicate"]);
  assert.equal(creates, 1);
});

test("heartbeat false prevents Drive side effects", async () => {
  let driveCreates = 0;
  const services = uploadServices({
    heartbeatIntervalMs: 1,
    renewDocumentUpload: async () => false,
    downloadWhatsAppMedia: async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return { buffer: Buffer.from("file"), mimeType: "image/jpeg", fileSize: 4, extension: ".jpg", validation: { version: 1 } };
    },
    uploadBufferToDrive: async () => { driveCreates += 1; },
  });
  await assert.rejects(
    saveIncomingDocument("phone", stateFor(), { id: "message", type: "image" }, "media", { key: "passport" }, services),
    { code: "DOCUMENT_UPLOAD_LEASE_LOST" },
  );
  assert.equal(driveCreates, 0);
});

test("expired ownership before create prevents Drive side effects", async () => {
  let driveCreates = 0;
  const services = uploadServices({
    ownsDocumentUpload: async () => false,
    uploadBufferToDrive: async () => { driveCreates += 1; },
  });
  await assert.rejects(
    saveIncomingDocument("phone", stateFor(), { id: "message", type: "image" }, "media", { key: "passport" }, services),
    { code: "DOCUMENT_UPLOAD_LEASE_LOST" },
  );
  assert.equal(driveCreates, 0);
});

test("ownership lost during Drive await prevents Redis completion", async () => {
  let ownershipChecks = 0;
  let completionCalls = 0;
  const services = uploadServices({
    ownsDocumentUpload: async () => {
      ownershipChecks += 1;
      return ownershipChecks < 4;
    },
    completeDocumentUpload: async () => { completionCalls += 1; },
  });
  await assert.rejects(
    saveIncomingDocument("phone", stateFor(), { id: "message", type: "image" }, "media", { key: "passport" }, services),
    { code: "DOCUMENT_UPLOAD_LEASE_LOST" },
  );
  assert.equal(completionCalls, 0);
});

test("document action token is stable for repeated prompts and stored atomically when absent", async () => {
  const state = stateFor();
  let ensureCalls = 0;
  const sent = [];
  const services = {
    ensureDocumentActionToken: async (_phone, context) => {
      ensureCalls += 1;
      const next = structuredClone(state);
      next.request.documentActionToken = "aabbccddeeff";
      return { status: "READY", token: "aabbccddeeff", state: next, proposedToken: context.proposedToken };
    },
    sendDocumentPrompt: async (_phone, _body, _skip, context) => sent.push(context),
  };
  await sendDocumentStepPrompt("phone", state, null, services);
  await sendDocumentStepPrompt("phone", state, null, services);
  assert.equal(ensureCalls, 1);
  assert.deepEqual(sent.map(({ token }) => token), ["aabbccddeeff", "aabbccddeeff"]);
});

test("a legacy successful upload creates one stable prompt for concurrent deliveries", async () => {
  const state = stateFor();
  let tokenCreated = false;
  let uploadCalls = 0;
  const sent = [];
  const showPrompt = (phone, current, issue, options) => sendDocumentStepPrompt(phone, current, issue, {
    ...options,
    ensureDocumentActionToken: async () => {
      const next = structuredClone(state);
      next.request.documentActionToken = "aabbccddeeff";
      if (!tokenCreated) {
        tokenCreated = true;
        return { status: "CREATED", token: "aabbccddeeff", state: next };
      }
      return { status: "READY", token: "aabbccddeeff", state: next };
    },
    sendDocumentPrompt: async (_phone, body, allowSkip, context) => sent.push({ body, allowSkip, context }),
  });
  const services = {
    saveIncomingDocument: async () => ({ status: uploadCalls++ === 0 ? "added" : "duplicate", count: 1 }),
    sendDocumentStepPrompt: showPrompt,
  };
  await Promise.all([
    handleDocumentFileUpload("phone", structuredClone(state), { id: "one", type: "image" }, "media-one", { key: "passport" }, services),
    handleDocumentFileUpload("phone", structuredClone(state), { id: "two", type: "image" }, "media-two", { key: "passport" }, services),
  ]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].allowSkip, false);
  assert.equal(sent[0].context.token, "aabbccddeeff");
});

test("a legacy optional upload restores both Done and Skip actions", async () => {
  const state = stateFor({ index: 3 });
  const sent = [];
  await handleDocumentFileUpload("phone", state, { id: "ubd", type: "image" }, "media-ubd", { key: "ubd", optional: true, uploadPrompt: "UBD" }, {
    saveIncomingDocument: async () => ({ status: "added", count: 1 }),
    sendDocumentStepPrompt: (phone, current, issue, options) => sendDocumentStepPrompt(phone, current, issue, {
      ...options,
      ensureDocumentActionToken: async () => {
        const next = structuredClone(state);
        next.request.documentActionToken = "112233aabbcc";
        return { status: "CREATED", token: "112233aabbcc", state: next };
      },
      sendDocumentPrompt: async (_phone, _body, allowSkip, context) => sent.push({ allowSkip, context }),
    }),
  });
  assert.deepEqual(sent, [{ allowSkip: true, context: { token: "112233aabbcc", beneficiaryIndex: null, documentKey: "ubd" } }]);
});

test("legacy military and multi uploads restore prompts for their exact document context", async () => {
  const military = stateFor();
  military.request.type = "military_unit";
  const multi = stateFor({ multi: true });
  for (const { state, doc, expectedBeneficiary } of [
    { state: military, doc: { key: "official_request", uploadPrompt: "Letter" }, expectedBeneficiary: null },
    { state: multi, doc: { key: "passport", uploadPrompt: "Passport" }, expectedBeneficiary: 0 },
  ]) {
    const sent = [];
    await handleDocumentFileUpload("phone", state, { id: doc.key, type: "image" }, `media-${doc.key}`, doc, {
      saveIncomingDocument: async () => ({ status: "added", count: 1 }),
      sendDocumentStepPrompt: (phone, current, issue, options) => sendDocumentStepPrompt(phone, current, issue, {
        ...options,
        ensureDocumentActionToken: async (_phone, context) => {
          const next = structuredClone(state);
          const store = context.beneficiaryIndex === null ? next.request : next.request.beneficiaries[context.beneficiaryIndex];
          store.documentActionToken = "abcdef123456";
          return { status: "CREATED", token: "abcdef123456", state: next };
        },
        sendDocumentPrompt: async (_phone, _body, _allowSkip, context) => sent.push(context),
      }),
    });
    assert.deepEqual(sent, [{ token: "abcdef123456", beneficiaryIndex: expectedBeneficiary, documentKey: doc.key }]);
  }
});

test("pending settlement blocks Done after lease expiry while Drive create finishes", async () => {
  const state = stateFor({ token: "aabbccddeeff" });
  let releaseDrive;
  let signalDriveStarted;
  let expired = false;
  let pending = true;
  const driveStarted = new Promise((resolve) => { signalDriveStarted = resolve; });
  const driveResult = new Promise((resolve) => { releaseDrive = resolve; });
  const prompts = [];
  const upload = handleDocumentFileUpload("phone", state, { id: "message", type: "image" }, "media", { key: "passport" }, {
    uploadServices: uploadServices({
      ownsDocumentUpload: async () => !expired,
      failDocumentUpload: async () => false,
      uploadBufferToDrive: async ({ name }) => {
        signalDriveStarted();
        await driveResult;
        return { id: "drive", name };
      },
    }),
    sendDocumentStepPrompt: async (_phone, _state, issue) => prompts.push(issue),
  });
  await driveStarted;
  expired = true;
  const busy = await advanceCurrentDocument("phone", state, { key: "passport" }, true, {
    advanceDocumentStage: async () => pending ? { status: "BUSY" } : { status: "EMPTY", state },
    sendDocumentStepPrompt: async (_phone, _state, issue) => prompts.push(issue),
    askDocument: async () => assert.fail("expired in-flight upload must not advance"),
  });
  assert.equal(busy.status, "BUSY");
  assert.equal(state.request.documentIndex, 0);
  releaseDrive();
  const result = await upload;
  assert.equal(result.status, "failed");
  assert.equal(state.request.documentIndex, 0);
  assert.equal(state.request.documents.passport, undefined);
  assert.match(prompts.at(-1), /не вдалося підтвердити результат/i);
  pending = false;
});

test("current, stale, legacy and multi document buttons are fenced by state context", () => {
  const current = stateFor({ token: "aabbccddeeff" });
  assert.equal(documentButtonMatchesState(current, parseDocumentButton("document_done_taabbccddeeff_passport")), true);
  assert.equal(documentButtonMatchesState(current, parseDocumentButton("document_done_t112233445566_passport")), false);
  assert.equal(documentButtonMatchesState(current, parseDocumentButton("document_done_taabbccddeeff_rnokpp")), false);
  assert.equal(documentButtonMatchesState(current, parseDocumentButton("document_done")), false);

  const legacy = stateFor();
  assert.equal(documentButtonMatchesState(legacy, parseDocumentButton("document_done")), true);

  const multi = stateFor({ token: "aabbccddeeff", multi: true });
  assert.equal(documentButtonMatchesState(multi, parseDocumentButton("document_done_taabbccddeeff_0_passport")), true);
  assert.equal(documentButtonMatchesState(multi, parseDocumentButton("document_done_taabbccddeeff_1_passport")), false);
  assert.equal(documentButtonMatchesState(multi, parseDocumentButton("document_done_0_passport")), false);
  const legacyMulti = stateFor({ multi: true });
  assert.equal(documentButtonMatchesState(legacyMulti, parseDocumentButton("document_done_0_passport")), true);
});

test("an old token cannot advance the next document or execute twice", () => {
  const firstStep = stateFor({ token: "aabbccddeeff" });
  const callback = parseDocumentButton("document_done_taabbccddeeff_passport");
  assert.equal(documentButtonMatchesState(firstStep, callback), true);
  const nextStep = stateFor({ index: 1, token: "112233445566" });
  assert.equal(documentButtonMatchesState(nextStep, callback), false);
  assert.equal(documentButtonMatchesState(nextStep, parseDocumentButton("document_done_t112233445566_rnokpp")), true);
});

test("a button from a previous application cannot affect a new application", () => {
  const previousApplicationButton = parseDocumentButton("document_skip_taabbccddeeff_ubd");
  const newApplication = stateFor({ index: 3, token: "112233445566" });
  assert.equal(documentButtonMatchesState(newApplication, previousApplicationButton), false);
  assert.equal(documentButtonMatchesState(newApplication, parseDocumentButton("document_skip_t112233445566_ubd")), true);
});

test("Redis document upload helpers pass the same owner token through every lease operation", async () => {
  const calls = [];
  const redis = {
    eval: async (_script, options) => {
      calls.push(options);
      if (options.arguments.length === 12) return JSON.stringify({ status: "ADDED", count: 1, state: stateFor() });
      return 1;
    },
  };
  const context = { documentIndex: 0, beneficiaryIndex: null, documentKey: "passport" };
  await beginDocumentUpload("phone", "message", context, "owner-token", { redis });
  await renewDocumentUpload("phone", "message", "owner-token", { redis });
  await ownsDocumentUpload("phone", "message", "owner-token", { redis });
  await completeDocumentUpload("phone", "message", { ...context, document: { mediaId: "media" } }, "owner-token", { redis });
  await failDocumentUpload("phone", "message", "owner-token", { redis });

  assert.equal(calls[0].arguments.at(-1), "owner-token");
  assert.equal(calls[1].arguments.at(-1), "owner-token");
  assert.equal(calls[2].arguments.at(-1), "owner-token");
  assert.equal(calls[3].arguments.at(-1), "owner-token");
  assert.equal(calls[4].arguments.at(-1), "owner-token");
  assert.equal(Number(calls[0].arguments.at(-2)), DOCUMENT_UPLOAD_PENDING_TTL_SECONDS);
  assert.equal(Number(calls[1].arguments.at(-2)), DOCUMENT_UPLOAD_PENDING_TTL_SECONDS);
});

test("document action token helper requests one atomic Redis state update", async () => {
  const calls = [];
  const redis = {
    eval: async (_script, options) => {
      calls.push(options);
      return JSON.stringify({ status: "READY", token: "aabbccddeeff", state: stateFor({ token: "aabbccddeeff" }) });
    },
  };
  const result = await ensureDocumentActionToken("phone", {
    documentIndex: 0,
    beneficiaryIndex: null,
    documentKey: "passport",
    proposedToken: "aabbccddeeff",
  }, { redis });
  assert.equal(result.token, "aabbccddeeff");
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].arguments.slice(0, 4), ["0", "", "passport", "aabbccddeeff"]);
});
