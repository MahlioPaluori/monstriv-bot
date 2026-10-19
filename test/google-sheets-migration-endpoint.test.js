import assert from "node:assert/strict";
import test from "node:test";

import { createGoogleSheetsMigrationHandler } from "../api/google-sheets-migration.js";

function responseMock() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

const environment = {
  SHEETS_MIGRATION_ADMIN_SECRET: "admin-secret",
  SHEETS_MIGRATION_APPLY_TOKEN: "apply-secret",
};

function safeReport(mode = "dry-run") {
  return {
    mode,
    spreadsheetCount: 1,
    results: [{
      spreadsheetId: "spreadsheet_12345",
      name: "Запити-жовтень-2026",
      result: mode === "apply" ? "migrated" : "would_migrate",
      sheets: [{ title: "Фізособи", layout: "legacy", stats: { masterRows: 1 } }],
      reference: { present: false, valid: false, categories: [] },
      ambiguities: [],
      backup: mode === "apply" ? { id: "backup_12345", name: "backup" } : null,
    }],
  };
}

test("endpoint rejects missing or incorrect admin authorization without running migration", async () => {
  let calls = 0;
  const handler = createGoogleSheetsMigrationHandler({ environment, runMigration: async () => { calls += 1; } });
  for (const headers of [{}, { "x-sheets-migration-admin-secret": "wrong" }]) {
    const res = responseMock();
    await handler({ method: "GET", headers, query: {} }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  }
  assert.equal(calls, 0);
});

test("authorized GET can only run dry-run and returns a sanitized report", async () => {
  let options;
  const handler = createGoogleSheetsMigrationHandler({ environment, runMigration: async (value) => { options = value; return safeReport(); } });
  const res = responseMock();
  await handler({ method: "GET", headers: { "x-sheets-migration-admin-secret": "admin-secret" }, query: { spreadsheetId: "spreadsheet_12345" } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(options, { mode: "dry-run", spreadsheetId: "spreadsheet_12345" });
  assert.equal(res.body.results[0].reference.categoryCount, 0);
  assert.equal("categories" in res.body.results[0].reference, false);
  assert.equal(res.headers.Pragma, "no-cache");
});

test("POST apply requires independent token, exact confirmation and one spreadsheet ID", async () => {
  let calls = 0;
  const handler = createGoogleSheetsMigrationHandler({ environment, runMigration: async () => { calls += 1; return safeReport("apply"); } });
  const base = { method: "POST", headers: { "x-sheets-migration-admin-secret": "admin-secret" }, body: {} };
  let res = responseMock();
  await handler(base, res);
  assert.equal(res.statusCode, 401);
  res = responseMock();
  await handler({ ...base, headers: { ...base.headers, "x-sheets-migration-apply-token": "apply-secret" }, body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION" } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(calls, 0);
});

test("apply is disabled when admin and apply secrets are not independently configured", async () => {
  let calls = 0;
  const handler = createGoogleSheetsMigrationHandler({
    environment: { SHEETS_MIGRATION_ADMIN_SECRET: "same-secret", SHEETS_MIGRATION_APPLY_TOKEN: "same-secret" },
    runMigration: async () => { calls += 1; },
  });
  const res = responseMock();
  await handler({
    method: "POST",
    headers: { "x-sheets-migration-admin-secret": "same-secret", "x-sheets-migration-apply-token": "same-secret" },
    body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
  }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(calls, 0);
});

test("successful apply uses Redis claim, completes it and exposes no secrets", async () => {
  const events = [];
  const handler = createGoogleSheetsMigrationHandler({
    environment,
    ownerToken: () => "owner-token",
    beginClaim: async (...args) => { events.push(["begin", ...args]); return "ACQUIRED"; },
    completeClaim: async (...args) => { events.push(["complete", ...args]); return true; },
    releaseClaim: async () => { events.push(["release"]); return true; },
    runMigration: async (options) => { events.push(["run", options]); return safeReport("apply"); },
  });
  const res = responseMock();
  await handler({
    method: "POST",
    headers: { "x-sheets-migration-admin-secret": "admin-secret", "x-sheets-migration-apply-token": "apply-secret" },
    body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
  }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(events.map((event) => event[0]), ["begin", "run", "complete"]);
  assert.doesNotMatch(JSON.stringify(res.body), /admin-secret|apply-secret|owner-token/);
});

test("busy and completed apply claims prevent migration execution", async () => {
  for (const claim of ["BUSY", "COMPLETED"]) {
    let calls = 0;
    const handler = createGoogleSheetsMigrationHandler({ environment, beginClaim: async () => claim, runMigration: async () => { calls += 1; } });
    const res = responseMock();
    await handler({
      method: "POST",
      headers: { "x-sheets-migration-admin-secret": "admin-secret", "x-sheets-migration-apply-token": "apply-secret" },
      body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
    }, res);
    assert.equal(res.statusCode, 409);
    assert.equal(calls, 0);
  }
});

test("failed apply releases its owned claim and returns a generic error", async () => {
  let released = false;
  const handler = createGoogleSheetsMigrationHandler({
    environment,
    beginClaim: async () => "ACQUIRED",
    releaseClaim: async () => { released = true; return true; },
    runMigration: async () => { throw Object.assign(new Error("sensitive upstream detail"), { code: "UPSTREAM" }); },
  });
  const res = responseMock();
  await handler({
    method: "POST",
    headers: { "x-sheets-migration-admin-secret": "admin-secret", "x-sheets-migration-apply-token": "apply-secret" },
    body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
  }, res);
  assert.equal(res.statusCode, 500);
  assert.equal(released, true);
  assert.deepEqual(res.body, { error: "Migration apply failed" });
});

test("failed apply logs safe Google API stage, status and message without response data", async () => {
  const entries = [];
  const originalError = console.error;
  console.error = (value) => entries.push(JSON.parse(value));
  try {
    const upstream = Object.assign(new Error("Invalid requests[0].setDataValidation"), {
      code: 400,
      migrationStage: "set_category_validation",
      response: { status: 400, data: { error: { message: "Invalid condition: ONE_OF_RANGE; Bearer oauth-token-must-not-log" }, access_token: "must-not-log" } },
    });
    const handler = createGoogleSheetsMigrationHandler({
      environment,
      beginClaim: async () => "ACQUIRED",
      releaseClaim: async () => true,
      runMigration: async () => { throw upstream; },
    });
    const res = responseMock();
    await handler({
      method: "POST",
      headers: { "x-sheets-migration-admin-secret": "admin-secret", "x-sheets-migration-apply-token": "apply-secret" },
      body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
    }, res);
    assert.equal(res.statusCode, 500);
    assert.deepEqual(entries[0], {
      event: "sheets_migration_apply_failed",
      stage: "set_category_validation",
      exceptionType: "Error",
      errorCode: "GOOGLE_API_ERROR",
      httpCode: 400,
      googleMessage: "Invalid condition: ONE_OF_RANGE; Bearer [REDACTED]",
      safeMessage: null,
      stackLocation: null,
    });
    assert.doesNotMatch(JSON.stringify(entries), /oauth-token-must-not-log|must-not-log|admin-secret|apply-secret/);
  } finally {
    console.error = originalError;
  }
});

test("local and Redis failures retain a stage and controlled diagnostics", async () => {
  const cases = [
    {
      expectedStage: "migration_claim_begin",
      options: { beginClaim: async () => { throw Object.assign(new Error("redis connection details"), { code: "ECONNRESET" }); } },
      expectedCode: "ECONNRESET",
    },
    {
      expectedStage: "migration_execute",
      options: { beginClaim: async () => "ACQUIRED", releaseClaim: async () => true, runMigration: async () => { throw new TypeError("private internal value"); } },
      expectedCode: "INTERNAL_ERROR",
      expectedType: "TypeError",
    },
    {
      expectedStage: "migration_claim_complete",
      options: { beginClaim: async () => "ACQUIRED", runMigration: async () => safeReport("apply"), completeClaim: async () => false, releaseClaim: async () => true },
      expectedCode: "MIGRATION_CLAIM_LOST",
      expectedSafeMessage: "Migration completion claim lost",
    },
  ];
  for (const scenario of cases) {
    const entries = [];
    const originalError = console.error;
    console.error = (value) => entries.push(JSON.parse(value));
    try {
      const handler = createGoogleSheetsMigrationHandler({ environment, ...scenario.options });
      const res = responseMock();
      await handler({
        method: "POST",
        headers: { "x-sheets-migration-admin-secret": "admin-secret", "x-sheets-migration-apply-token": "apply-secret" },
        body: { mode: "apply", confirmation: "APPLY_CATEGORY_MIGRATION", spreadsheetId: "spreadsheet_12345" },
      }, res);
      const entry = entries.find((item) => item.event === "sheets_migration_apply_failed");
      assert.equal(entry.stage, scenario.expectedStage);
      assert.equal(entry.errorCode, scenario.expectedCode);
      assert.equal(entry.exceptionType, scenario.expectedType || "Error");
      assert.equal(entry.safeMessage, scenario.expectedSafeMessage || null);
      assert.doesNotMatch(JSON.stringify(entry), /redis connection details|private internal value/);
    } finally {
      console.error = originalError;
    }
  }
});
