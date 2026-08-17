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
    body { margin: 0; color: #1f1f1f; background: #ededed; font-family: Arial, Helvetica, sans-serif; font-size: 11.5pt; line-height: 1.45; }
    .screen-actions { width: 184mm; margin: 14px auto 0; text-align: right; }
    .screen-actions button { padding: 7px 13px; border: 1px solid #555; border-radius: 3px; background: #fff; color: #1f1f1f; font: inherit; font-size: 10.5pt; cursor: pointer; }
    .card { width: 184mm; min-height: 267mm; margin: 10px auto 20px; padding: 12mm; background: #fff; box-shadow: 0 2px 12px rgba(0, 0, 0, .16); }
    .header { border-bottom: 2px solid #333; padding-bottom: 9px; margin-bottom: 15px; }
    .header-top { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
    .header h1 { margin: 0; font-size: 18pt; line-height: 1.15; letter-spacing: .01em; }
    .header .date { margin: 0; color: #555; font-size: 10pt; white-space: nowrap; }
    .header .name { margin: 8px 0 0; font-size: 14pt; font-weight: 700; line-height: 1.25; }
    .header .unit { margin: 5px 0 0; color: #333; font-size: 11pt; }
    .section { margin-bottom: 14px; }
    h2 { margin: 0 0 7px; color: #303030; font-size: 11.5pt; letter-spacing: .04em; }
    .need-box { border: 1px solid #a8a8a8; padding: 10px 12px; min-height: 48mm; }
    .need { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
    .notes { margin-bottom: 14px; }
    .notes-box { border: 1px solid #a8a8a8; padding: 0 12px; }
    .note-line { height: 11mm; border-bottom: 1px solid #b6b6b6; }
    .note-line:last-child { border-bottom: 0; }
    .shipping { border-top: 1px solid #777; padding-top: 11px; }
    .shipping-row { margin: 5px 0; }
    .shipping-row strong { display: inline-block; min-width: 43mm; color: #404040; }
    @media print {
      body { background: #fff; }
      .screen-actions { display: none; }
      .card { width: auto; min-height: 0; margin: 0; padding: 0; box-shadow: none; page-break-after: always; }
    }
  </style>
</head>
<body>
  <div class="screen-actions"><button type="button" onclick="window.print()">Друкувати</button></div>
  <main class="card">
    <header class="header">
      <div class="header-top">
        <h1>ЗАЯВКА № ${escapeHtml(request.applicationId)}</h1>
        <p class="date">Дата: ${displayValue(request.date)}</p>
      </div>
      <p class="name">${displayValue(request.personName)}</p>
      ${militaryUnit}
    </header>
    <section class="section need-section">
      <h2>ПОТРЕБА</h2>
      <div class="need-box"><p class="need">${displayValue(request.need)}</p></div>
    </section>
    <section class="notes">
      <h2>КОМПЛЕКТАЦІЯ / ПРИМІТКИ</h2>
      <div class="notes-box"><div class="note-line"></div><div class="note-line"></div><div class="note-line"></div><div class="note-line"></div><div class="note-line"></div></div>
    </section>
    <section class="shipping">
      <h2>ДАНІ ДЛЯ ВІДПРАВКИ</h2>
      <div class="shipping-row"><strong>Отримувач:</strong> <span>${displayValue(request.actualRecipientName)}</span></div>
      <div class="shipping-row"><strong>Телефон:</strong> <span>${displayValue(request.actualRecipientPhone)}</span></div>
      <div class="shipping-row"><strong>Місто:</strong> <span>${displayValue(request.city)}</span></div>
      <div class="shipping-row"><strong>Нова пошта:</strong> <span>${displayValue(request.novaPoshtaBranch)}</span></div>
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
