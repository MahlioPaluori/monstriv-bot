import { timingSafeEqual } from "node:crypto";
import { buildRequestCardUrl } from "./request-card.js";

const APPLICATION_ID_PATTERN = /^\d{4}-\d{6,}$/;

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

function isApplicationId(applicationId) {
  return typeof applicationId === "string" && APPLICATION_ID_PATTERN.test(applicationId);
}

export default function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendJson(res, 405, { success: false, error: "Method not allowed" });
  }

  const applicationId = req.query.id;
  if (!hasValidTestToken(req.query.token)) {
    return sendJson(res, 403, { success: false, error: "Unable to generate request card URL" });
  }
  if (!isApplicationId(applicationId)) {
    return sendJson(res, 400, { success: false, error: "Invalid application ID" });
  }

  try {
    return sendJson(res, 200, {
      success: true,
      id: applicationId,
      url: buildRequestCardUrl(applicationId),
    });
  } catch {
    return sendJson(res, 500, { success: false, error: "Unable to generate request card URL" });
  }
}
