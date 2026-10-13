import assert from "node:assert/strict";
import test from "node:test";

import {
  acquireConfirmationClaim,
  buildApplicantProfile,
  createApplicationNumber,
  getKyivApplicationPeriod,
  ownsConfirmationClaim,
  releaseConfirmationClaim,
  renewConfirmationClaim,
} from "../lib/state.js";
import { createCanonicalApplicantDocumentCopies, materializeReusedApplicantDocument } from "../lib/google-drive.js";
import { confirmRequest, repeatCurrentPrompt, runClaimedConfirmation } from "../api/webhook.js";
import { buildRequestCardUrl } from "../api/request-card.js";

class FakeRedis {
  constructor() { this.values = new Map(); }
  async set(key, value, options = {}) {
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }
  async eval(script, { keys, arguments: args }) {
    const [key] = keys;
    if (script.includes("local recorded")) {
      const current = Number(this.values.get(key) || 0);
      const recorded = Number(args[0]);
      const next = Math.max(current, recorded) + 1;
      if (next > Number(args[1])) return -1;
      this.values.set(key, String(next));
      return next;
    }
    if (this.values.get(key) !== args[0]) return 0;
    if (script.includes('redis.call("DEL"')) this.values.delete(key);
    return 1;
  }
}

test("Kyiv application period follows the local month across UTC boundaries", () => {
  assert.equal(getKyivApplicationPeriod(new Date("2026-09-30T20:59:59.000Z")), "2026-09");
  assert.equal(getKyivApplicationPeriod(new Date("2026-09-30T21:00:00.000Z")), "2026-10");
  assert.equal(getKyivApplicationPeriod(new Date("2026-12-31T22:00:00.000Z")), "2027-01");
});

test("monthly application allocation starts at one and is isolated by Kyiv period", async () => {
  const redis = new FakeRedis();
  assert.equal(await createApplicationNumber("2026-10", 0, { redis }), "2026-10-0001");
  assert.equal(await createApplicationNumber("2026-10", 0, { redis }), "2026-10-0002");
  assert.equal(await createApplicationNumber("2026-11", 0, { redis }), "2026-11-0001");
});

test("monthly allocation recovers above Sheets maximum after Redis counter loss", async () => {
  const redis = new FakeRedis();
  assert.equal(await createApplicationNumber("2026-10", 17, { redis }), "2026-10-0018");
  redis.values.clear();
  assert.equal(await createApplicationNumber("2026-10", 18, { redis }), "2026-10-0019");
});

test("concurrent monthly allocations are unique and overflow is explicit", async () => {
  const redis = new FakeRedis();
  const allocated = await Promise.all([
    createApplicationNumber("2026-10", 20, { redis }),
    createApplicationNumber("2026-10", 20, { redis }),
  ]);
  assert.deepEqual(new Set(allocated), new Set(["2026-10-0021", "2026-10-0022"]));
  await assert.rejects(createApplicationNumber("2026-10", 9999, { redis }), /limit reached/);
});

test("request-card signing accepts the new format and rejects the legacy format", () => {
  const previous = process.env.REQUEST_CARD_SIGNING_SECRET;
  process.env.REQUEST_CARD_SIGNING_SECRET = "local-test-secret";
  try {
    const url = new URL(buildRequestCardUrl("2026-10-0001", "https://example.test"));
    assert.equal(url.searchParams.get("id"), "2026-10-0001");
    assert.match(url.searchParams.get("sig"), /^[a-f0-9]{64}$/);
    assert.throws(() => buildRequestCardUrl("2026-000001", "https://example.test"), /Invalid application ID/);
  } finally {
    if (previous === undefined) delete process.env.REQUEST_CARD_SIGNING_SECRET;
    else process.env.REQUEST_CARD_SIGNING_SECRET = previous;
  }
});

