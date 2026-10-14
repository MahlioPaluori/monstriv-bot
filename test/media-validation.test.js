import assert from "node:assert/strict";
import test from "node:test";

import {
  assertRequestDocumentsHaveValidation,
  confirmRequest,
  prepareSavedDocumentsForReuse,
  requestDocumentsHaveValidation,
  restartRequestWithUnvalidatedDocuments,
  saveIncomingDocument,
} from "../api/webhook.js";
import { downloadWhatsAppMedia } from "../lib/meta-media.js";
import {
  MAX_MEDIA_SIZE_BYTES,
  MediaValidationError,
  validateMediaBuffer,
} from "../lib/media-validation.js";

function jpeg({ width = 20, height = 10, trailing = false } = {}) {
  const frame = Buffer.from([0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00]);
  const scan = Buffer.from([0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0xff, 0xd9]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), frame, scan, ...(trailing ? [Buffer.from([0])] : [])]);
}

function png({ width = 20, height = 10 } = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, payload) => {
    const result = Buffer.alloc(12 + payload.length);
    result.writeUInt32BE(payload.length, 0); result.write(type, 4, "ascii"); payload.copy(result, 8);
    let crc = 0xffffffff;
    for (const byte of result.subarray(4, 8 + payload.length)) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 8 + payload.length);
    return result;
  };
  const ihdrPayload = Buffer.alloc(13);
  ihdrPayload.writeUInt32BE(width, 0); ihdrPayload.writeUInt32BE(height, 4); ihdrPayload[8] = 8; ihdrPayload[9] = 2;
  return Buffer.concat([signature, chunk("IHDR", ihdrPayload), chunk("IDAT", Buffer.from([0])), chunk("IEND", Buffer.alloc(0))]);
}

function isoBox(type, payload = Buffer.alloc(0)) {
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0); box.write(type, 4, "ascii"); payload.copy(box, 8);
  return box;
}

function heif(brand = "heic") {
  const ftyp = Buffer.alloc(12); ftyp.write(brand, 0, "ascii"); ftyp.writeUInt32BE(0, 4); ftyp.write(brand, 8, "ascii");
  return Buffer.concat([isoBox("ftyp", ftyp), isoBox("meta", Buffer.from([0, 0, 0, 0])), isoBox("mdat", Buffer.from([1]))]);
}

function pdf(size = null) {
  const prefix = Buffer.from("%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "ascii");
  const suffix = Buffer.from("\nxref\n0 1\n0000000000 65535 f \ntrailer\n<< /Root 1 0 R >>\nstartxref\n45\n%%EOF", "ascii");
  if (size === null) return Buffer.concat([prefix, suffix]);
  return Buffer.concat([prefix, Buffer.alloc(size - prefix.length - suffix.length, 0x20), suffix]);
}

test("validates JPEG, PNG, HEIC, HEIF and PDF with canonical extensions", () => {
  const cases = [
    [jpeg(), "image/jpeg", ".jpg"], [png(), "image/png", ".png"],
    [heif("heic"), "image/heic", ".heic"], [heif("mif1"), "image/heif", ".heif"],
    [pdf(), "application/pdf", ".pdf"],
  ];
  for (const [buffer, mimeType, extension] of cases) {
    const result = validateMediaBuffer(buffer, mimeType);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.extension, extension);
    assert.match(result.sha256, /^[a-f0-9]{64}$/);
  }
});

test("rejects unsupported MIME, MIME spoofing and malformed content", () => {
  assert.throws(() => validateMediaBuffer(pdf(), "application/octet-stream"), { code: "UNSUPPORTED_MEDIA_TYPE" });
  assert.throws(() => validateMediaBuffer(pdf(), "image/jpeg"), { code: "INVALID_MEDIA" });
  assert.throws(() => validateMediaBuffer(jpeg({ trailing: true }), "image/jpeg"), { code: "INVALID_MEDIA" });
  assert.throws(() => validateMediaBuffer(png({ width: 50000 }), "image/png"), { code: "INVALID_MEDIA" });
  assert.throws(() => validateMediaBuffer(Buffer.from("<svg></svg>"), "image/png"), { code: "INVALID_MEDIA" });
  assert.throws(() => validateMediaBuffer(Buffer.from("MZ executable"), "application/pdf"), { code: "INVALID_MEDIA" });
});

