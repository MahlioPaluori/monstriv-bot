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

function attachStage(error, stage) {
  if (error && typeof error === "object" && !error.migrationStage) error.migrationStage = stage;
  throw error;
}

async function endpointStage(stage, operation) {
  try {
    return await operation();
  } catch (error) {
    attachStage(error, stage);
  }
}

function safeCode(value, fallback) {
  if (typeof value !== "string") return fallback;
  if (/^(?:MIGRATION|SHEET_WRITE)_[A-Z0-9_]{1,70}$/.test(value)) return value;
  if (new Set(["ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]).has(value)) return value;
  return fallback;
}

function safeStackLocation(error) {
  if (typeof error?.stack !== "string") return null;
  const match = error.stack.split("\n").slice(1).join("\n").match(/(?:file:\/\/\/)?[^\s()]*[\\/]((?:api|lib)[\\/][A-Za-z0-9._\\/-]+:\d+:\d+)/);
  return match ? match[1].replace(/\\/g, "/") : null;
}

function safeExceptionType(value) {
  return new Set(["Error", "TypeError", "ReferenceError", "RangeError", "SyntaxError"]).has(value) ? value : "Error";
}

function sanitizeGoogleMessage(value) {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\bBearer\s+[^\s,;]+/gi, "Bearer [REDACTED]")
    .replace(/\b(access[_ -]?token|refresh[_ -]?token|client[_ -]?secret|authorization)\b\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, "[REDACTED]")
    .replace(/\b[A-Za-z0-9_-]{100,}\b/g, "[REDACTED]")
    .trim()
    .slice(0, 500);
}

function safeMigrationError(error) {
  const rawStatus = error?.response?.status ?? error?.code;
  const httpCode = Number.isInteger(Number(rawStatus)) ? Number(rawStatus) : null;
  const rawMessage = error?.response?.data?.error?.message;
  const googleMessage = typeof rawMessage === "string"
    ? sanitizeGoogleMessage(rawMessage)
    : null;
  return {
    stage: typeof error?.migrationStage === "string" ? error.migrationStage : "unknown",
    exceptionType: safeExceptionType(error?.name),
    errorCode: safeCode(error?.code, googleMessage ? "GOOGLE_API_ERROR" : "INTERNAL_ERROR"),
    httpCode,
    googleMessage,
    safeMessage: error?.migrationSafeToLog === true && typeof error.message === "string" ? error.message.slice(0, 500) : null,
    stackLocation: safeStackLocation(error),
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
      namedRange: item.namedRange ? {
        present: item.namedRange.present,
        valid: item.namedRange.valid,
        count: item.namedRange.count,
        referenceSheetId: item.namedRange.referenceSheetId,
        referenceRowCount: item.namedRange.referenceRowCount,
        targets: item.namedRange.targets,
      } : null,
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
        if (error && typeof error === "object" && !error.migrationStage) error.migrationStage = "dry_run_execute";
        console.error(JSON.stringify({ event: "sheets_migration_dry_run_failed", ...safeMigrationError(error) }));
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
      const claim = await endpointStage("migration_claim_begin", () => beginClaim(spreadsheetId, token));
      if (claim === "COMPLETED") return respond(res, 409, { error: "Migration was already completed for this spreadsheet" });
      if (claim !== "ACQUIRED") return respond(res, 409, { error: "Migration is already running for this spreadsheet" });
      claimAcquired = true;
      const report = await endpointStage("migration_execute", () => runMigration({ mode: "apply", spreadsheetId }));
      if (!await endpointStage("migration_claim_complete", () => completeClaim(spreadsheetId, token))) {
        throw Object.assign(new Error("Migration completion claim lost"), {
          code: "MIGRATION_CLAIM_LOST",
          migrationStage: "migration_claim_complete",
          migrationSafeToLog: true,
        });
      }
      claimAcquired = false;
      return respond(res, 200, publicReport(report));
    } catch (error) {
      console.error(JSON.stringify({ event: "sheets_migration_apply_failed", ...safeMigrationError(error) }));
      if (claimAcquired) {
        try { await endpointStage("migration_claim_release", () => releaseClaim(spreadsheetId, token)); }
        catch (releaseError) { console.error(JSON.stringify({ event: "sheets_migration_claim_release_failed", ...safeMigrationError(releaseError) })); }
      }
      return respond(res, error?.code === "SHEET_WRITE_BUSY" ? 409 : 500, { error: "Migration apply failed" });
    }
  };
}

export default createGoogleSheetsMigrationHandler();
