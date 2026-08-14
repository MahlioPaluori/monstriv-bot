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

      console.log(
        "WhatsApp webhook event:",
        JSON.stringify(body)
      );

      const message =
        body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];

      // Якщо це не звичайне повідомлення користувача
      if (!message) {
        return res.status(200).send("EVENT_RECEIVED");
      }

      const from = message.from;
      const text = message.text?.body;

      console.log("From:", from);
      console.log("Text:", text);

      // Відповідаємо тільки на текстові повідомлення
      if (text) {
        const phoneNumberId =
          process.env.WHATSAPP_PHONE_NUMBER_ID;

        const accessToken =
          process.env.WHATSAPP_ACCESS_TOKEN;

        const response = await fetch(
          `https://graph.facebook.com/v26.0/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              "Authorization": `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              messaging_product: "whatsapp",
              to: from,
              type: "text",
              text: {
                body: "Вітаємо! Це тестовий бот. Повідомлення отримано ✅",
              },
            }),
          }
        );

        const result = await response.json();

        console.log(
          "WhatsApp API response:",
          JSON.stringify(result)
        );
      }

      return res.status(200).send("EVENT_RECEIVED");

    } catch (error) {
      console.error("Webhook error:", error);

      // Meta краще отримати 200, щоб не повторювала webhook нескінченно
      return res.status(200).send("EVENT_RECEIVED");
    }
  }

  return res.status(405).send("Method Not Allowed");
}
