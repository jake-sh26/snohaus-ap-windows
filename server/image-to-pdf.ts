/**
 * Image -> PDF normalization for the manual upload route.
 *
 * Why: users sometimes get paper invoices in the mail and snap a photo with
 * their iPhone. Rather than asking them to "scan to PDF" first, we accept
 * any common image format on /api/invoices/upload and convert it to a single-
 * page PDF on intake. Everything downstream (LLM parser, preview, archive,
 * Drive backup, QBO attachment) keeps assuming PDF as the canonical format.
 *
 * Supported inputs:
 *   - JPEG / JPG (image/jpeg)
 *   - PNG (image/png)
 *   - HEIC / HEIF (image/heic, image/heif) - common iPhone default
 *   - GIF (first frame only) and WebP - converted to PNG via canvas? no, we
 *     accept and let pdf-lib handle them natively where possible. WebP and
 *     GIF are not natively embeddable in PDF, so we reject them with a clear
 *     message asking the user to convert to JPG/PNG first.
 *
 * The converted PDF has one page sized to the image's natural dimensions
 * (capped at US Letter). We don't re-encode JPEGs - pdf-lib embeds the
 * compressed JPEG bytes directly, so file size stays similar.
 */
import { PDFDocument } from "pdf-lib";

// Magic-byte sniffer. Don't trust client-provided MIME types - iPhones
// sometimes send "application/octet-stream" for HEIC photos.
type ImageKind = "jpeg" | "png" | "heic" | "unknown";

export function sniffImageKind(buf: Buffer): ImageKind {
  if (!buf || buf.length < 12) return "unknown";
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) return "png";
  // HEIC: bytes 4..11 contain "ftyp" then a brand like "heic", "heix",
  // "hevc", "mif1", "msf1", "heim", "heis", "hevm", "hevs". The "ftyp"
  // signature lives at offset 4.
  const ftyp = buf.slice(4, 8).toString("ascii");
  if (ftyp === "ftyp") {
    const brand = buf.slice(8, 12).toString("ascii").toLowerCase();
    if (["heic", "heix", "hevc", "mif1", "msf1", "heim", "heis", "hevm", "hevs", "heif"].includes(brand)) {
      return "heic";
    }
  }
  return "unknown";
}

export function looksLikeImage(buf: Buffer): boolean {
  return sniffImageKind(buf) !== "unknown";
}

/**
 * Convert an image buffer to a single-page PDF buffer.
 * Throws on unsupported formats with a user-readable message.
 */
export async function imageBufferToPdf(buf: Buffer, originalFilename: string): Promise<Buffer> {
  const kind = sniffImageKind(buf);
  if (kind === "unknown") {
    throw new Error(
      `${originalFilename}: not a supported image format. Use JPG, PNG, or HEIC (iPhone photos).`
    );
  }

  // For HEIC, decode to JPEG first. heic-convert is pure JS so it works in
  // the esbuild bundle with no native deps.
  let imgBuf: Buffer;
  let imgKind: "jpeg" | "png";
  if (kind === "heic") {
    // Lazy import - only loaded when an HEIC actually shows up, keeps the
    // hot path (PDFs) free of an extra ~300KB module.
    const { default: convert } = await import("heic-convert");
    const out = await convert({
      buffer: buf as any, // Buffer<ArrayBufferLike> matches Uint8Array shape heic-convert expects
      format: "JPEG",
      quality: 0.92,
    });
    imgBuf = Buffer.from(out);
    imgKind = "jpeg";
  } else {
    imgBuf = buf;
    imgKind = kind;
  }

  const pdfDoc = await PDFDocument.create();
  // Optional metadata so the AP archive shows where this came from.
  pdfDoc.setProducer("Sno-Haus AP");
  pdfDoc.setCreator("Manual upload (image \u2192 PDF)");
  pdfDoc.setTitle(originalFilename);
  pdfDoc.setCreationDate(new Date());

  const img = imgKind === "jpeg"
    ? await pdfDoc.embedJpg(imgBuf)
    : await pdfDoc.embedPng(imgBuf);

  // Cap page size at US Letter (612 x 792 pt) at 72dpi so giant photos
  // don't produce pages that exceed PDF viewer/printer limits. We scale
  // the image down to fit while preserving aspect ratio.
  const maxW = 612;
  const maxH = 792;
  let { width, height } = img;
  // pdf-lib reports image dimensions in pixels; treat as points (1pt=1px at 72dpi).
  // If image is huge, scale down proportionally.
  const scale = Math.min(maxW / width, maxH / height, 1);
  width = width * scale;
  height = height * scale;

  const page = pdfDoc.addPage([width, height]);
  page.drawImage(img, { x: 0, y: 0, width, height });

  const bytes = await pdfDoc.save();
  return Buffer.from(bytes);
}
