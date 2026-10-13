import { createHash, timingSafeEqual } from "node:crypto";

import { findRequestMatchesForDiagnostics } from "../lib/google-sheets.js";

const DIAGNOSTIC_APPLICATION_ID = "2026-000005";
const SECRET_HEADER = "x-request-card-diagnostic-secret";

function hasValidSecret(req) {
  const expected = process.env.REQUEST_CARD_DIAGNOSTIC_SECRET;
  const provided = req.headers[SECRET_HEADER];
  if (typeof expected !== "string" || !expected.trim()) return false;
  if (typeof provided !== "string" || !provided) return false;

  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  const providedDigest = createHash("sha256").update(provided, "utf8").digest();
  return timingSafeEqual(expectedDigest, providedDigest);
}

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Method Not Allowed" });
  }
  if (!hasValidSecret(req)) return res.status(401).json({ error: "Unauthorized" });

  try {
    const matches = await findRequestMatchesForDiagnostics(DIAGNOSTIC_APPLICATION_ID);
    return res.status(200).json({ count: matches.length, matches });
  } catch {
    return res.status(500).json({ error: "Diagnostic lookup failed" });
  }
}
