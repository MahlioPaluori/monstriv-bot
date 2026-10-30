import assert from "node:assert/strict";
import test from "node:test";

import { uploadBufferToDrive } from "../lib/google-drive.js";

const marker = "a".repeat(64);

function fakeDrive({ createError = null, materializeBeforeError = false } = {}) {
  const files = [];
  let creates = 0;
  return {
    files,
    get createCount() { return creates; },
    api: {
      files: {
        list: async () => ({ data: { files: [...files] } }),
        create: async ({ requestBody }) => {
          creates += 1;
          const file = {
            id: `drive-${creates}`,
            name: requestBody.name,
            parents: requestBody.parents,
            mimeType: "image/jpeg",
            webViewLink: `https://drive.test/${creates}`,
            appProperties: requestBody.appProperties,
          };
          if (materializeBeforeError) files.push(file);
          if (createError) throw createError;
          files.push(file);
          return { data: file };
        },
      },
    },
  };
}

const upload = (drive) => uploadBufferToDrive({
  buffer: Buffer.from("image"),
  name: "passport1.jpg",
  mimeType: "image/jpeg",
  parentId: "folder",
  idempotencyMarker: marker,
}, { drive });

test("incoming Drive upload reuses an existing marked file without another create", async () => {
  const drive = fakeDrive();
  const first = await upload(drive.api);
  const second = await upload(drive.api);
  assert.equal(first.id, second.id);
  assert.equal(drive.createCount, 1);
  assert.equal(second.recoveredByMarker, true);
  assert.equal(drive.files[0].appProperties.monstrivIncomingUpload, marker);
});

test("lost Drive create response is reconciled by marker lookup", async () => {
  const networkError = new Error("connection reset");
  const drive = fakeDrive({ createError: networkError, materializeBeforeError: true });
  const result = await upload(drive.api);
  assert.equal(result.id, "drive-1");
  assert.equal(result.recoveredByMarker, true);
  assert.equal(drive.createCount, 1);
});

test("definite Drive rejection is not reported as an unknown create result", async () => {
  const rejected = new Error("bad request");
  rejected.response = { status: 400 };
  const drive = fakeDrive({ createError: rejected });
  await assert.rejects(upload(drive.api), (error) => error === rejected);
  assert.equal(drive.createCount, 1);
});

test("unreconciled network failure returns a controlled unknown-result error", async () => {
  const drive = fakeDrive({ createError: new Error("connection reset") });
  await assert.rejects(upload(drive.api), { code: "DRIVE_UPLOAD_RESULT_UNKNOWN" });
  assert.equal(drive.createCount, 1);
});

test("a failed marker lookup does not start a potentially duplicate create", async () => {
  const drive = fakeDrive();
  drive.api.files.list = async () => { throw new Error("lookup unavailable"); };
  await assert.rejects(upload(drive.api), { code: "DRIVE_UPLOAD_RESULT_UNKNOWN" });
  assert.equal(drive.createCount, 0);
});
