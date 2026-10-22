import { createHash } from "node:crypto";
import { messages } from "./messages.js";

export const MAX_MEDIA_SIZE_BYTES = 5 * 1024 * 1024;
export const MEDIA_VALIDATION_VERSION = 1;
export const SUPPORTED_MEDIA_MESSAGE = messages.documents.supportedMedia;
export const MEDIA_TOO_LARGE_MESSAGE = messages.documents.mediaTooLarge;
export const MEDIA_INVALID_MESSAGE = messages.documents.mediaInvalid;

const MIME_ALLOWLIST = new Set(["image/jpeg", "image/png", "image/heic", "image/heif", "application/pdf"]);
const MAX_IMAGE_DIMENSION = 12000;
const MAX_IMAGE_PIXELS = 40_000_000;

export class MediaValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MediaValidationError";
    this.code = code;
    this.userMessage = code === "MEDIA_TOO_LARGE"
      ? MEDIA_TOO_LARGE_MESSAGE
      : code === "UNSUPPORTED_MEDIA_TYPE"
        ? SUPPORTED_MEDIA_MESSAGE
        : MEDIA_INVALID_MESSAGE;
  }
}

export function normalizeMediaMimeType(value) {
  return String(value || "").split(";", 1)[0].trim().toLowerCase();
}

export function assertAllowedMediaMimeType(value) {
  const mimeType = normalizeMediaMimeType(value);
  if (!MIME_ALLOWLIST.has(mimeType)) throw new MediaValidationError("UNSUPPORTED_MEDIA_TYPE", `Unsupported media MIME type: ${mimeType || "missing"}`);
  return mimeType;
}

export function assertMediaSize(value, source = "media") {
  if (value === undefined || value === null || value === "") return null;
  const size = Number(value);
  if (!Number.isSafeInteger(size) || size < 0) throw new MediaValidationError("INVALID_MEDIA", `Invalid ${source} size`);
  if (size > MAX_MEDIA_SIZE_BYTES) throw new MediaValidationError("MEDIA_TOO_LARGE", `${source} exceeds the media size limit`);
  return size;
}

function assertImageDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0
    || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new MediaValidationError("INVALID_MEDIA", "Image dimensions are invalid or exceed the safety limit");
  }
  return { width, height };
}

function validateJpeg(buffer) {
  if (buffer.length < 10 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer.at(-2) !== 0xff || buffer.at(-1) !== 0xd9) {
    throw new MediaValidationError("INVALID_MEDIA", "Invalid JPEG boundaries");
  }
  let offset = 2;
  let dimensions = null;
  let foundScan = false;
  const standalone = new Set([0x01, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9]);
  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  while (offset < buffer.length - 2) {
    if (buffer[offset] !== 0xff) throw new MediaValidationError("INVALID_MEDIA", "Invalid JPEG marker");
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xda) { foundScan = true; break; }
    if (standalone.has(marker)) continue;
    if (offset + 2 > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Truncated JPEG segment");
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Invalid JPEG segment length");
    if (sofMarkers.has(marker)) {
      if (length < 7) throw new MediaValidationError("INVALID_MEDIA", "Invalid JPEG frame");
      dimensions = assertImageDimensions(buffer.readUInt16BE(offset + 3), buffer.readUInt16BE(offset + 5));
    }
    offset += length;
  }
  if (!dimensions || !foundScan) throw new MediaValidationError("INVALID_MEDIA", "JPEG frame or scan is missing");
  return { mimeType: "image/jpeg", extension: ".jpg", ...dimensions };
}

