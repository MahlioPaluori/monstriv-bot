import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { runCategoryMigration } from "../lib/google-sheets-migration.js";
import {
  beginCategoryMigrationClaim,
  completeCategoryMigrationClaim,
  releaseCategoryMigrationClaim,
} from "../lib/state.js";

const ADMIN_HEADER = "x-sheets-migration-admin-secret";
const APPLY_HEADER = "x-sheets-migration-apply-token";
const APPLY_CONFIRMATION = "APPLY_CATEGORY_MIGRATION";

function headerValue(req, name) {
  const value = req.headers?.[name];
  return Array.isArray(value) ? value[0] : value;
}

function secretMatches(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string" || !actual || !expected) return false;
  const actualDigest = createHash("sha256").update(actual).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function spreadsheetIdFromQuery(req) {
  const value = req.query?.spreadsheetId;
  return Array.isArray(value) ? value[0] : value;
}

function validSpreadsheetId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{10,200}$/.test(value);
}

function safeMigrationError(error) {
  const rawStatus = error?.response?.status ?? error?.code;
  const httpCode = Number.isInteger(Number(rawStatus)) ? Number(rawStatus) : null;
  const rawMessage = error?.response?.data?.error?.message;
  const googleMessage = typeof rawMessage === "string"
    ? rawMessage.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500)
    : "No Google API message";
  return {
    stage: typeof error?.migrationStage === "string" ? error.migrationStage : "unknown",
    httpCode,
    googleMessage,
  };
}

function publicReport(report) {
  return {
    mode: report.mode,
    spreadsheetCount: report.spreadsheetCount,
    results: report.results.map((item) => ({
      spreadsheetId: item.spreadsheetId,
      name: item.name,
      result: item.result,
      sheets: item.sheets.map((sheet) => ({ title: sheet.title, layout: sheet.layout, stats: sheet.stats })),
      reference: {
        present: item.reference.present,
        valid: item.reference.valid,
        categoryCount: item.reference.categories.length,
      },
      ambiguities: item.ambiguities,
      backup: item.backup ? { spreadsheetId: item.backup.id, name: item.backup.name } : null,
    })),
  };
}

function respond(res, status, body) {
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.setHeader("Pragma", "no-cache");
  return res.status(status).json(body);
}

export function createGoogleSheetsMigrationHandler({
  runMigration = runCategoryMigration,
  beginClaim = beginCategoryMigrationClaim,
  completeClaim = completeCategoryMigrationClaim,
  releaseClaim = releaseCategoryMigrationClaim,
  ownerToken = randomUUID,
  environment = process.env,
} = {}) {
  return async function handler(req, res) {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("Pragma", "no-cache");
    if (!secretMatches(headerValue(req, ADMIN_HEADER), environment.SHEETS_MIGRATION_ADMIN_SECRET)) {
      return respond(res, 401, { error: "Unauthorized" });
    }

    if (req.method === "GET") {
      const spreadsheetId = spreadsheetIdFromQuery(req);
      if (spreadsheetId !== undefined && !validSpreadsheetId(spreadsheetId)) return respond(res, 400, { error: "Invalid spreadsheetId" });
      try {
        const report = await runMigration({ mode: "dry-run", spreadsheetId });
        return respond(res, 200, publicReport(report));
      } catch (error) {
        console.error(JSON.stringify({ event: "sheets_migration_dry_run_failed", errorCode: error?.code || "UNKNOWN" }));
        return respond(res, 500, { error: "Dry-run failed" });
      }
    }

    if (req.method !== "POST") {
      res.setHeader("Allow", "GET, POST");
      return respond(res, 405, { error: "Method not allowed" });
    }

    const adminSecret = environment.SHEETS_MIGRATION_ADMIN_SECRET;
    const applySecret = environment.SHEETS_MIGRATION_APPLY_TOKEN;
    if (typeof adminSecret !== "string" || typeof applySecret !== "string" || !adminSecret || !applySecret || secretMatches(adminSecret, applySecret)) {
      return respond(res, 503, { error: "Migration apply authorization is not configured" });
    }
    if (!secretMatches(headerValue(req, APPLY_HEADER), environment.SHEETS_MIGRATION_APPLY_TOKEN)) {
      return respond(res, 401, { error: "Apply authorization failed" });
    }
    const { mode, spreadsheetId, confirmation } = req.body || {};
    if (mode !== "apply" || confirmation !== APPLY_CONFIRMATION || !validSpreadsheetId(spreadsheetId)) {
      return respond(res, 400, { error: "Apply requires mode, confirmation and one valid spreadsheetId" });
    }

    const token = ownerToken();
    let claimAcquired = false;
    try {
      const claim = await beginClaim(spreadsheetId, token);
      if (claim === "COMPLETED") return respond(res, 409, { error: "Migration was already completed for this spreadsheet" });
      if (claim !== "ACQUIRED") return respond(res, 409, { error: "Migration is already running for this spreadsheet" });
      claimAcquired = true;
      const report = await runMigration({ mode: "apply", spreadsheetId });
      if (!await completeClaim(spreadsheetId, token)) throw Object.assign(new Error("Migration completion claim lost"), { code: "MIGRATION_CLAIM_LOST" });
      claimAcquired = false;
      return respond(res, 200, publicReport(report));
    } catch (error) {
      console.error(JSON.stringify({ event: "sheets_migration_apply_failed", ...safeMigrationError(error) }));
      if (claimAcquired) {
        try { await releaseClaim(spreadsheetId, token); }
        catch { console.error(JSON.stringify({ event: "sheets_migration_claim_release_failed", errorCode: "UNKNOWN" })); }
      }
      return respond(res, error?.code === "SHEET_WRITE_BUSY" ? 409 : 500, { error: "Migration apply failed" });
    }
  };
}

export default createGoogleSheetsMigrationHandler();
