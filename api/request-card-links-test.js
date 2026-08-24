import { timingSafeEqual } from "node:crypto";
import { ensureRequestCardLinks } from "../lib/google-sheets.js";

function sendJson(res, status, payload) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.status(status).json(payload);
}

function hasValidTestToken(token) {
  const secret = process.env.REQUEST_CARD_TEST_SECRET;
  if (!secret || typeof token !== "string") return false;
  const expected = Buffer.from(secret, "utf8");
  const supplied = Buffer.from(token, "utf8");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }
  if (!hasValidTestToken(req.query.token)) {
    return sendJson(res, 403, { success: false, error: "Unable to update request card links" });
  }

  try {
    return sendJson(res, 200, await ensureRequestCardLinks());
  } catch (error) {
    console.error("Request card links migration failed:", error?.message || "Unknown error");
    return sendJson(res, 500, { success: false, error: "Unable to update request card links" });
  }
}
