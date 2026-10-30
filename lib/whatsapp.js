import { messages } from "./messages.js";

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
      body: { text: messages.confirmation.accepted({ applicationId }) },
      action: { buttons: [
        { type: "reply", reply: { id: "send_request", title: "📤 Нова заявка" } },
        { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
      ] },
    },
  });
}

export function sendMainMenu(to, body = messages.welcome.mainMenu) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: [
      { type: "reply", reply: { id: "send_request", title: "📤 Відправити запит" } },
      { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
    ] } },
  });
}

export function sendApplicantTypeMenu(to, body = messages.navigation.applicantType) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: [
      { type: "reply", reply: { id: "individual", title: "👤 Фізична особа" } },
      { type: "reply", reply: { id: "military_unit", title: "🏢 Військова частина" } },
    ] } },
  });
}

export function sendOperatorMenu(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.operator.mode },
      action: { buttons: [
        { type: "reply", reply: { id: "back_to_menu", title: "Головне меню" } },
      ] },
    },
  });
}

export function sendActiveRequestNavigation(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.navigation.activeRequest },
      action: { buttons: [
        { type: "reply", reply: { id: "resume_request", title: "Продовжити заявку" } },
        { type: "reply", reply: { id: "cancel_request", title: "Скасувати заявку" } },
      ] },
    },
  });
}

export function sendCancelRequestConfirmation(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.navigation.cancelConfirmation },
      action: { buttons: [
        { type: "reply", reply: { id: "confirm_cancel_request", title: "Так, скасувати" } },
        { type: "reply", reply: { id: "keep_request", title: "Назад" } },
      ] },
    },
  });
}

export function sendPackageModeMenu(to) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: messages.multipleApplicants.packageMode }, action: { buttons: [
      { type: "reply", reply: { id: "package_single", title: "Одна особа" } },
      { type: "reply", reply: { id: "package_multi", title: "Кілька осіб" } },
    ] } },
  });
}

export function sendMultiApplicantIncludedMenu(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.multipleApplicants.applicantIncluded },
      action: { buttons: [
        { type: "reply", reply: { id: "multi_applicant_yes", title: "Так, я отримувач" } },
        { type: "reply", reply: { id: "multi_applicant_no", title: "Ні, допомога іншим" } },
      ] },
    },
  });
}

export function sendMultiSavedDocumentsMenu(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.multipleApplicants.savedDocumentsDecision },
      action: { buttons: [
        { type: "reply", reply: { id: "multi_saved_use", title: "Використати наявні" } },
        { type: "reply", reply: { id: "multi_saved_replace", title: "Новий пакет" } },
      ] },
    },
  });
}

export function sendReturningApplicantMenu(to, lastDocumentsUpdatedAt) {
  const date = lastDocumentsUpdatedAt ? new Date(lastDocumentsUpdatedAt).toLocaleDateString("uk-UA") : messages.applicant.unknownDocumentsDate;
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: messages.applicant.returning({ date }) },
      action: { buttons: [
        { type: "reply", reply: { id: "use_saved_data", title: "Збережені дані" } },
        { type: "reply", reply: { id: "enter_data_again", title: "Ввести заново" } },
      ] },
    },
  });
}

export function sendEditMenu(to, type, multiPackage = false, combinedDeliveryAddress = false) {
  const deliveryRows = combinedDeliveryAddress
    ? [{ id: "edit_city", title: "Адресу доставки" }]
    : [{ id: "edit_city", title: "Місто" }, { id: "edit_np", title: "Нову пошту" }];
  const rows = type === "military_unit"
    ? [
        { id: "edit_name", title: "ПІБ" },
        { id: "edit_unit_number", title: "Номер ВЧ" },
        { id: "edit_need", title: "Потребу" },
        ...deliveryRows,
        { id: "edit_recipient", title: "Отримувача" },
      ]
    : [
        { id: "edit_name", title: "ПІБ" },
        { id: "edit_need", title: "Потребу" },
        ...deliveryRows,
        { id: "edit_recipient", title: "Отримувача" },
        ...(multiPackage ? [{ id: "edit_beneficiary", title: "Дані особи" }] : []),
      ];

  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: messages.editing.menu },
      action: {
        button: "Обрати поле",
        sections: [{ title: "Поля заявки", rows }],
      },
    },
  });
}

export function sendDocumentPrompt(to, body, allowSkip = false, context = null) {
  const suffix = !context
    ? ""
    : context.beneficiaryIndex === null
      ? `_t${context.token}_${context.documentKey}`
      : `_t${context.token}_${context.beneficiaryIndex}_${context.documentKey}`;
  const buttons = [{ type: "reply", reply: { id: `document_done${suffix}`, title: "✅ Готово" } }];
  if (allowSkip) buttons.push({ type: "reply", reply: { id: `document_skip${suffix}`, title: "⏭ Пропустити" } });
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: { buttons },
    },
  });
}

export function sendBeneficiaryEditFieldMenu(to, beneficiaryNumber) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: messages.editing.beneficiaryField({ number: beneficiaryNumber }) }, action: { buttons: [
      { type: "reply", reply: { id: "edit_beneficiary_name", title: "ПІБ" } },
      { type: "reply", reply: { id: "edit_beneficiary_phone", title: "Телефон" } },
    ] } },
  });
}

export function sendYesNoMenu(to, body, yesId = "yes", noId = "no") {
  const noTitle = noId === "edit_request" ? "Редагувати" : "Ні";
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: body }, action: { buttons: [
      { type: "reply", reply: { id: yesId, title: "Так" } },
      { type: "reply", reply: { id: noId, title: noTitle } },
    ] } },
  });
}
