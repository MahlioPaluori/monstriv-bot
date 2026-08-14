import {
  createUserState,
  getUserState,
  resetUserState,
  saveUserState,
} from "./lib/state.js";
import {
  sendApplicantTypeMenu,
  sendDocumentDone,
  sendMainMenu,
  sendText,
} from "./lib/whatsapp.js";

const PHYSICAL_DOCUMENTS = [
  { key: "passport", label: "📕 Паспорт" },
  { key: "rnokpp", label: "🪪 РНОКПП (ідентифікаційний код)" },
  { key: "military_id", label: "🎖 Військовий квиток / посвідчення" },
  { key: "ubd", label: "🏅 Посвідчення УБД", optional: true },
];

const MILITARY_UNIT_DOCUMENTS = [
  { key: "official_request", label: "📄 Офіційний запит" },
];

function getDocumentList(state) {
  return state.request?.type === "military_unit"
    ? MILITARY_UNIT_DOCUMENTS
    : PHYSICAL_DOCUMENTS;
}

function currentDocument(state) {
  const list = getDocumentList(state);
  return list[state.request.documentIndex || 0] || null;
}

function getMediaId(message) {
  if (message.type === "image") return message.image?.id || null;
  if (message.type === "document") return message.document?.id || null;
  return null;
}

async function askForCurrentDocument(from, state) {
  const doc = currentDocument(state);

  if (!doc) {
    state.stage = "DOCUMENTS_COMPLETE";
    await saveUserState(from, state);
    await sendText(
      from,
      "Дякую. Необхідні документи зафіксовано. Наступним етапом продовжимо збір даних заявки."
    );
    return;
  }

  const optionalText = doc.optional
    ? "\n\nЦей документ не є обов'язковим — його можна пропустити."
    : "";

  await sendText(
    from,
    `Будь ласка, надішліть ${doc.label}.${optionalText}\n\nМожна надіслати один або кілька файлів/фото цього документа. Після того як усе надіслано, натисніть «Готово».`
  );
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    const verifyToken = process.env.WEBHOOK_VERIFY_TOKEN;

    if (mode === "subscribe" && token === verifyToken) {
      return res.status(200).send(challenge);
    }

    return res.status(403).send("Forbidden");
  }

  if (req.method === "POST") {
    try {
      const body = req.body;
      console.log("WhatsApp webhook event:", JSON.stringify(body));

      const value = body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      if (!message) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      const from = message.from;
      const text = message.text?.body?.trim() || "";
      const buttonId = message.interactive?.button_reply?.id || null;
      const mediaId = getMediaId(message);

      console.log("From:", from);
      console.log("Message type:", message.type);
      console.log("Text:", text);
      console.log("Button:", buttonId);
      console.log("Media ID:", mediaId);

      // TEST COMMAND: reset the current Redis session.
      // Remove this command before production if unrestricted reset is not desired.
      if (text.toLowerCase() === "/reset" || text.toLowerCase() === "reset") {
        await resetUserState(from);
        await sendText(from, "Тестову сесію скинуто. Починаємо заново.");
        await sendMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (!text && !buttonId && !mediaId) {
        await sendText(
          from,
          "Будь ласка, скористайтеся кнопками меню або надішліть текстове повідомлення чи файл."
        );
        return res.status(200).send("EVENT_RECEIVED");
      }

      let state = await getUserState(from);

      if (!state) {
        state = await createUserState(from);

        await sendText(
          from,
          "Вітаємо! Це бот для автоматизованого оформлення запитів.\n\nСпочатку ми визначимо заявника, потім уточнимо потребу та послідовно зберемо необхідні дані й документи. Після перевірки ви підтвердите заявку, а далі нею займатиметься оператор.\n\nОберіть потрібну дію нижче."
        );

        state.stage = "MAIN_MENU";
        await saveUserState(from, state);
        await sendMainMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (buttonId === "operator") {
        state.operatorRequested = true;
        state.stage = "OPERATOR";
        await saveUserState(from, state);

        await sendText(
          from,
          "Ваше повідомлення передано оператору. Очікуйте, будь ласка, відповіді."
        );
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (buttonId === "send_request") {
        state.operatorRequested = false;
        state.stage = "APPLICANT_TYPE";
        state.request = {
          type: null,
          data: {},
          documents: {},
          documentIndex: 0,
        };
        await saveUserState(from, state);

        await sendApplicantTypeMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (state.stage === "APPLICANT_TYPE") {
        if (buttonId === "individual") {
          state.request.type = "individual";
          state.stage = "IDENTIFICATION";
          await saveUserState(from, state);
          await sendText(from, "Для ідентифікації заявника вкажіть, будь ласка, ваше ПІБ.");
        } else if (buttonId === "military_unit") {
          state.request.type = "military_unit";
          state.stage = "IDENTIFICATION";
          await saveUserState(from, state);
          await sendText(
            from,
            "Для ідентифікації заявника вкажіть, будь ласка, ПІБ відповідальної особи."
          );
        } else {
          await sendApplicantTypeMenu(from);
        }

        return res.status(200).send("EVENT_RECEIVED");
      }

      if (state.stage === "IDENTIFICATION" && text) {
        state.request.data.name = text;
        state.stage = "REQUEST_TYPE";
        await saveUserState(from, state);

        await sendText(from, "Дякую. Тепер напишіть, будь ласка, який саме запит ви хочете подати.");
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (state.stage === "REQUEST_TYPE" && text) {
        state.request.data.need = text;
        state.stage = "DOCUMENTS";
        state.request.documentIndex = 0;
        await saveUserState(from, state);

        await askForCurrentDocument(from, state);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (state.stage === "DOCUMENTS") {
        const doc = currentDocument(state);

        if (!doc) {
          await askForCurrentDocument(from, state);
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (mediaId) {
          if (!state.request.documents[doc.key]) {
            state.request.documents[doc.key] = [];
          }

          state.request.documents[doc.key].push({
            mediaId,
            type: message.type,
            receivedAt: new Date().toISOString(),
          });

          await saveUserState(from, state);
          await sendDocumentDone(from, doc.label, Boolean(doc.optional));
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (buttonId === "document_done") {
          const files = state.request.documents[doc.key] || [];

          if (files.length === 0) {
            await sendText(from, `Будь ласка, спочатку надішліть ${doc.label}.`);
            return res.status(200).send("EVENT_RECEIVED");
          }

          state.request.documentIndex += 1;
          await saveUserState(from, state);
          await askForCurrentDocument(from, state);
          return res.status(200).send("EVENT_RECEIVED");
        }

        if (buttonId === "document_skip" && doc.optional) {
          state.request.documentIndex += 1;
          await saveUserState(from, state);
          await askForCurrentDocument(from, state);
          return res.status(200).send("EVENT_RECEIVED");
        }
      }

      if (state.stage === "OPERATOR") {
        console.log("Operator mode message from:", from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      if (state.stage === "DOCUMENTS_COMPLETE") {
        await sendText(
          from,
          "Документи вже зафіксовано. Наступним кроком продовжимо збір даних заявки."
        );
        return res.status(200).send("EVENT_RECEIVED");
      }

      await sendMainMenu(from);
      return res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
      console.error("Webhook error:", error);
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