test("confirmation claim serializes concurrent callbacks and only its owner can release it", async () => {
  const redis = new FakeRedis();
  const [first, second] = await Promise.all([
    acquireConfirmationClaim("380000000001", "owner-a", { redis, ttlSeconds: 2 }),
    acquireConfirmationClaim("380000000001", "owner-b", { redis, ttlSeconds: 2 }),
  ]);
  assert.equal(Number(first) + Number(second), 1);
  const owner = first ? "owner-a" : "owner-b";
  const other = first ? "owner-b" : "owner-a";
  assert.equal(await ownsConfirmationClaim("380000000001", owner, { redis }), true);
  assert.equal(await renewConfirmationClaim("380000000001", owner, { redis, ttlSeconds: 2 }), true);
  assert.equal(await releaseConfirmationClaim("380000000001", other, { redis }), false);
  assert.equal(await releaseConfirmationClaim("380000000001", owner, { redis }), true);
  assert.equal(await acquireConfirmationClaim("380000000001", other, { redis, ttlSeconds: 2 }), true);
});

test("expired confirmation claim can be recovered by a new owner", async () => {
  const redis = new FakeRedis();
  assert.equal(await acquireConfirmationClaim("380000000002", "owner-a", { redis, ttlSeconds: 1 }), true);
  redis.values.clear(); // Simulates Redis expiry after a crashed handler.
  assert.equal(await renewConfirmationClaim("380000000002", "owner-a", { redis, ttlSeconds: 1 }), false);
  assert.equal(await acquireConfirmationClaim("380000000002", "owner-b", { redis, ttlSeconds: 1 }), true);
  assert.equal(await releaseConfirmationClaim("380000000002", "owner-a", { redis }), false);
});

function confirmationHarness(state) {
  let owner = null;
  return {
    acquireClaim: async (_phone, token) => {
      if (owner) return false;
      owner = token;
      return true;
    },
    renewClaim: async (_phone, token) => owner === token,
    checkClaim: async (_phone, token) => owner === token,
    releaseClaim: async (_phone, token) => {
      if (owner !== token) return false;
      owner = null;
      return true;
    },
    loadState: async () => state,
    loseClaim: () => { owner = null; },
  };
}

test("two concurrent confirmation callbacks execute the protected work once", async () => {
  const state = { stage: "CONFIRMATION", request: {} };
  const harness = confirmationHarness(state);
  let executions = 0;
  let releaseWork;
  const workGate = new Promise((resolve) => { releaseWork = resolve; });
  const performConfirmation = async (_phone, _state, assertOwnership) => {
    executions += 1;
    await assertOwnership();
    await workGate;
  };
  const first = runClaimedConfirmation("380000000004", { ...harness, performConfirmation, ownerToken: "owner-a" });
  const second = await runClaimedConfirmation("380000000004", { ...harness, performConfirmation, ownerToken: "owner-b" });
  assert.deepEqual(second, { busy: true });
  releaseWork();
  assert.deepEqual(await first, { completed: true });
  assert.equal(executions, 1);
});

test("retry after application ID persistence reuses state, and completed callbacks are stale", async () => {
  const state = { stage: "CONFIRMATION", request: {} };
  const harness = confirmationHarness(state);
  let attempts = 0;
  const performConfirmation = async (_phone, current) => {
    attempts += 1;
    current.request.applicationId ||= "2026-10-0009";
    if (attempts === 1) throw new Error("simulated failure after application ID");
    current.stage = "MAIN_MENU";
  };
  assert.deepEqual(await runClaimedConfirmation("380000000005", { ...harness, performConfirmation, handleFailure: async () => ({ failed: true }), ownerToken: "owner-a" }), { failed: true });
  assert.equal(state.request.applicationId, "2026-10-0009");
  assert.deepEqual(await runClaimedConfirmation("380000000005", { ...harness, performConfirmation, ownerToken: "owner-b" }), { completed: true });
  assert.equal(attempts, 2);
  assert.deepEqual(await runClaimedConfirmation("380000000005", { ...harness, performConfirmation, ownerToken: "owner-c" }), { stale: true });
  assert.equal(attempts, 2);
});

test("lost confirmation lease aborts work at the next ownership fence", async () => {
  const state = { stage: "CONFIRMATION", request: {} };
  const harness = confirmationHarness(state);
  const performConfirmation = async (_phone, _state, assertOwnership) => {
    harness.loseClaim();
    await assertOwnership();
  };
  assert.deepEqual(await runClaimedConfirmation("380000000006", { ...harness, performConfirmation, ownerToken: "owner-a" }), { claimLost: true });
});