function validatePng(buffer) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buffer.length < 45 || !buffer.subarray(0, 8).equals(signature)) throw new MediaValidationError("INVALID_MEDIA", "Invalid PNG signature");
  let offset = 8;
  let dimensions = null;
  let chunkIndex = 0;
  let ended = false;
  let hasImageData = false;
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Truncated PNG chunk");
    if (chunkIndex === 0) {
      if (type !== "IHDR" || length !== 13) throw new MediaValidationError("INVALID_MEDIA", "PNG IHDR is missing");
      dimensions = assertImageDimensions(buffer.readUInt32BE(offset + 8), buffer.readUInt32BE(offset + 12));
    }
    const expectedCrc = buffer.readUInt32BE(offset + 8 + length);
    const actualCrc = crc32(buffer.subarray(offset + 4, offset + 8 + length));
    if (expectedCrc !== actualCrc) throw new MediaValidationError("INVALID_MEDIA", "PNG chunk checksum is invalid");
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") {
      if (length !== 0 || end !== buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Invalid PNG ending");
      ended = true;
      break;
    }
    offset = end;
    chunkIndex += 1;
  }
  if (!dimensions || !hasImageData || !ended) throw new MediaValidationError("INVALID_MEDIA", "PNG structure is incomplete");
  return { mimeType: "image/png", extension: ".png", ...dimensions };
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function readIsoBox(buffer, offset) {
  if (offset + 8 > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Truncated ISO BMFF box");
  let size = buffer.readUInt32BE(offset);
  const type = buffer.toString("ascii", offset + 4, offset + 8);
  let headerSize = 8;
  if (size === 1) {
    if (offset + 16 > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Truncated large ISO BMFF box");
    const largeSize = buffer.readBigUInt64BE(offset + 8);
    if (largeSize > BigInt(Number.MAX_SAFE_INTEGER)) throw new MediaValidationError("INVALID_MEDIA", "ISO BMFF box is too large");
    size = Number(largeSize);
    headerSize = 16;
  } else if (size === 0) {
    size = buffer.length - offset;
  }
  if (size < headerSize || offset + size > buffer.length) throw new MediaValidationError("INVALID_MEDIA", "Invalid ISO BMFF box size");
  return { size, type, headerSize };
}

function validateHeif(buffer) {
  let offset = 0;
  let brands = [];
  let hasMeta = false;
  let hasMediaData = false;
  while (offset < buffer.length) {
    const box = readIsoBox(buffer, offset);
    if (box.type === "ftyp") {
      if (brands.length || box.size < box.headerSize + 8) throw new MediaValidationError("INVALID_MEDIA", "Invalid HEIF ftyp box");
      const start = offset + box.headerSize;
      brands = [buffer.toString("ascii", start, start + 4)];
      for (let cursor = start + 8; cursor + 4 <= offset + box.size; cursor += 4) brands.push(buffer.toString("ascii", cursor, cursor + 4));
    } else if (box.type === "meta") hasMeta = true;
    else if (box.type === "mdat") hasMediaData = true;
    offset += box.size;
  }
  const heicBrands = new Set(["heic", "heix", "hevc", "hevx"]);
  const heifBrands = new Set(["mif1", "msf1", "heim", "heis"]);
  const isHeic = brands.some((brand) => heicBrands.has(brand));
  const isHeif = brands.some((brand) => heifBrands.has(brand));
  if ((!isHeic && !isHeif) || !hasMeta || !hasMediaData) throw new MediaValidationError("INVALID_MEDIA", "Unsupported or incomplete HEIF container");
  return isHeic
    ? { mimeType: "image/heic", extension: ".heic", brands }
    : { mimeType: "image/heif", extension: ".heif", brands };
}

function validatePdf(buffer) {
  if (buffer.length < 20 || !buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) throw new MediaValidationError("INVALID_MEDIA", "Invalid PDF header");
  const tail = buffer.subarray(Math.max(0, buffer.length - 2048)).toString("latin1");
  if (!/startxref\s+\d+\s+%%EOF\s*$/.test(tail)) throw new MediaValidationError("INVALID_MEDIA", "PDF ending is missing or invalid");
  const text = buffer.toString("latin1");
  if (!/(?:\bxref\b|\/Type\s*\/XRef\b)/.test(text)) throw new MediaValidationError("INVALID_MEDIA", "PDF cross-reference structure is missing");
  if (/\/Encrypt\b|\/JavaScript\b|\/JS\b|\/OpenAction\b|\/Launch\b|\/EmbeddedFile\b/.test(text)) {
    throw new MediaValidationError("INVALID_MEDIA", "PDF contains unsupported active or protected content");
  }
  return { mimeType: "application/pdf", extension: ".pdf" };
}

export function validateMediaBuffer(buffer, advertisedMimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new MediaValidationError("INVALID_MEDIA", "Media buffer is empty");
  assertMediaSize(buffer.length, "downloaded media");
  const advertised = assertAllowedMediaMimeType(advertisedMimeType);
  let detected;
  if (buffer[0] === 0xff && buffer[1] === 0xd8) detected = validateJpeg(buffer);
  else if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) detected = validatePng(buffer);
  else if (buffer.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) detected = validatePdf(buffer);
  else detected = validateHeif(buffer);
  const sameFamily = new Set([advertised, detected.mimeType]).size <= 2
    && advertised.startsWith("image/hei") && detected.mimeType.startsWith("image/hei");
  if (advertised !== detected.mimeType && !sameFamily) throw new MediaValidationError("INVALID_MEDIA", "Advertised MIME type does not match file content");
  return {
    version: MEDIA_VALIDATION_VERSION,
    mimeType: detected.mimeType,
    extension: detected.extension,
    size: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    ...(detected.width ? { width: detected.width, height: detected.height } : {}),
  };
}

export function isValidatedDocument(document) {
  const validation = document?.validation;
  return Boolean(validation
    && validation.version === MEDIA_VALIDATION_VERSION
    && MIME_ALLOWLIST.has(validation.mimeType)
    && Number.isSafeInteger(validation.size)
    && validation.size > 0
    && validation.size <= MAX_MEDIA_SIZE_BYTES
    && /^[a-f0-9]{64}$/.test(validation.sha256 || "")
    && [".jpg", ".png", ".heic", ".heif", ".pdf"].includes(validation.extension));
}

export function filterValidatedDocuments(documents) {
  return Object.fromEntries(Object.entries(documents || {}).map(([key, files]) => [
    key,
    Array.isArray(files) ? files.filter(isValidatedDocument) : [],
  ]).filter(([, files]) => files.length));
}
