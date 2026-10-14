import assert from "node:assert/strict";
import test from "node:test";

import { requestCardPage } from "../api/request-card.js";
import { normalizeRequestRow } from "../lib/google-sheets.js";

function baseRequest(overrides = {}) {
  return {
    type: "individual",
    applicationId: "2026-10-0001",
    date: "14.10.2026",
    personName: "Заявник",
    mainPhone: "000000000000",
    need: "Потреба",
    city: "Місто",
    novaPoshtaBranch: "1",
    actualRecipientName: "Отримувач",
    actualRecipientPhone: "000000000000",
    ...overrides,
  };
}

test("single request card shows provided, missing and optional document statuses without metadata", () => {
  const html = requestCardPage(baseRequest({
    documents: {
      passport: [{ fileName: "passport.jpg", url: "https://private.example/passport" }],
      rnokpp: [],
      military_id: [{ fileName: "military.pdf", driveFileId: "private-id" }],
      ubd: [],
    },
  }));

  assert.match(html, /<h2>ДОКУМЕНТИ<\/h2>/);
  assert.match(html, /Паспорт:<\/strong> <span class="document-status-symbol">✓<\/span>/);
  assert.match(html, /РНОКПП:<\/strong> <span class="document-status-symbol">✕<\/span>/);
  assert.match(html, /Військово-обліковий документ:<\/strong> <span class="document-status-symbol">✓<\/span>/);
  assert.match(html, /Посвідчення УБД:<\/strong> <span class="document-status-symbol">—<\/span>/);
  assert.doesNotMatch(html, /private\.example|private-id|passport\.jpg|military\.pdf/);
});

test("military request card shows the official letter status", () => {
  const provided = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "А1234",
    personName: "Іваненко Іван Іванович",
    mainPhone: "+380 XX XXX XX XX",
    actualRecipientName: "Іваненко Іван Іванович",
    actualRecipientPhone: "+380 XX XXX XX XX",
    documents: { official_request: [{ fileName: "official.pdf" }] },
  }));
  const missing = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "A0000",
    documents: { official_request: [] },
  }));

  assert.match(provided, /Офіційний лист військової частини:<\/strong> <span class="document-status-symbol">✓<\/span>/);
  assert.match(missing, /Офіційний лист військової частини:<\/strong> <span class="document-status-symbol">✕<\/span>/);
  const unitPosition = provided.indexOf("ВІЙСЬКОВА ЧАСТИНА А1234");
  const contactLabelPosition = provided.indexOf("Контактна особа");
  const contactNamePosition = provided.indexOf("Іваненко Іван Іванович");
  const contactPhonePosition = provided.indexOf("+380 XX XXX XX XX");
  assert.ok(unitPosition >= 0 && unitPosition < contactLabelPosition);
  assert.ok(contactLabelPosition < contactNamePosition && contactNamePosition < contactPhonePosition);
  assert.equal((provided.match(/\+380 XX XXX XX XX/g) || []).length, 2);
  assert.doesNotMatch(provided, /official\.pdf/);
});

test("military card keeps different contact and recipient phones in their own blocks", () => {
  const html = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "А1234",
    personName: "Контакт",
    mainPhone: "+380 CONTACT",
    actualRecipientName: "Отримувач",
    actualRecipientPhone: "+380 RECIPIENT",
    documents: { official_request: [{}] },
  }));

  const contactBlock = html.match(/<div class="military-contact">([\s\S]*?)<\/div>/)?.[1] || "";
  const shippingBlock = html.match(/<section class="shipping">([\s\S]*?)<\/section>/)?.[1] || "";
  assert.match(contactBlock, /\+380 CONTACT/);
  assert.doesNotMatch(contactBlock, /\+380 RECIPIENT/);
  assert.match(shippingBlock, /\+380 RECIPIENT/);
  assert.doesNotMatch(shippingBlock, /\+380 CONTACT/);
});

test("military contact keeps its phone when recipient phone is absent and does not invent a unit number", () => {
  const html = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "",
    personName: "Контакт",
    mainPhone: "+380 CONTACT",
    actualRecipientPhone: "",
    documents: { official_request: [] },
  }));

  assert.match(html, /<p class="military-unit">ВІЙСЬКОВА ЧАСТИНА<\/p>/);
  assert.doesNotMatch(html, /ВІЙСЬКОВА ЧАСТИНА —/);
  const contactBlock = html.match(/<div class="military-contact">([\s\S]*?)<\/div>/)?.[1] || "";
  const shippingBlock = html.match(/<section class="shipping">([\s\S]*?)<\/section>/)?.[1] || "";
  assert.equal((contactBlock.match(/<span>/g) || []).length, 2);
  assert.match(contactBlock, /\+380 CONTACT/);
  assert.doesNotMatch(shippingBlock, /<strong>Телефон:<\/strong>/);
});

test("multi request card keeps per-beneficiary documents with unified statuses", () => {
  const html = requestCardPage(baseRequest({
    multiPackage: true,
    beneficiaries: [
      {
        index: 1,
        name: "Особа один",
        phone: "000000000001",
        documents: { passport: [{}], rnokpp: [{}], military_id: [{}], ubd: [] },
      },
      {
        index: 2,
        name: "Особа два",
        phone: "000000000002",
        documents: { passport: [], rnokpp: [{}], military_id: [{}], ubd: [{}] },
      },
    ],
  }));

  assert.match(html, /ОСОБИ ТА ДОКУМЕНТИ · 2/);
  assert.equal((html.match(/Паспорт:<\/strong>/g) || []).length, 2);
  assert.match(html, /Паспорт:<\/strong> <span class="document-status-symbol">✕<\/span>/);
  assert.match(html, /Посвідчення УБД:<\/strong> <span class="document-status-symbol">—<\/span>/);
  assert.match(html, /Посвідчення УБД:<\/strong> <span class="document-status-symbol">✓<\/span>/);
  assert.equal((html.match(/<h2>ДОКУМЕНТИ<\/h2>/g) || []).length, 0);
});

test("Sheets master rows expose document presence to single and military cards", () => {
  const single = normalizeRequestRow("individual", [
    "", "2026-10-0001", "14.10.2026", "Need", "Person", "000000000000",
    "passport1.jpg\npassport2.pdf", "rnokpp1.jpg", "military1.pdf", "",
    "City", "1", "Ні", "", "",
  ]);
  const military = normalizeRequestRow("military_unit", [
    "", "2026-10-0002", "14.10.2026", "Need", "Contact", "000000000000",
    "A0000", "official1.pdf", "City", "1", "Ні", "", "",
  ]);

  assert.equal(single.documents.passport.length, 2);
  assert.equal(single.documents.ubd.length, 0);
  assert.equal(military.documents.official_request.length, 1);
});
