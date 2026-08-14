export default function handler(req, res) {
  // Перевірка Webhook від Meta
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

  // Отримання повідомлень від WhatsApp
  if (req.method === "POST") {
    console.log("WhatsApp webhook event:", JSON.stringify(req.body));

    return res.status(200).send("EVENT_RECEIVED");
  }

  return res.status(405).send("Method Not Allowed");
}
