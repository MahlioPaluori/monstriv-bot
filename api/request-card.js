import { createHmac, timingSafeEqual } from "node:crypto";
import { findRequestByApplicationId } from "./lib/google-sheets.js";

const APPLICATION_ID_PATTERN = /^\d{4}-\d{6,}$/;
const SIGNATURE_PATTERN = /^[a-f0-9]{64}$/i;

function getSigningSecret() {
  const secret = process.env.REQUEST_CARD_SIGNING_SECRET;
  if (!secret) throw new Error("Request card signing secret is missing");
  return secret;
}

function isApplicationId(value) {
  return typeof value === "string" && APPLICATION_ID_PATTERN.test(value);
}

function createSignature(applicationId) {
  return createHmac("sha256", getSigningSecret()).update(applicationId, "utf8").digest("hex");
}

function hasValidSignature(applicationId, signature) {
  if (!isApplicationId(applicationId) || typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) return false;
  const expected = Buffer.from(createSignature(applicationId), "hex");
  const supplied = Buffer.from(signature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

export function buildRequestCardUrl(applicationId, baseUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`) {
  if (!isApplicationId(applicationId)) throw new Error("Invalid application ID");
  if (!baseUrl) throw new Error("Production base URL is missing");
  const url = new URL("/api/request-card", baseUrl);
  url.searchParams.set("id", applicationId);
  url.searchParams.set("sig", createSignature(applicationId));
  return url.toString();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function displayValue(value) {
  return escapeHtml(value || "—");
}

function errorPage(message) {
  return `<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Картка запиту</title></head>
<body><main><h1>Картка запиту</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

function requestCardPage(request) {
  const militaryUnit = request.type === "military_unit"
    ? `<p class="unit"><strong>Військова частина:</strong> ${displayValue(request.militaryUnitNumber)}</p>`
    : "";
  return `<!doctype html>
<html lang="uk">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Заявка № ${escapeHtml(request.applicationId)}</title>
  <style>
    @page { size: A4 portrait; margin: 14mm; }
    * { box-sizing: border-box; }
    body { margin: 0; color: #000; background: #f2f2f2; font-family: Arial, sans-serif; font-size: 12pt; line-height: 1.4; }
    .screen-actions { max-width: 184mm; margin: 12px auto 0; text-align: right; }
    .screen-actions button { padding: 8px 14px; font: inherit; cursor: pointer; }
    .card { width: 184mm; min-height: 267mm; margin: 12px auto; padding: 0; background: #fff; }
    .header, .section { border-bottom: 1px solid #000; padding: 0 0 12px; margin-bottom: 14px; }
    .header h1 { margin: 0 0 6px; font-size: 18pt; }
    .header .name { margin: 0; font-size: 14pt; font-weight: bold; }
    .header .date { margin: 8px 0 0; font-size: 10pt; }
    h2 { margin: 0 0 8px; font-size: 12pt; }
    .need { margin: 0; min-height: 54mm; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notes { border-bottom: 1px solid #000; padding-bottom: 8px; margin-bottom: 14px; }
    .note-line { height: 10mm; border-bottom: 1px solid #000; }
    .shipping p { margin: 4px 0; }
    @media print {
      body { background: #fff; }
      .screen-actions { display: none; }
      .card { width: auto; min-height: 0; margin: 0; page-break-after: always; }
    }
  </style>
</head>
<body>
  <div class="screen-actions"><button type="button" onclick="window.print()">Друкувати</button></div>
  <main class="card">
    <header class="header">
      <h1>ЗАЯВКА № ${escapeHtml(request.applicationId)}</h1>
      <p class="name">${displayValue(request.personName)}</p>
      <p class="date">Дата: ${displayValue(request.date)}</p>
      ${militaryUnit}
    </header>
    <section class="section">
      <h2>ПОТРЕБА</h2>
      <p class="need">${displayValue(request.need)}</p>
    </section>
    <section class="notes">
      <h2>КОМПЛЕКТАЦІЯ / ПРИМІТКИ</h2>
      <div class="note-line"></div><div class="note-line"></div><div class="note-line"></div><div class="note-line"></div>
    </section>
    <section class="shipping">
      <h2>ДАНІ ДЛЯ ВІДПРАВКИ</h2>
      <p><strong>Отримувач:</strong> ${displayValue(request.actualRecipientName)}</p>
      <p><strong>Телефон:</strong> ${displayValue(request.actualRecipientPhone)}</p>
      <p><strong>Місто:</strong> ${displayValue(request.city)}</p>
      <p><strong>Нова пошта:</strong> ${displayValue(request.novaPoshtaBranch)}</p>
    </section>
  </main>
</body>
</html>`;
}

function sendHtml(res, status, html) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.status(status).send(html);
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return sendHtml(res, 405, errorPage("Метод не підтримується."));
  }

  const applicationId = req.query.id;
  const signature = req.query.sig;
  try {
    if (!hasValidSignature(applicationId, signature)) {
      return sendHtml(res, 403, errorPage("Неможливо відкрити картку запиту."));
    }
  } catch {
    return sendHtml(res, 500, errorPage("Картка тимчасово недоступна."));
  }

  try {
    const lookup = await findRequestByApplicationId(applicationId);
    if (lookup.result === "not_found") return sendHtml(res, 404, errorPage("Картку запиту не знайдено."));
    if (lookup.result === "duplicate") return sendHtml(res, 409, errorPage("Картку тимчасово неможливо відкрити."));
    if (lookup.result !== "found") return sendHtml(res, 422, errorPage("Дані картки некоректні."));
    return sendHtml(res, 200, requestCardPage(lookup.request));
  } catch {
    return sendHtml(res, 500, errorPage("Картка тимчасово недоступна."));
  }
}