test("rejects obvious active and protected PDF features", () => {
  for (const token of ["/JavaScript", "/OpenAction", "/Launch", "/EmbeddedFile", "/Encrypt"]) {
    const unsafe = Buffer.concat([Buffer.from(`%PDF-1.7\n${token}\n`, "ascii"), pdf().subarray(9)]);
    assert.throws(() => validateMediaBuffer(unsafe, "application/pdf"), { code: "INVALID_MEDIA" });
  }
});

test("accepts exactly 5 MiB and rejects a larger buffer", () => {
  assert.equal(validateMediaBuffer(pdf(MAX_MEDIA_SIZE_BYTES), "application/pdf").size, MAX_MEDIA_SIZE_BYTES);
  assert.throws(() => validateMediaBuffer(pdf(MAX_MEDIA_SIZE_BYTES + 1), "application/pdf"), { code: "MEDIA_TOO_LARGE" });
});

function fetchSequence(metadata, body, headers = {}) {
  let call = 0;
  return async () => {
    call += 1;
    if (call === 1) return new Response(JSON.stringify(metadata), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(body, { status: 200, headers });
  };
}

test("download rejects oversized metadata before fetching media", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response(JSON.stringify({ url: "https://media.test", mime_type: "application/pdf", file_size: MAX_MEDIA_SIZE_BYTES + 1 }), { status: 200 }); };
  await assert.rejects(downloadWhatsAppMedia("media", { fetchImpl, token: "test-token" }), { code: "MEDIA_TOO_LARGE" });
  assert.equal(calls, 1);
});

test("download enforces streaming limit and declared length consistency", async () => {
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(MAX_MEDIA_SIZE_BYTES)); controller.enqueue(new Uint8Array(1)); controller.close(); } });
  await assert.rejects(downloadWhatsAppMedia("media", { fetchImpl: fetchSequence({ url: "https://media.test", mime_type: "application/pdf" }, oversized, { "content-type": "application/pdf" }), token: "test-token" }), { code: "MEDIA_TOO_LARGE" });
  await assert.rejects(downloadWhatsAppMedia("media", { fetchImpl: fetchSequence({ url: "https://media.test", mime_type: "application/pdf", file_size: pdf().length + 1 }, pdf(), { "content-type": "application/pdf" }), token: "test-token" }), { code: "INVALID_MEDIA" });
});

test("rejected media never reaches Drive or mutates request documents", async () => {
  const state = { request: { type: "individual", data: { name: "Applicant" }, documents: {}, documentIndex: 0 } };
  let driveUploads = 0;
  await assert.rejects(saveIncomingDocument("phone", state, { type: "document" }, "media", { key: "passport" }, {
    beginDocumentUpload: async () => "STARTED",
    failDocumentUpload: async () => {},
    downloadWhatsAppMedia: async () => { throw new MediaValidationError("INVALID_MEDIA", "bad file"); },
    uploadBufferToDrive: async () => { driveUploads += 1; },
  }), { code: "INVALID_MEDIA" });
  assert.equal(driveUploads, 0);
  assert.deepEqual(state.request.documents, {});
});

test("successful upload stores validation metadata and canonical extension", async () => {
  const state = { request: { type: "individual", data: { name: "Applicant" }, documents: {}, documentIndex: 0 } };
  const buffer = jpeg();
  const validation = validateMediaBuffer(buffer, "image/jpeg");
  let uploadedName;
  await saveIncomingDocument("phone", state, { type: "document", document: { filename: "malware.exe" } }, "media", { key: "passport" }, {
    beginDocumentUpload: async () => "STARTED",
    failDocumentUpload: async () => {},
    downloadWhatsAppMedia: async () => ({ buffer, mimeType: "image/jpeg", fileSize: buffer.length, extension: ".jpg", validation }),
    getOrCreateApplicantFolder: async () => ({ id: "folder" }),
    nextDocumentSequence: async () => 1,
    uploadBufferToDrive: async ({ name }) => { uploadedName = name; return { id: "drive", name, webViewLink: "https://drive.test/file" }; },
    completeDocumentUpload: async (_phone, _uploadId, { document }) => {
      state.request.documents.passport = [document];
      return { status: "ADDED", count: 1, state };
    },
  });
  assert.equal(uploadedName, "passport1.jpg");
  assert.equal(state.request.documents.passport[0].validation.version, 1);
});

test("legacy saved documents force re-upload and cannot enter single or multi reuse", () => {
  const valid = validateMediaBuffer(jpeg(), "image/jpeg");
  const mixed = prepareSavedDocumentsForReuse({ passport: [{ driveFileId: "old" }, { driveFileId: "new", validation: valid }] });
  assert.equal(mixed.legacyDocumentsRequireUpload, true);
  assert.deepEqual(mixed.documents, {});

  const safe = prepareSavedDocumentsForReuse({ passport: [{ driveFileId: "new", validation: valid }] });
  assert.equal(safe.legacyDocumentsRequireUpload, false);
  assert.deepEqual(safe.documents.passport.map((document) => document.driveFileId), ["new"]);
});