test("heartbeat renews while work runs and is stopped before the claimed operation returns", async () => {
  const state = { stage: "CONFIRMATION", request: {} };
  const harness = confirmationHarness(state);
  let renewals = 0;
  const renewClaim = async (...args) => {
    renewals += 1;
    return harness.renewClaim(...args);
  };
  const result = await runClaimedConfirmation("380000000007", {
    ...harness,
    renewClaim,
    heartbeatMs: 5,
    ownerToken: "owner-a",
    performConfirmation: async () => new Promise((resolve) => setTimeout(resolve, 22)),
  });
  assert.deepEqual(result, { completed: true });
  const renewalsAtReturn = renewals;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(renewalsAtReturn >= 2);
  assert.equal(renewals, renewalsAtReturn);
});

function driveMock(initialFiles = []) {
  let files = initialFiles.map((file) => ({ ...file }));
  let copies = 0;
  return {
    get copies() { return copies; },
    files: {
      list: async () => ({ data: { files } }),
      get: async ({ fileId }) => ({ data: { id: fileId, name: "passport.jpg", mimeType: "image/jpeg", trashed: false } }),
      copy: async ({ requestBody }) => {
        copies += 1;
        const created = {
          id: `copy-${copies}`,
          name: requestBody.name,
          parents: requestBody.parents,
          mimeType: "image/jpeg",
          webViewLink: `https://drive.test/copy-${copies}`,
          trashed: false,
          appProperties: requestBody.appProperties,
        };
        files = [created];
        return { data: created };
      },
      update: async ({ fileId, addParents, requestBody }) => {
        const current = files.find((file) => file.id === fileId);
        const updated = { ...current, ...requestBody, parents: addParents ? [addParents] : current.parents };
        files = files.map((file) => file.id === fileId ? updated : file);
        return { data: updated };
      },
    },
  };
}

const reusedDocument = {
  fileName: "passport.jpg",
  sourceDriveFileId: "canonical-source",
  sourceDriveUrl: "https://drive.test/canonical-source",
  driveFileId: null,
  driveUrl: null,
  reusedFromApplicantProfile: true,
};

test("partial Drive-copy retry reuses the marked copy and never mutates its source", async () => {
  const drive = driveMock();
  const args = {
    drive,
    applicationId: "2026-10-0001",
    beneficiaryIndex: 0,
    documentKey: "passport",
    fileIndex: 0,
    beneficiaryFolder: { id: "beneficiary-folder" },
    document: reusedDocument,
  };
  const first = await materializeReusedApplicantDocument(args);
  const second = await materializeReusedApplicantDocument(args);
  assert.equal(drive.copies, 1);
  assert.equal(first.driveFileId, second.driveFileId);
  assert.equal(reusedDocument.driveFileId, null);
  assert.equal(reusedDocument.sourceDriveFileId, "canonical-source");
});

test("multiple valid Drive copies select the lowest file ID without creating or deleting files", async () => {
  const marker = "2026-10-0001:person1:passport:1:canonical-source";
  const common = {
    name: "2026-10-0001_person1_passport1.jpg",
    parents: ["beneficiary-folder"],
    mimeType: "image/jpeg",
    trashed: false,
    appProperties: { monstrivReusedDocument: marker },
  };
  const drive = driveMock([
    { ...common, id: "copy-z", webViewLink: "https://drive.test/copy-z" },
    { ...common, id: "copy-a", webViewLink: "https://drive.test/copy-a" },
  ]);
  const result = await materializeReusedApplicantDocument({
    drive,
    applicationId: "2026-10-0001",
    beneficiaryIndex: 0,
    documentKey: "passport",
    fileIndex: 0,
    beneficiaryFolder: { id: "beneficiary-folder" },
    document: reusedDocument,
  });
  assert.equal(result.driveFileId, "copy-a");
  assert.equal(drive.copies, 0);
});

