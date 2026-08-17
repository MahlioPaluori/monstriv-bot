import { getDriveRootFolder } from "./lib/google-drive.js";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method Not Allowed" });
  }

  try {
    const folder = await getDriveRootFolder();
    return res.status(200).json({
      success: true,
      folder: {
        id: folder.id,
        name: folder.name,
        mimeType: folder.mimeType,
        trashed: folder.trashed,
      },
    });
  } catch (error) {
    console.error("Google Drive test error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Google Drive request failed",
    });
  }
}
