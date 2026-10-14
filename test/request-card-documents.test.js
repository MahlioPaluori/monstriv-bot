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
  assert.match(html, /Паспорт:<\/strong> Надано/);
  assert.match(html, /РНОКПП:<\/strong> Не надано/);
  assert.match(html, /Військово-обліковий документ:<\/strong> Надано/);
  assert.match(html, /Посвідчення УБД:<\/strong> Необов&#39;язково \/ пропущено/);
  assert.doesNotMatch(html, /private\.example|private-id|passport\.jpg|military\.pdf/);
});

test("military request card shows the official letter status", () => {
  const provided = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "A0000",
    documents: { official_request: [{ fileName: "official.pdf" }] },
  }));
  const missing = requestCardPage(baseRequest({
    type: "military_unit",
    militaryUnitNumber: "A0000",
    documents: { official_request: [] },
  }));

  assert.match(provided, /Офіційний лист військової частини:<\/strong> Надано/);
  assert.match(missing, /Офіційний лист військової частини:<\/strong> Не надано/);
  assert.doesNotMatch(provided, /official\.pdf/);
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
  assert.match(html, /Паспорт:<\/strong> Не надано/);
  assert.match(html, /Посвідчення УБД:<\/strong> Необов&#39;язково \/ пропущено/);
  assert.match(html, /Посвідчення УБД:<\/strong> Надано/);
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