test("canonical applicant copies are stable across retry and leave application files unchanged", async () => {
  const drive = driveMock();
  const source = { driveFileId: "application-file", fileName: "2026-10-0010_person1_passport1.jpg", driveUrl: "https://drive.test/application-file" };
  const args = {
    applicantName: "Applicant",
    applicationId: "2026-10-0010",
    documents: { passport: [source] },
    drive,
    profileFolder: { id: "profile-folder" },
  };
  const first = await createCanonicalApplicantDocumentCopies(args);
  const second = await createCanonicalApplicantDocumentCopies(args);
  assert.equal(drive.copies, 1);
  assert.equal(first.passport[0].driveFileId, second.passport[0].driveFileId);
  assert.notEqual(first.passport[0].driveFileId, source.driveFileId);
  assert.equal(source.driveFileId, "application-file");
});

test("lease loss during Drive copy prevents metadata mutation and further Drive side effects", async () => {
  let ownsLease = true;
  let updates = 0;
  const marker = "2026-10-0011:person1:passport:1:canonical-source";
  const drive = {
    files: {
      list: async () => ({ data: { files: [] } }),
      get: async ({ fileId }) => ({ data: { id: fileId, name: "passport.jpg", mimeType: "image/jpeg", trashed: false } }),
      copy: async ({ requestBody }) => {
        ownsLease = false;
        return { data: { id: "orphan-copy", name: requestBody.name, parents: requestBody.parents, appProperties: { monstrivReusedDocument: marker }, trashed: false } };
      },
      update: async () => { updates += 1; throw new Error("must not update after lease loss"); },
    },
  };
  await assert.rejects(materializeReusedApplicantDocument({
    drive,
    applicationId: "2026-10-0011",
    beneficiaryIndex: 0,
    documentKey: "passport",
    fileIndex: 0,
    beneficiaryFolder: { id: "beneficiary-folder" },
    document: reusedDocument,
    assertOwnership: async () => {
      if (!ownsLease) {
        const error = new Error("Confirmation claim was lost");
        error.code = "CONFIRMATION_CLAIM_LOST";
        throw error;
      }
    },
  }), /claim was lost/);
  assert.equal(updates, 0);
  assert.equal(reusedDocument.driveFileId, null);
});

function multiConfirmationState() {
  return {
    stage: "CONFIRMATION",
    request: {
      type: "individual",
      multiPackage: true,
      refreshApplicantProfileDocuments: true,
      data: { name: "Applicant", phone: "380000000008" },
      beneficiaries: [
        { name: "Applicant", phone: "380000000008", isApplicant: true, documents: { passport: [{ driveFileId: "app-passport", fileName: "passport.jpg" }] } },
        { name: "Other", phone: "380000000009", documents: { passport: [{ driveFileId: "other-passport", fileName: "passport.jpg" }] } },
      ],
      beneficiaryCount: 2,
    },
  };
}

function confirmationServices(overrides = {}) {
  return {
    nextApplicationId: async () => "2026-10-0012",
    persistState: async () => {},
    finalizeMultiDocuments: async ({ beneficiaries, assertOwnership }) => { await assertOwnership(); return beneficiaries; },
    appendMultiRequest: async () => {},
    createCanonicalCopies: async () => ({ passport: [{ driveFileId: "canonical-passport" }] }),
    persistApplicantProfile: async () => {},
    sendAccepted: async () => {},
    clearState: async () => {},
    ...overrides,
  };
}

test("Sheets success followed by canonical failure reports partial success and retry does not append twice", async () => {
  const state = multiConfirmationState();
  const harness = confirmationHarness(state);
  let appends = 0;
  let canonicalAttempts = 0;
  let accepted = 0;
  const messages = [];
  const services = confirmationServices({
    appendMultiRequest: async () => { appends += 1; },
    createCanonicalCopies: async () => {
      canonicalAttempts += 1;
      if (canonicalAttempts === 1) throw new Error("canonical copy failed");
      return { passport: [{ driveFileId: "canonical-passport" }] };
    },
    sendAccepted: async () => { accepted += 1; },
    clearState: async () => { state.stage = "MAIN_MENU"; },
  });
  const failureServices = {
    lookupRequest: async () => ({ result: "found" }),
    sendFailureText: async (_phone, message) => { messages.push(message); },
    persistState: async () => {},
  };
  const first = await runClaimedConfirmation("380000000008", {
    ...harness,
    ownerToken: "owner-a",
    confirmationServices: services,
    failureServices,
  });
  assert.deepEqual(first, { failed: true, sheetsRecorded: true });
  assert.equal(state.request.sheetsRecorded, true);
  assert.match(messages[0], /вже зареєстровано/);

  const second = await runClaimedConfirmation("380000000008", {
    ...harness,
    ownerToken: "owner-b",
    confirmationServices: services,
    failureServices,
  });
  assert.deepEqual(second, { completed: true });
  assert.equal(appends, 1);
  assert.equal(accepted, 1);
});

