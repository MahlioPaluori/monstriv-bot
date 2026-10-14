import { assertAllowedMediaMimeType, assertMediaSize, MAX_MEDIA_SIZE_BYTES, MediaValidationError, validateMediaBuffer } from "./media-validation.js";

const GRAPH_VERSION = "v26.0";

function getToken() {
  const token = process.env.WHATSAPP_ACCESS_TOKEN;
  if (!token) throw new Error("WHATSAPP_ACCESS_TOKEN is missing");
  return token;
}

async function readBoundedBody(response) {
  if (!response.body?.getReader) throw new MediaValidationError("INVALID_MEDIA", "Media response body is unavailable");
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_MEDIA_SIZE_BYTES) {
        await reader.cancel();
        throw new MediaValidationError("MEDIA_TOO_LARGE", "Streaming media exceeds the size limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

export async function downloadWhatsAppMedia(mediaId, { fetchImpl = fetch, token = getToken() } = {}) {

  const metadataResponse = await fetchImpl(
    `https://graph.facebook.com/${GRAPH_VERSION}/${mediaId}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const metadata = await metadataResponse.json();

  if (!metadataResponse.ok || !metadata.url) {
    console.error("WhatsApp media metadata error:", JSON.stringify(metadata));
    throw new Error(metadata?.error?.message || "Failed to get WhatsApp media URL");
  }

  const metadataMimeType = assertAllowedMediaMimeType(metadata.mime_type);
  const metadataSize = assertMediaSize(metadata.file_size, "metadata media");

  const fileResponse = await fetchImpl(metadata.url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!fileResponse.ok) {
    const errorText = await fileResponse.text();
    console.error("WhatsApp media download error:", errorText);
    throw new Error(`Failed to download WhatsApp media: HTTP ${fileResponse.status}`);
  }
  const responseMimeType = assertAllowedMediaMimeType(fileResponse.headers.get("content-type") || metadataMimeType);
  if (responseMimeType !== metadataMimeType
    && !(responseMimeType.startsWith("image/hei") && metadataMimeType.startsWith("image/hei"))) {
    throw new MediaValidationError("INVALID_MEDIA", "Metadata MIME type does not match download MIME type");
  }
  const contentLength = assertMediaSize(fileResponse.headers.get("content-length"), "HTTP media");
  if (metadataSize !== null && contentLength !== null && metadataSize !== contentLength) throw new MediaValidationError("INVALID_MEDIA", "Media size headers do not match");
  const buffer = await readBoundedBody(fileResponse);
  if ((metadataSize !== null && metadataSize !== buffer.length) || (contentLength !== null && contentLength !== buffer.length)) {
    throw new MediaValidationError("INVALID_MEDIA", "Downloaded media size does not match declared size");
  }
  const validation = validateMediaBuffer(buffer, metadataMimeType);
  return {
    buffer,
    mimeType: validation.mimeType,
    fileSize: buffer.length,
    extension: validation.extension,
    validation,
  };
}
