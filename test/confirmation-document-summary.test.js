import assert from "node:assert/strict";
import test from "node:test";

import {
  buildConfirmationMessages,
  formatConfirmationSummary,
  formatDocumentSummary,
  repeatCurrentPrompt,
} from "../api/webhook.js";

function files(count) { return Array.from({ length: count }, (_, index) => ({ driveFileId: `file-${index + 1}` })); }

function singleState(documents, extraRequest = {}) {
  return {
    phone: "380000000000",
    stage: "CONFIRMATION",
    request: {
      type: "individual",
      multiPackage: false,
      data: { name: "Іван", phone: "380000000000", city: "Одеса", novaPoshtaBranch: "1", need: "Допомога" },
      documents,
      ...extraRequest,
    },
  };
}

test("single confirmation lists only uploaded categories and counts multiple photos", () => {
  const text = formatConfirmationSummary(singleState({ passport: files(1), rnokpp: files(1), military_id: files(2), ubd: files(1) }));
  assert.match(text, /📎 Документи:\n📕 Паспорт — 1 фото\n🪪 РНОКПП — 1 фото\n🎖 Військово-обліковий документ — 2 фото\n🏅 УБД — 1 фото/);
  assert.doesNotMatch(text, /Документів отримано/);
});

test("an absent optional UBD category is omitted", () => {
  const text = formatDocumentSummary({ passport: files(1), rnokpp: files(1), military_id: files(1), ubd: [] });
  assert.match(text, /📕 Паспорт — 1 фото/);
  assert.doesNotMatch(text, /УБД/);
  assert.doesNotMatch(text, /не додано/);
});

test("military confirmation shows the official letter count", () => {
  const state = {
    phone: "380000000000",
    request: {
      type: "military_unit",
      multiPackage: false,
      data: { name: "Контакт", militaryUnitNumber: "А1234", need: "Запит" },
      documents: { official_request: files(2) },
    },
  };
  assert.match(formatConfirmationSummary(state), /📎 Документи:\n📄 Офіційний лист військової частини — 2 фото/);
});

test("multi confirmation keeps document details independent for every beneficiary", () => {
  const state = {
    stage: "CONFIRMATION",
    request: {
      type: "individual",
      multiPackage: true,
      data: { name: "Заявник", phone: "380000000000", need: "Допомога", city: "Одеса", novaPoshtaBranch: "1" },
      beneficiaries: [
        { name: "Особа А", phone: "111", documents: { passport: files(2), rnokpp: files(1), military_id: files(1) } },
        { name: "Особа Б", phone: "222", documents: { passport: files(1), rnokpp: files(2), military_id: files(3), ubd: files(1) } },
      ],
    },
  };
  const messages = buildConfirmationMessages("380000000000", state);
  assert.equal(messages.length, 4);
  assert.match(messages[1], /Особа 1:[\s\S]*📕 Паспорт — 2 фото[\s\S]*🪪 РНОКПП — 1 фото[\s\S]*🎖 Військово-обліковий документ — 1 фото/);
  assert.doesNotMatch(messages[1], /УБД/);
  assert.match(messages[2], /Особа 2:[\s\S]*📕 Паспорт — 1 фото[\s\S]*🪪 РНОКПП — 2 фото[\s\S]*🎖 Військово-обліковий документ — 3 фото[\s\S]*🏅 УБД — 1 фото/);
});

test("saved documents use the same category formatter", () => {
  const state = singleState({ passport: files(2), rnokpp: files(1), military_id: files(1) }, { usingSavedData: true, savedDocumentsUpdatedAt: new Date().toISOString() });
  const text = buildConfirmationMessages("380000000000", state)[0];
  assert.match(text, /📕 Паспорт — 2 фото/);
  assert.match(text, /🪪 РНОКПП — 1 фото/);
  assert.match(text, /🎖 Військово-обліковий документ — 1 фото/);
});

test("confirmation repeated after menu recovery or editing keeps identical document details", async () => {
  const state = singleState({ passport: files(1), rnokpp: files(1), military_id: files(2) });
  const confirmations = [];
  const showConfirmation = async (from, current) => { confirmations.push(buildConfirmationMessages(from, current)); };
  await repeatCurrentPrompt("380000000000", state, { showConfirmation });
  state.request.data.city = "Київ";
  await repeatCurrentPrompt("380000000000", state, { showConfirmation });
  assert.equal(confirmations.length, 2);
  const documents = /📎 Документи:[\s\S]*?🎖 Військово-обліковий документ — 2 фото/;
  assert.match(confirmations[0][0], documents);
  assert.match(confirmations[1][0], documents);
});
