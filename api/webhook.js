import {
  claimMediaUpload,
  createApplicationNumber,
  createUserState,
  getApplicantProfile,
  getMilitaryContactProfile,
  getUserState,
  nextDocumentSequence,
  releaseMediaUploadClaim,
  resetUserState,
  saveApplicantProfile,
  saveMilitaryContactProfile,
  saveUserState,
} from "./lib/state.js";
import { downloadWhatsAppMedia } from "./lib/meta-media.js";
import { finalizeMilitaryRequestDocuments, getOrCreateApplicantFolder, uploadBufferToDrive } from "./lib/google-drive.js";
import { appendConfirmedRequest, updateMilitaryRequestDocumentLinks } from "./lib/google-sheets.js";
import {
  sendApplicationAccepted,
  sendApplicantTypeMenu,
  sendDocumentDone,
  sendEditMenu,
  sendMainMenu,
  sendOptionalDocumentPrompt,
  sendReturningApplicantMenu,
  sendText,
  sendYesNoMenu,
} from "./lib/whatsapp.js";

const PHYSICAL_DOCUMENTS = [
  { key: "passport", label: "📕 Паспорт" },
  { key: "rnokpp", label: "🪪 РНОКПП (ідентифікаційний код)" },
  { key: "military_id", label: "🎖 Військовий квиток / посвідчення" },
  { key: "ubd", label: "🏅 Посвідчення УБД", optional: true },
];
const MILITARY_UNIT_DOCUMENTS = [{ key: "official_request", label: "📄 Офіційний запит" }];

function docs(state) { return state.request?.type === "military_unit" ? MILITARY_UNIT_DOCUMENTS : PHYSICAL_DOCUMENTS; }
function currentDoc(state) { return docs(state)[state.request.documentIndex || 0] || null; }
function mediaId(message) {
  if (message.type === "image") return message.image?.id || null;
  if (message.type === "document") return message.document?.id || null;
  return null;
}
function documentsAreOlderThanYear(dateString) {
  if (!dateString) return true;
  const updated = new Date(dateString).getTime();
  if (!Number.isFinite(updated)) return true;
  return Date.now() - updated > 365 * 24 * 60 * 60 * 1000;
}
function fileExtension(message, mimeType) {
  if (message.type === "document" && message.document?.filename) {
    const match = message.document.filename.match(/\.([a-z0-9]+)$/i);
    if (match) return `.${match[1].toLowerCase()}`;
  }
  return { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "application/pdf": ".pdf" }[mimeType] || ".bin";
}

async function saveIncomingDocument(from, state, message, fileId, doc) {
  const claimed = await claimMediaUpload(from, fileId);
  if (!claimed) return false;
  try {
    const identifier = state.request.type === "military_unit" ? state.request.data.militaryUnitNumber : state.request.data.name;
    if (!identifier) throw new Error("Applicant identifier is missing for Drive folder");
    const folder = await getOrCreateApplicantFolder(state.request.type, identifier);
    const media = await downloadWhatsAppMedia(fileId);
    const sequence = await nextDocumentSequence(from, doc.key);
    const extension = fileExtension(message, media.mimeType);
    const fileName = `${doc.key}${sequence}${extension}`;
    const driveFile = await uploadBufferToDrive({ buffer: media.buffer, name: fileName, mimeType: media.mimeType, parentId: folder.id });
    if (!state.request.documents[doc.key]) state.request.documents[doc.key] = [];
    state.request.documents[doc.key].push({ mediaId: fileId, type: message.type, receivedAt: new Date().toISOString(), driveFileId: driveFile.id, driveUrl: driveFile.webViewLink || `https://drive.google.com/file/d/${driveFile.id}/view`, fileName: driveFile.name });
    await saveUserState(from, state);
    return true;
  } catch (error) {
    await releaseMediaUploadClaim(from, fileId);
    throw error;
  }
}

