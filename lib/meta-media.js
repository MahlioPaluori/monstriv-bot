const GRAPH_VERSION = "v26.0";

function getToken() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is missing");
  return token;
}

export async function downloadWhatsAppMedia(mediaId) {
  const token = getToken();

  const metadataResponse = await fetch(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const metadata = await metadataResponse.json();

  if (!metadataResponse.ok || !metadata.url) {
    console.error("WhatsApp media metadata error:", JSON.stringify(metadata));
    throw new Error(metadata?.error?.message || "Failed to get WhatsApp media URL");
  }

  const fileResponse = await fetch(metadata.url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!fileResponse.ok) {
    const errorText = await fileResponse.text();
    console.error("WhatsApp media download error:", errorText);
    throw new Error(`Failed to download WhatsApp media: HTTP ${fileResponse.status}`);
  }

  const arrayBuffer = await fileResponse.arrayBuffer();
  return {
    buffer: Buffer.from(arrayBuffer),
    mimeType: metadata.mime_type || fileResponse.headers.get("content-type") || "application/octet-stream",
    fileSize: Number(metadata.file_size) || Buffer.byteLength(arrayBuffer),
  };
}
