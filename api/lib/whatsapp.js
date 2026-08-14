import { createApplicationNumber, getUserState, resetUserState } from "./state.js";

const GRAPH_VERSION = "v26.0";

function getConfig() {
  const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
  const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;

  if (!phoneNumberId || !accessToken) {
    throw new Error("WhatsApp environment variables are missing");
  }

  return { phoneNumberId, accessToken };
}

async function sendMessage(to, payload) {
  const { phoneNumberId, accessToken } = getConfig();

  const response = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${phoneNumberId}/messages`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        ...payload,
      }),
    }
  );

  const result = await response.json();

  if (!response.ok) {
    console.error("WhatsApp API error:", JSON.stringify(result));
    throw new Error(result?.error?.message || "WhatsApp API request failed");
  }

  return result;
}

export async function sendText(to, body) {
  // The confirmation text is still called by the existing webhook handler.
  // Turn that final step into the real completion message and clear the
  // temporary conversation state after the message is successfully sent.
  if (body === "Заявку підтверджено. Номер заявки буде присвоєно після реєстрації.") {
    const requestNumber = await createApplicationNumber();

    const result = await sendMessage(to, {
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: `Заявку прийнято ✅\n\nНомер вашої заявки: ${requestNumber}\n\nДалі із заявкою працюватиме оператор.`,
        },
        action: {
          buttons: [
            { type: "reply", reply: { id: "send_request", title: "📤 Нова заявка" } },
            { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
          ],
        },
      },
    });

    await resetUserState(to);
    return result;
  }

  return sendMessage(to, {
    type: "text",
    text: { body },
  });
}

export function sendMainMenu(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Оберіть, що потрібно зробити:" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "send_request", title: "📤 Відправити запит" } },
          { type: "reply", reply: { id: "operator", title: "💬 Написати оператору" } },
        ],
      },
    },
  });
}

export function sendApplicantTypeMenu(to) {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: "Хто подає запит?" },
      action: {
        buttons: [
          { type: "reply", reply: { id: "individual", title: "👤 Фізична особа" } },
          { type: "reply", reply: { id: "military_unit", title: "🏢 Військова частина" } },
        ],
      },
    },
  });
}

export function sendDocumentDone(to, documentLabel, allowSkip = false) {
  const buttons = [
    { type: "reply", reply: { id: "document_done", title: "✅ Готово" } },
  ];

  if (allowSkip) {
    buttons.push({ type: "reply", reply: { id: "document_skip", title: "⏭ Пропустити" } });
  }

  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: {
        text: `${documentLabel}\n\nФайл отримано. Якщо ви додали всі сторінки/файли цього документа, натисніть «Готово».`,
      },
      action: { buttons },
    },
  });
}

export function sendYesNoMenu(to, body, yesId = "yes", noId = "no") {
  return sendMessage(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: body },
      action: {
        buttons: [
          { type: "reply", reply: { id: yesId, title: "Так" } },
          { type: "reply", reply: { id: noId, title: "Ні" } },
        ],
      },
    },
  });
}
