import {
  createUserState,
  getUserState,
  saveUserState,
} from "./lib/state.js";
import {
  sendApplicantTypeMenu,
  sendMainMenu,
  sendText,
} from "./lib/whatsapp.js";

export default async function handler(req, res) {
  // =========================
  // GET — перевірка Webhook Meta
  // =========================
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

  // =========================
  // POST — вхідні повідомлення
  // =========================
  if (req.method === "POST") {
    try {
      const body = req.body;

      console.log("WhatsApp webhook event:", JSON.stringify(body));

      const value = body?.entry?.[0]?.changes?.[0]?.value;
      const message = value?.messages?.[0];

      // Службові події, delivery/read/status тощо.
      if (!message) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      const from = message.from;
      const text = message.text?.body?.trim() || "";
      const buttonId = message.interactive?.button_reply?.id || null;

      console.log("From:", from);
      console.log("Message type:", message.type);
      console.log("Text:", text);
      console.log("Button:", buttonId);

      // Зараз працюємо тільки з текстом та кнопками.
      // Документи/фото підключимо на наступному етапі.
      if (!text && !buttonId) {
        await sendText(
          from,
          "Будь ласка, скористайтеся кнопками меню або надішліть текстове повідомлення."
        );
        return res.status(200).send("EVENT_RECEIVED");
      }

      let state = await getUserState(from);

      // =========================
      // Перше звернення
      // =========================
      if (!state) {
        state = await createUserState(from);

        // Текст інструкції поки тимчасовий — остаточний текст погодимо окремо.
        await sendText(
          from,
          "Вітаємо! Це бот для автоматизованого оформлення запитів.\n\nСпочатку ми визначимо заявника, потім уточнимо потребу та послідовно зберемо необхідні дані й документи. Після перевірки ви підтвердите заявку, а далі нею займатиметься оператор.\n\nОберіть потрібну дію нижче."
        );

        state.stage = "MAIN_MENU";
        await saveUserState(from, state);
        await sendMainMenu(from);

        return res.status(200).send("EVENT_RECEIVED");
      }

      // =========================
      // Головне меню
      // =========================
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
        };
        await saveUserState(from, state);

        await sendApplicantTypeMenu(from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      // =========================
      // Визначення заявника
      // =========================
      if (state.stage === "APPLICANT_TYPE") {
        if (buttonId === "individual") {
          state.request.type = "individual";
          state.stage = "IDENTIFICATION";
          await saveUserState(from, state);

          await sendText(
            from,
            "Для ідентифікації заявника вкажіть, будь ласка, ваше ПІБ."
          );
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

      // =========================
      // Тимчасовий етап ідентифікації
      // =========================
      if (state.stage === "IDENTIFICATION" && text) {
        state.request.data.name = text;
        state.stage = "REQUEST_TYPE";
        await saveUserState(from, state);

        await sendText(
          from,
          "Дякую. Тепер уточнимо, який саме запит ви хочете подати.\n\nЦей етап ми зараз залишаємо текстовим — остаточний перелік варіантів та формулювання погодимо перед реалізацією наступного блоку."
        );

        return res.status(200).send("EVENT_RECEIVED");
      }

      // =========================
      // REQUEST_TYPE — поки приймаємо текст
      // =========================
      if (state.stage === "REQUEST_TYPE" && text) {
        state.request.data.need = text;
        state.stage = "DOCUMENTS";
        await saveUserState(from, state);

        await sendText(
          from,
          "Запит зафіксовано. Наступним кроком перейдемо до збору необхідних документів. Цей блок зараз підготуємо окремо."
        );

        return res.status(200).send("EVENT_RECEIVED");
      }

      // =========================
      // OPERATOR mode
      // =========================
      if (state.stage === "OPERATOR") {
        // Тут повідомлення поки не пересилаємо в окремий операторський інтерфейс.
        // Зберігаємо режим, щоб наступним етапом підключити реальне ручне спілкування.
        console.log("Operator mode message from:", from);
        return res.status(200).send("EVENT_RECEIVED");
      }

      await sendMainMenu(from);
      return res.status(200).send("EVENT_RECEIVED");
    } catch (error) {
      console.error("Webhook error:", error);

      // Meta отримує 200, щоб не створювати нескінченні повторні доставки.
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
