import { claimDocumentAcknowledgement } from "./state.js";

const GRAPH_VERSION = "v26.0";

function getConfig() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) throw new Error("WhatsApp environment variables are missing");
  return { phoneNumberId, accessToken };
}

async function sendMessage(to, payload) {
  const { phoneNumberId, accessToken } = getConfig();
  const response = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
  });
  const result = await response.json();
  if (!response.ok) {
    console.error("WhatsApp API error:", JSON.stringify(result));
    throw new Error(result?.error?.message || "WhatsApp API request failed");
  }
  return result;
}

export async function sendText(to, body) {
  return sendMessage(to, { type: "text", text: { body } });
}

export function sendApplicationAccepted(to, applicationId) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Заявку прийнято ✅\n\nНомер вашої заявки: ${applicationId}\n\nДалі із заявкою працюватиме оператор.` },
      action: { buttons: [
        { type: "reply", reply: { id: "send_request", title: "📤 Нова заявка" } },
        { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
      ] },
    },
  });
}

export function sendMainMenu(to) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: "Оберіть, що потрібно зробити:" }, action: { buttons: [
      { type: "reply", reply: { id: "send_request", title: "📤 Відправити запит" } },
      { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
    ] } },
  });
}

export function sendApplicantTypeMenu(to) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: "Хто подає запит?" }, action: { buttons: [
      { type: "reply", reply: { id: "individual", title: "👤 Фізична особа" } },
      { type: "reply", reply: { id: "military_unit", title: "🏢 Військова частина" } },
    ] } },
  });
}

export function sendReturningApplicantMenu(to, lastDocumentsUpdatedAt) {
  const date = lastDocumentsUpdatedAt ? new Date(lastDocumentsUpdatedAt).toLocaleDateString("uk-UA") : "дата невідома";
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: `Для цього номера вже є збережені дані.\n\nДата останнього оновлення документів: ${date}\n\nВикористати збережені дані чи ввести їх заново?` },
      action: { buttons: [
        { type: "reply", reply: { id: "use_saved_data", title: "Використати збережені" } },
        { type: "reply", reply: { id: "enter_data_again", title: "Ввести заново" } },
      ] },
    },
  });
}

export function sendEditMenu(to, type) {
  const buttons = type === "military_unit"
    ? [
        { type: "reply", reply: { id: "edit_name", title: "ПІБ" } },
        { type: "reply", reply: { id: "edit_unit_number", title: "Номер ВЧ" } },
        { type: "reply", reply: { id: "edit_need", title: "Потребу" } },
        { type: "reply", reply: { id: "edit_city", title: "Місто" } },
        { type: "reply", reply: { id: "edit_np", title: "Нову пошту" } },
        { type: "reply", reply: { id: "edit_recipient", title: "Отримувача" } },
      ]
    : [
        { type: "reply", reply: { id: "edit_name", title: "ПІБ" } },
        { type: "reply", reply: { id: "edit_need", title: "Потребу" } },
        { type: "reply", reply: { id: "edit_city", title: "Місто" } },
        { type: "reply", reply: { id: "edit_np", title: "Нову пошту" } },
        { type: "reply", reply: { id: "edit_recipient", title: "Отримувача" } },
      ];

  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Що саме бажаєте змінити?" },
      action: { buttons },
    },
  });
}

export function sendOptionalDocumentPrompt(to, documentLabel) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `Будь ласка, надішліть ${documentLabel}.\n\nЦей документ не є обов'язковим. Якщо у вас його немає або ви не хочете додавати його до заявки, натисніть «Пропустити».\n\nЯкщо додаєте документ, можна надіслати один або кілька файлів/фото. Після завантаження натисніть «Готово».`,
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: "document_skip", title: "⏭ Пропустити" } },
        ],
      },
    },
  });
}

export async function sendDocumentDone(to, documentLabel, allowSkip = false) {
  const claimed = await claimDocumentAcknowledgement(to, documentLabel);
  if (!claimed) return null;
  const buttons = [{ type: "reply", reply: { id: "document_done", title: "✅ Готово" } }];
  if (allowSkip) buttons.push({ type: "reply", reply: { id: "document_skip", title: "⏭ Пропустити" } });
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: `${documentLabel}\n\nФайл отримано. Якщо ви додали всі сторінки/файли цього документа, натисніть «Готово».` }, action: { buttons } },
  });
}

export function sendYesNoMenu(to, body, yesId = "yes", noId = "no") {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: [
      { type: "reply", reply: { id: yesId, title: "Так" } },
      { type: "reply", reply: { id: noId, title: "Ні" } },
    ] } },
  });
}