test("Redis save failure immediately after Sheets append is reconciled from Sheets before retry", async () => {
  const state = multiConfirmationState();
  const harness = confirmationHarness(state);
  let appends = 0;
  let failPostAppendSave = true;
  let reconciliations = 0;
  const services = confirmationServices({
    appendMultiRequest: async () => { appends += 1; },
    persistState: async (_phone, current) => {
      if (current.request.sheetsRecorded === true && failPostAppendSave) {
        failPostAppendSave = false;
        throw new Error("Redis unavailable after append");
      }
    },
    clearState: async () => { state.stage = "MAIN_MENU"; },
  });
  const failureServices = {
    lookupRequest: async () => ({ result: "found" }),
    sendFailureText: async () => {},
    persistState: async () => { reconciliations += 1; },
  };
  assert.deepEqual(await runClaimedConfirmation("380000000008", {
    ...harness, ownerToken: "owner-a", confirmationServices: services, failureServices,
  }), { failed: true, sheetsRecorded: true });
  assert.equal(state.request.sheetsRecorded, true);
  assert.equal(reconciliations, 1);
  assert.deepEqual(await runClaimedConfirmation("380000000008", {
    ...harness, ownerToken: "owner-b", confirmationServices: services, failureServices,
  }), { completed: true });
  assert.equal(appends, 1);
});

test("lease loss during Sheets append prevents profile, WhatsApp and reset side effects", async () => {
  const state = multiConfirmationState();
  let ownsLease = true;
  const effects = [];
  const assertOwnership = async () => {
    if (!ownsLease) {
      const error = new Error("Confirmation claim was lost");
      error.code = "CONFIRMATION_CLAIM_LOST";
      throw error;
    }
  };
  await assert.rejects(confirmRequest("380000000008", state, assertOwnership, confirmationServices({
    appendMultiRequest: async () => { effects.push("sheets"); ownsLease = false; },
    createCanonicalCopies: async () => { effects.push("canonical"); return {}; },
    persistApplicantProfile: async () => { effects.push("profile"); },
    sendAccepted: async () => { effects.push("whatsapp"); },
    clearState: async () => { effects.push("reset"); },
  })), /claim was lost/);
  assert.deepEqual(effects, ["sheets"]);
});

test("new multi decision stages repeat their production prompt for ordinary text", async () => {
  const calls = [];
  await repeatCurrentPrompt("phone", { stage: "MULTI_APPLICANT_INCLUDED", request: {} }, {
    sendMultiApplicantIncludedMenu: async () => { calls.push("included"); },
  });
  await repeatCurrentPrompt("phone", { stage: "MULTI_SAVED_DOCUMENTS_DECISION", request: {} }, {
    sendMultiSavedDocumentsMenu: async () => { calls.push("saved-documents"); },
  });
  assert.deepEqual(calls, ["included", "saved-documents"]);
});

test("individual single confirmation keeps its Sheets-profile-success-reset order", async () => {
  const state = { stage: "CONFIRMATION", request: { type: "individual", multiPackage: false, data: { name: "Applicant" }, documents: {} } };
  const effects = [];
  await confirmRequest("phone", state, async () => {}, {
    nextApplicationId: async () => "2026-10-0013",
    persistState: async () => {},
    appendRequest: async () => { effects.push("sheets"); },
    persistApplicantProfile: async () => { effects.push("profile"); },
    sendAccepted: async () => { effects.push("whatsapp"); },
    clearState: async () => { effects.push("reset"); },
  });
  assert.deepEqual(effects, ["sheets", "profile", "whatsapp", "reset"]);
});