for (const stage of ["PACKAGE_MODE", "DOCUMENT_UPDATE_DECISION", "MULTI_APPLICANT_INCLUDED", "MULTI_SAVED_DOCUMENTS_DECISION", "CONFIRMATION"]) {
  test(`legacy Redis state at ${stage} is safely restarted before its old action`, async () => {
    const state = {
      stage,
      request: {
        type: "individual",
        data: { phone: "phone", name: "Test" },
        documents: { passport: [{ driveFileId: "legacy-file" }] },
        beneficiaries: stage.startsWith("MULTI_")
          ? [{ name: "Test", phone: "phone", documents: { passport: [{ driveFileId: "legacy-beneficiary-file" }] } }]
          : undefined,
      },
    };
    let persisted = 0;
    let notified = 0;
    let menus = 0;
    const restarted = await restartRequestWithUnvalidatedDocuments("phone", state, {
      saveUserState: async () => { persisted += 1; },
      sendText: async () => { notified += 1; },
      sendApplicantTypeMenu: async () => { menus += 1; },
    });
    assert.equal(restarted, true);
    assert.equal(state.stage, "APPLICANT_TYPE");
    assert.deepEqual(state.request, { type: null, data: { phone: "phone" }, documents: {}, documentIndex: 0 });
    assert.deepEqual([persisted, notified, menus], [1, 1, 1]);
  });
}

test("validated single, multi and military requests pass the centralized invariant", async () => {
  const validation = validateMediaBuffer(jpeg(), "image/jpeg");
  const document = { driveFileId: "validated-file", validation };
  const requests = [
    { type: "individual", documents: { passport: [document] } },
    { type: "individual", multiPackage: true, documents: {}, beneficiaries: [{ documents: { passport: [document] } }, { documents: { passport: [document] } }] },
    { type: "military_unit", documents: { official_request: [document] } },
  ];
  for (const request of requests) {
    assert.equal(requestDocumentsHaveValidation(request), true);
    assert.doesNotThrow(() => assertRequestDocumentsHaveValidation(request));
    const state = { stage: "CONFIRMATION", request };
    assert.equal(await restartRequestWithUnvalidatedDocuments("phone", state, {
      saveUserState: async () => assert.fail("valid state must not be persisted"),
      sendText: async () => assert.fail("valid state must not be rejected"),
      sendApplicantTypeMenu: async () => assert.fail("valid state must not be restarted"),
    }), false);
  }
});

test("confirmation invariant rejects legacy single, multi and military documents", () => {
  const legacy = { driveFileId: "legacy-file" };
  const requests = [
    { type: "individual", documents: { passport: [legacy] } },
    { type: "individual", multiPackage: true, beneficiaries: [{ documents: { passport: [legacy] } }] },
    { type: "military_unit", documents: { official_request: [legacy] } },
  ];
  for (const request of requests) {
    assert.throws(() => assertRequestDocumentsHaveValidation(request), { code: "UNVALIDATED_REQUEST_DOCUMENTS" });
  }
});

test("production confirmation starts no side effects for legacy single, multi or military documents", async () => {
  const legacy = { driveFileId: "legacy-file" };
  const requests = [
    { type: "individual", documents: { passport: [legacy] } },
    { type: "individual", multiPackage: true, beneficiaries: [{ documents: { passport: [legacy] } }] },
    { type: "military_unit", documents: { official_request: [legacy] } },
  ];
  for (const request of requests) {
    let sideEffects = 0;
    const forbidden = async () => { sideEffects += 1; };
    await assert.rejects(confirmRequest("phone", { stage: "CONFIRMATION", request }, forbidden, {
      nextApplicationId: forbidden,
      persistState: forbidden,
      appendRequest: forbidden,
      appendMultiRequest: forbidden,
      finalizeMultiDocuments: forbidden,
      finalizeMilitaryDocuments: forbidden,
      updateMilitaryLinks: forbidden,
      persistApplicantProfile: forbidden,
      persistMilitaryProfile: forbidden,
      sendAccepted: forbidden,
      clearState: forbidden,
    }), { code: "UNVALIDATED_REQUEST_DOCUMENTS" });
    assert.equal(sideEffects, 0);
    assert.equal(request.applicationId, undefined);
  }
});