async function showConfirmation(from, state) {
  state.stage = "CONFIRMATION";
  await saveUserState(from, state);
  await sendText(from, summary(state));
  await sendYesNoMenu(from, "Підтвердити заявку?", "confirm_request", "edit_request");
}
async function continueAfterSavedData(from, state) {
  if (!state.request.documents || !Object.keys(state.request.documents).length) return showConfirmation(from, state);
  if (documentsAreOlderThanYear(state.request.savedDocumentsUpdatedAt)) {
    state.stage = "DOCUMENT_UPDATE_DECISION";
    await saveUserState(from, state);
    return sendYesNoMenu(from, "Ваші документи були оновлені понад рік тому. Бажаєте завантажити актуальні документи?", "update_documents_yes", "update_documents_no");
  }
  await showConfirmation(from, state);
}
async function askDocument(from, state) {
  const doc = currentDoc(state);
  if (!doc) {
    if (state.request.usingSavedData) return showConfirmation(from, state);
    state.stage = "CITY";
    await saveUserState(from, state);
    return sendText(from, "Вкажіть, будь ласка, місто, до якого потрібно оформити отримання.");
  }
  if (doc.optional) return sendOptionalDocumentPrompt(from, doc.label);
  await sendText(from, `Будь ласка, надішліть ${doc.label}.\n\nМожна надіслати один або кілька файлів/фото цього документа. Після того як усе надіслано, натисніть «Готово».`);
}
function summary(state) {
  const r = state.request || {}, d = r.data || {};
  const count = Object.values(r.documents || {}).reduce((n, files) => n + (Array.isArray(files) ? files.length : 0), 0);
  const lines = ["Перевірте, будь ласка, дані заявки:", "", `Тип заявника: ${r.type === "individual" ? "Фізична особа" : "Військова частина"}`, `ПІБ: ${d.name || "—"}`, `Телефон: ${d.phone || state.phone || "—"}`];
  if (r.type === "military_unit") lines.push(`Номер військової частини: ${d.militaryUnitNumber || "—"}`);
  lines.push(`Місто: ${d.city || "—"}`, `Відділення Нової пошти: ${d.novaPoshtaBranch || "—"}`, d.recipientAnotherPerson ? `Отримувач: ${d.recipientName || "—"}` : "Отримувач: заявник");
  if (d.recipientAnotherPerson) lines.push(`Телефон отримувача: ${d.recipientPhone || "—"}`);
  lines.push(`Документів отримано: ${count}`, "", `Потреба: ${d.need || "—"}`, "", "Якщо все правильно, підтвердіть заявку.");
  return lines.join("\n");
}
async function recipientChoice(from, state, another) {
  state.request.data.recipientAnotherPerson = another;
  if (another) {
    state.stage = "RECIPIENT_NAME";
    await saveUserState(from, state);
    return sendText(from, "Вкажіть, будь ласка, ПІБ іншого отримувача.");
  }
  await showConfirmation(from, state);
}
async function confirmRequest(from, state) {
  const request = state.request;
  let persistedConfirmationData = false;
  if (!request.applicationId) {
    request.applicationId = await createApplicationNumber();
    persistedConfirmationData = true;
  }
  if (!request.confirmedAt) {
    request.confirmedAt = new Date().toISOString();
    persistedConfirmationData = true;
  }
  if (request.sheetsRecorded !== true && request.sheetsRecorded !== false) {
    request.sheetsRecorded = false;
    persistedConfirmationData = true;
  }
  if (persistedConfirmationData) await saveUserState(from, state);

  if (!request.sheetsRecorded) {
    await appendConfirmedRequest(request, request.applicationId, request.confirmedAt);
    request.sheetsRecorded = true;
    await saveUserState(from, state);
  }

  if (request.type === "individual") await saveApplicantProfile(from, request);
  if (request.type === "military_unit") {
    request.documents.official_request = await finalizeMilitaryRequestDocuments({
      militaryUnitNumber: request.data.militaryUnitNumber,
      contactName: request.data.name,
      applicationId: request.applicationId,
      documents: request.documents.official_request,
    });
    await saveUserState(from, state);
    await updateMilitaryRequestDocumentLinks(request.applicationId, request.documents.official_request);
    await saveMilitaryContactProfile(from, request.data.name);
  }
  await sendApplicationAccepted(from, request.applicationId);
  await resetUserState(from);
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"], token = req.query["hub.verify_token"], challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === process.env.WEBHOOK_VERIFY_TOKEN) return res.status(200).send(challenge);
    return res.status(403).send("Forbidden");
  }
  if (req.method !== "POST") return res.status(405).send("Method Not Allowed");
  try {
    const value = req.body?.entry?.[0]?.changes?.[0]?.value;
    const message = value?.messages?.[0];
    if (!message) return res.status(200).send("EVENT_RECEIVED");
    const from = message.from, text = message.text?.body?.trim() || "", buttonId = message.interactive?.button_reply?.id || null, fileId = mediaId(message);

    if (["/reset", "reset"].includes(text.toLowerCase())) {
      await resetUserState(from); await sendText(from, "Тестову сесію скинуто. Починаємо заново."); await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
    }
    if (!text && !buttonId && !fileId) { await sendText(from, "Будь ласка, скористайтеся кнопками меню або надішліть текстове повідомлення чи файл."); return res.status(200).send("EVENT_RECEIVED"); }
    let state = await getUserState(from);
    if (!state) {
      state = await createUserState(from); state.request = { data: { phone: from }, documents: {}, documentIndex: 0 };
      if (buttonId === "send_request") {
        state.operatorRequested = false; state.stage = "APPLICANT_TYPE"; state.request = { type: null, data: { phone: from }, documents: {}, documentIndex: 0 }; await saveUserState(from, state);
        await sendText(from, "Вітаємо! Це бот для оформлення запитів.\n\nЗараз послідовно зберемо необхідні дані та документи."); await sendApplicantTypeMenu(from); return res.status(200).send("EVENT_RECEIVED");
      }
      if (buttonId !== "operator") {
        state.stage = "MAIN_MENU"; await saveUserState(from, state);
        await sendText(from, "Вітаємо! Це бот для автоматизованого оформлення запитів.\n\nСпочатку ми визначимо заявника, потім уточнимо потребу та послідовно зберемо необхідні дані й документи. Після перевірки ви підтвердите заявку, а далі нею займатиметься оператор.\n\nОберіть потрібну дію нижче."); await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
      }
    }
    if (buttonId === "operator") { state.operatorRequested = true; state.stage = "OPERATOR"; await saveUserState(from, state); await sendText(from, "Ваше повідомлення передано оператору. Очікуйте, будь ласка, відповіді."); return res.status(200).send("EVENT_RECEIVED"); }
    if (buttonId === "send_request") { state.operatorRequested = false; state.stage = "APPLICANT_TYPE"; state.request = { type: null, data: { phone: from }, documents: {}, documentIndex: 0 }; await saveUserState(from, state); await sendApplicantTypeMenu(from); return res.status(200).send("EVENT_RECEIVED"); }

    if (state.stage === "APPLICANT_TYPE") {
      if (buttonId === "individual" || buttonId === "military_unit") {
        state.request.type = buttonId === "individual" ? "individual" : "military_unit";
        if (buttonId === "individual") {
          const profile = await getApplicantProfile(from);
          if (profile) { state.request.profile = profile; state.stage = "RETURNING_CHOICE"; await saveUserState(from, state); await sendReturningApplicantMenu(from, profile.lastDocumentsUpdatedAt); return res.status(200).send("EVENT_RECEIVED"); }
        } else {
          const profile = await getMilitaryContactProfile(from);
          if (profile) { state.request.data.name = profile.name; state.stage = "MILITARY_UNIT_NUMBER"; await saveUserState(from, state); await sendText(from, "Вкажіть, будь ласка, номер військової частини."); return res.status(200).send("EVENT_RECEIVED"); }
        }
        state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, buttonId === "individual" ? "Для ідентифікації заявника вкажіть, будь ласка, ваше ПІБ." : "Для ідентифікації заявника вкажіть, будь ласка, ПІБ відповідальної особи.");
      } else await sendApplicantTypeMenu(from);
      return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "RETURNING_CHOICE") {
      const profile = state.request.profile;
      if (!profile) { state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, "Для ідентифікації заявника вкажіть, будь ласка, ваше ПІБ."); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "use_saved_data") { state.request.type = "individual"; state.request.data = { ...(profile.data || {}), phone: from }; state.request.documents = JSON.parse(JSON.stringify(profile.documents || {})); state.request.documentIndex = 0; state.request.savedDocumentsUpdatedAt = profile.lastDocumentsUpdatedAt; state.request.usingSavedData = true; state.stage = "REQUEST_TYPE"; await saveUserState(from, state); await sendText(from, "Збережені дані використано. Тепер напишіть, будь ласка, який саме запит ви хочете подати."); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "enter_data_again") { state.request = { type: "individual", data: { phone: from }, documents: {}, documentIndex: 0 }; state.stage = "IDENTIFICATION"; await saveUserState(from, state); await sendText(from, "Введіть, будь ласка, ПІБ заново."); return res.status(200).send("EVENT_RECEIVED"); }
      await sendReturningApplicantMenu(from, profile.lastDocumentsUpdatedAt); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "IDENTIFICATION" && text) { state.request.data.name = text; if (state.request.type === "military_unit") { state.stage = "MILITARY_UNIT_NUMBER"; await saveUserState(from, state); await sendText(from, "Вкажіть, будь ласка, номер військової частини."); } else { state.stage = "REQUEST_TYPE"; await saveUserState(from, state); await sendText(from, "Дякую. Тепер напишіть, будь ласка, який саме запит ви хочете подати."); } return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "MILITARY_UNIT_NUMBER" && text) { state.request.data.militaryUnitNumber = text; state.stage = "REQUEST_TYPE"; await saveUserState(from, state); await sendText(from, "Тепер напишіть, будь ласка, який саме запит ви хочете подати."); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "REQUEST_TYPE" && text) { state.request.data.need = text; if (state.request.usingSavedData && Object.keys(state.request.documents || {}).length) { await saveUserState(from, state); await continueAfterSavedData(from, state); } else { state.stage = "DOCUMENTS"; state.request.documentIndex = 0; await saveUserState(from, state); await askDocument(from, state); } return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "DOCUMENT_UPDATE_DECISION") { if (buttonId === "update_documents_yes") { state.request.documents = {}; state.request.documentIndex = 0; state.request.usingSavedData = false; state.stage = "DOCUMENTS"; await saveUserState(from, state); await askDocument(from, state); } else if (buttonId === "update_documents_no") await showConfirmation(from, state); else await sendYesNoMenu(from, "Ваші документи були оновлені понад рік тому. Бажаєте завантажити актуальні документи?", "update_documents_yes", "update_documents_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "DOCUMENTS") {
      const doc = currentDoc(state); if (!doc) { await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED"); }
      if (fileId) { const uploaded = await saveIncomingDocument(from, state, message, fileId, doc); if (!uploaded) return res.status(200).send("EVENT_RECEIVED"); await sendDocumentDone(from, doc.label, Boolean(doc.optional)); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "document_done") { const files = state.request.documents[doc.key] || []; if (!files.length) { await sendText(from, `Будь ласка, спочатку надішліть ${doc.label}.`); return res.status(200).send("EVENT_RECEIVED"); } state.request.documentIndex += 1; await saveUserState(from, state); await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED"); }
      if (buttonId === "document_skip" && doc.optional) { state.request.documentIndex += 1; await saveUserState(from, state); await askDocument(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    }
    if (state.stage === "CITY" && text) { state.request.data.city = text; state.stage = "NOVA_POSHTA_BRANCH"; await saveUserState(from, state); await sendText(from, "Вкажіть, будь ласка, номер або адресу відділення Нової пошти."); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "NOVA_POSHTA_BRANCH" && text) { state.request.data.novaPoshtaBranch = text; state.stage = "RECIPIENT_CHOICE"; await saveUserState(from, state); await sendYesNoMenu(from, "Чи буде отримувачем інша особа?", "recipient_other_yes", "recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_CHOICE") { if (buttonId === "recipient_other_yes") await recipientChoice(from, state, true); else if (buttonId === "recipient_other_no") await recipientChoice(from, state, false); else await sendYesNoMenu(from, "Чи буде отримувачем інша особа?", "recipient_other_yes", "recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_NAME" && text) { state.request.data.recipientName = text; state.stage = "RECIPIENT_PHONE"; await saveUserState(from, state); await sendText(from, "Вкажіть, будь ласка, номер телефону іншого отримувача."); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "RECIPIENT_PHONE" && text) { state.request.data.recipientPhone = text; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }

    if (state.stage === "CONFIRMATION" && buttonId === "edit_request") { state.stage = "EDIT_MENU"; await saveUserState(from, state); await sendEditMenu(from, state.request.type); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_MENU") {
      const prompts = { edit_name: ["name", "Введіть нове ПІБ."], edit_need: ["need", "Введіть новий опис запиту."], edit_unit_number: ["militaryUnitNumber", "Введіть новий номер військової частини."], edit_city: ["city", "Введіть нове місто."], edit_np: ["novaPoshtaBranch", "Введіть нове відділення Нової пошти."] };
      if (buttonId === "edit_recipient") { state.stage = "EDIT_RECIPIENT_CHOICE"; await saveUserState(from, state); await sendYesNoMenu(from, "Чи буде отримувачем інша особа?", "edit_recipient_other_yes", "edit_recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
      const selected = prompts[buttonId]; if (selected) { state.editField = selected[0]; state.stage = "EDIT_TEXT"; await saveUserState(from, state); await sendText(from, selected[1]); return res.status(200).send("EVENT_RECEIVED"); }
      await sendEditMenu(from, state.request.type); return res.status(200).send("EVENT_RECEIVED");
    }
    if (state.stage === "EDIT_TEXT" && text) { state.request.data[state.editField] = text; delete state.editField; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_CHOICE") { if (buttonId === "edit_recipient_other_yes") { state.request.data.recipientAnotherPerson = true; state.stage = "EDIT_RECIPIENT_NAME"; await saveUserState(from, state); await sendText(from, "Введіть нове ПІБ іншого отримувача."); } else if (buttonId === "edit_recipient_other_no") { state.request.data.recipientAnotherPerson = false; delete state.request.data.recipientName; delete state.request.data.recipientPhone; await showConfirmation(from, state); } else await sendYesNoMenu(from, "Чи буде отримувачем інша особа?", "edit_recipient_other_yes", "edit_recipient_other_no"); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_NAME" && text) { state.request.data.recipientName = text; state.stage = "EDIT_RECIPIENT_PHONE"; await saveUserState(from, state); await sendText(from, "Введіть новий номер телефону іншого отримувача."); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "EDIT_RECIPIENT_PHONE" && text) { state.request.data.recipientPhone = text; await showConfirmation(from, state); return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "CONFIRMATION") { if (buttonId === "confirm_request") { try { await confirmRequest(from, state); } catch (error) { console.error("Request confirmation error:", error); try { await sendText(from, "Не вдалося зареєструвати заявку через тимчасову технічну помилку. Будь ласка, натисніть «Підтвердити заявку» ще раз."); } catch (messageError) { console.error("Confirmation error message failed:", messageError); } } } else if (buttonId === "edit_request") { state.stage = "EDIT_MENU"; await saveUserState(from, state); await sendEditMenu(from, state.request.type); } return res.status(200).send("EVENT_RECEIVED"); }
    if (state.stage === "OPERATOR") return res.status(200).send("EVENT_RECEIVED");
    if (state.stage === "CONFIRMED") { await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED"); }
    await sendMainMenu(from); return res.status(200).send("EVENT_RECEIVED");
  } catch (error) {
    console.error("Webhook error:", error);
    return res.status(200).send("EVENT_RECEIVED");
  }
}