test("confirmation keeps its allocated Kyiv month when work crosses into a new month", async () => {
  const redis = new FakeRedis();
  const state = { stage: "CONFIRMATION", request: { type: "individual", multiPackage: false, data: { name: "Applicant" }, documents: {} } };
  let currentTime = new Date("2026-10-31T21:59:59.000Z");
  let recordedId;
  await confirmRequest("phone", state, async () => {}, {
    nextApplicationId: async () => {
      const period = getKyivApplicationPeriod(currentTime);
      const applicationId = await createApplicationNumber(period, 0, { redis });
      currentTime = new Date("2026-10-31T22:00:01.000Z");
      return applicationId;
    },
    persistState: async () => {},
    appendRequest: async (_request, applicationId) => { recordedId = applicationId; },
    persistApplicantProfile: async () => {},
    sendAccepted: async () => {},
    clearState: async () => {},
  });
  assert.equal(getKyivApplicationPeriod(currentTime), "2026-11");
  assert.equal(recordedId, "2026-10-0001");
  assert.equal(state.request.applicationId, "2026-10-0001");
});

test("ordinary multi and multi_saved_use do not create new canonical profile copies", async () => {
  const state = multiConfirmationState();
  state.request.refreshApplicantProfileDocuments = false;
  const effects = [];
  await confirmRequest("phone", state, async () => {}, confirmationServices({
    appendMultiRequest: async () => { effects.push("sheets"); },
    createCanonicalCopies: async () => { effects.push("canonical"); return {}; },
    persistApplicantProfile: async () => { effects.push("profile"); },
    sendAccepted: async () => { effects.push("whatsapp"); },
    clearState: async () => { effects.push("reset"); },
  }));
  assert.deepEqual(effects, ["sheets", "profile", "whatsapp", "reset"]);
});

test("military confirmation retains Sheets-Drive-links-profile-success-reset order", async () => {
  const state = {
    stage: "CONFIRMATION",
    request: {
      type: "military_unit",
      multiPackage: false,
      data: { name: "Contact", militaryUnitNumber: "A123" },
      documents: { official_request: [{ driveFileId: "official" }] },
    },
  };
  const effects = [];
  await confirmRequest("phone", state, async () => {}, {
    nextApplicationId: async () => "2026-10-0014",
    persistState: async () => {},
    appendRequest: async () => { effects.push("sheets"); },
    finalizeMilitaryDocuments: async ({ documents }) => { effects.push("drive"); return documents; },
    updateMilitaryLinks: async () => { effects.push("links"); },
    persistMilitaryProfile: async () => { effects.push("profile"); },
    sendAccepted: async () => { effects.push("whatsapp"); },
    clearState: async () => { effects.push("reset"); },
  });
  assert.deepEqual(effects, ["sheets", "drive", "links", "profile", "whatsapp", "reset"]);
});

test("multi_saved_replace refreshes canonical profile documents, multi_saved_use does not", () => {
  const previous = {
    phone: "380000000003",
    data: { name: "Old" },
    documents: { passport: [{ driveFileId: "old" }] },
    lastDocumentsUpdatedAt: "2024-01-01T00:00:00.000Z",
  };
  const canonical = { passport: [{ driveFileId: "canonical-new" }] };
  const replaced = buildApplicantProfile(previous, previous.phone, {
    multiPackage: true,
    refreshApplicantProfileDocuments: true,
    canonicalApplicantDocuments: canonical,
    canonicalApplicantDocumentsUpdatedAt: "2026-01-01T00:00:00.000Z",
    data: { name: "New" },
  }, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(replaced.documents, canonical);
  assert.equal(replaced.lastDocumentsUpdatedAt, "2026-01-01T00:00:00.000Z");

  const reused = buildApplicantProfile(previous, previous.phone, {
    multiPackage: true,
    refreshApplicantProfileDocuments: false,
    data: { name: "New" },
  }, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(reused.documents, previous.documents);
  assert.equal(reused.lastDocumentsUpdatedAt, previous.lastDocumentsUpdatedAt);
});
