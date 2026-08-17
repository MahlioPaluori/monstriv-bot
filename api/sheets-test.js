import { testCurrentMonthSpreadsheetAccess } from "./lib/google-sheets.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const result = await testCurrentMonthSpreadsheetAccess();
    return res.status(result.success ? 200 : 500).json(result);
  } catch (error) {
    console.error("Google Sheets test error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Google Sheets request failed",
    });
  }
}
