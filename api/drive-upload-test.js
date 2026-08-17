import { getOrCreateRootSubfolder, uploadBufferToDrive } from "./lib/google-drive.js";

export default async function handler(req, res) {
  if (req.method !== "GET") return res.status(405).json({ error: "Method Not Allowed" });

  try {
    const testFolder = await getOrCreateRootSubfolder("_TEST_MONSTRIV_BOT");
    const content = Buffer.from(`Monstriv Bot Drive test\n${new Date().toISOString()}\n`, "utf8");
    const file = await uploadBufferToDrive({
      buffer: content,
      name: "drive-test.txt",
      mimeType: "text/plain",
      parentId: testFolder.id,
    });

    return res.status(200).json({
      success: true,
      folder: testFolder,
      file,
    });
  } catch (error) {
    console.error("Drive upload test error:", error);
    return res.status(500).json({
      success: false,
      error: error?.message || "Google Drive upload failed",
    });
  }
}
