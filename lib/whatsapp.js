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
    type: "interactive", interactive: { type: "button", body: { text: "Хто подає запит?\n\n💡 Навігація: під час заповнення заявки надішліть команду /menu, щоб відкрити меню, де можна продовжити або скасувати поточну заявку.\n\nВведені дані не видаляються, доки ви не підтвердите скасування." }, action: { buttons: [
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
      body: { text: "💬 Ви перейшли до спілкування з оператором.\n\nНапишіть своє запитання в цьому чаті.\n\nЩоб повернутися до головного меню, натисніть кнопку нижче або надішліть /menu." },
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
      body: { text: "⚠️ У вас є незавершена заявка.\n\nЩо бажаєте зробити?" },
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
      body: { text: "Скасувати незавершену заявку? Введені дані поточної заявки буде очищено." },
      action: { buttons: [
        { type: "reply", reply: { id: "confirm_cancel_request", title: "Так, скасувати" } },
        { type: "reply", reply: { id: "keep_request", title: "Назад" } },
      ] },
    },
  });
}

export function sendPackageModeMenu(to) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: "📄 Для скількох осіб потрібно подати документи?\n\nЯкщо ви оформлюєте допомогу для однієї особи, оберіть «Одна особа». Якщо ваші документи вже збережені, повторно завантажувати їх не потрібно.\n\nЯкщо допомога призначена кільком людям, оберіть «Кілька осіб». У такому разі потрібно надати окремий пакет документів для кожної людини.\n\nНаприклад, якщо ви просите 3 однакові набори допомоги для 3 різних людей, потрібно подати 3 пакети документів.\n\nВажливо: кількість одиниць допомоги сама по собі не визначає кількість пакетів документів." }, action: { buttons: [
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
      body: { text: "📄 У нас уже є ваші документи.\n\nВи також входите до числа осіб, для яких оформлюється допомога?\n\nЯкщо так, використаємо ваші збережені документи як перший пакет. Вам потрібно буде надати документи лише інших осіб." },
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
      body: { text: "Ваші збережені документи були оновлені понад рік тому. Використати їх чи завантажити новий пакет документів заявника?" },
      action: { buttons: [
        { type: "reply", reply: { id: "multi_saved_use", title: "Використати наявні" } },
        { type: "reply", reply: { id: "multi_saved_replace", title: "Новий пакет" } },
      ] },
    },
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
        { type: "reply", reply: { id: "use_saved_data", title: "Збережені дані" } },
        { type: "reply", reply: { id: "enter_data_again", title: "Ввести заново" } },
      ] },
    },
  });
}

export function sendEditMenu(to, type, multiPackage = false) {
  const rows = type === "military_unit"
    ? [
        { id: "edit_name", title: "ПІБ" },
        { id: "edit_unit_number", title: "Номер ВЧ" },
        { id: "edit_need", title: "Потребу" },
        { id: "edit_city", title: "Місто" },
        { id: "edit_np", title: "Нову пошту" },
        { id: "edit_recipient", title: "Отримувача" },
      ]
    : [
        { id: "edit_name", title: "ПІБ" },
        { id: "edit_need", title: "Потребу" },
        { id: "edit_city", title: "Місто" },
        { id: "edit_np", title: "Нову пошту" },
        { id: "edit_recipient", title: "Отримувача" },
        ...(multiPackage ? [{ id: "edit_beneficiary", title: "Дані особи" }] : []),
      ];

  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "list",
      body: { text: "Що бажаєте виправити в заявці?" },
      action: {
        button: "Обрати поле",
        sections: [{ title: "Поля заявки", rows }],
      },
    },
  });
}

export function sendOptionalDocumentPrompt(to, documentPrompt, context = null) {
  const suffix = context ? `_${context.beneficiaryIndex}_${context.documentKey}` : "";
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `${documentPrompt}\n\nПосвідчення УБД додавайте лише за наявності. Цей документ не є обов'язковим. Якщо у вас його немає або ви не хочете додавати його до заявки, натисніть «Пропустити».\n\nЯкщо додаєте документ, можна надіслати один або кілька файлів/фото. Після завантаження натисніть «Готово».`,
      },
      action: {
        buttons: [
          { type: "reply", reply: { id: `document_skip${suffix}`, title: "⏭ Пропустити" } },
        ],
      },
    },
  });
}

export async function sendDocumentDone(to, documentLabel, fileCount, allowSkip = false, context = null) {
  const suffix = context ? `_${context.beneficiaryIndex}_${context.documentKey}` : "";
  const buttons = [{ type: "reply", reply: { id: `document_done${suffix}`, title: "✅ Готово" } }];
  if (allowSkip) buttons.push({ type: "reply", reply: { id: `document_skip${suffix}`, title: "⏭ Пропустити" } });
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: `${documentLabel}\n\nФайл отримано. Усього файлів цього документа: ${fileCount}. Якщо ви додали всі сторінки/файли, натисніть «Готово».` }, action: { buttons } },
  });
}

export function sendBeneficiaryEditFieldMenu(to, beneficiaryNumber) {
  return sendMessage(to, {
    type: "interactive", interactive: { type: "button", body: { text: `Що змінити для особи ${beneficiaryNumber}?` }, action: { buttons: [
      { type: "reply", reply: { id: "edit_beneficiary_name", title: "ПІБ" } },
      { type: "reply", reply: { id: "edit_beneficiary_phone", title: "Телефон" } },
    ] } },
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
