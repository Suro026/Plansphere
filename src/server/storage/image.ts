import sharp, { type Metadata } from "sharp";
import { ApiError } from "../errors";

/**
 * Image validation and processing — the part of the upload pipeline that
 * has nothing to do with where the bytes end up. Nothing about an incoming
 * file is trusted:
 *
 *   - the type comes from the bytes (magic numbers), never from the filename
 *     or the declared Content-Type; anything not on the allow list is
 *     refused, including SVG (scriptable), HTML, executables and archives
 *   - images are decoded and re-encoded by sharp: EXIF/GPS/XMP/ICC metadata
 *     is dropped, dimensions are bounded, and a file that is a valid image
 *     *and* something else (a polyglot) comes out as only an image
 *   - transparency is preserved (`png()`/`webp()` never flatten an alpha
 *     channel; only the JPEG path can't have one, because the format itself
 *     doesn't support it)
 */

export type DetectedImage = "image/png" | "image/jpeg" | "image/webp" | "image/gif";
export type DetectedType = DetectedImage | "application/pdf";

export const EXTENSION: Record<DetectedType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "application/pdf": "pdf",
};

const startsWith = (buf: Uint8Array, bytes: number[], offset = 0) => bytes.every((b, i) => buf[offset + i] === b);

/**
 * Magic-number sniffing for the handful of types we accept. Returns null for
 * everything else — which is the safe answer for an EXE, an SVG, an HTML
 * file with an image extension, or an empty body.
 */
export const sniffType = (buf: Uint8Array): DetectedType | null => {
  if (buf.length < 12) return null;
  if (startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(buf, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(buf, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) return "image/gif";
  if (startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  if (startsWith(buf, [0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf";
  return null;
};

/** Types we will never store, named so the refusal can say why — the anti-MIME-spoofing message. */
export const describeRejectedType = (buf: Uint8Array, declared: string | null): string => {
  const head = Buffer.from(buf.subarray(0, 512)).toString("latin1");
  if (startsWith(buf, [0x4d, 0x5a])) return "Windows executables are not accepted.";
  if (startsWith(buf, [0x7f, 0x45, 0x4c, 0x46])) return "Executables are not accepted.";
  if (startsWith(buf, [0x50, 0x4b, 0x03, 0x04])) return "Archives and Office documents are not accepted.";
  if (/^\s*<\?xml|<svg[\s>]/i.test(head)) return "SVG files are not accepted — export as PNG or JPEG.";
  if (/<!doctype html|<html[\s>]|<script[\s>]/i.test(head)) return "HTML is not accepted.";
  if (head.startsWith("#!") || /^<\?php/i.test(head)) return "Scripts are not accepted.";
  return declared ? `"${declared}" is not an accepted image type. Use PNG, JPEG or WebP.` : "That file is not a PNG, JPEG or WebP image.";
};

export interface ProcessedImage {
  bytes: Buffer;
  contentType: DetectedImage;
  width: number;
  height: number;
  /** True when the decoded image carried EXIF/XMP/ICC that was dropped. */
  strippedMetadata: boolean;
}

/**
 * Decode → bound → re-encode. The output carries no EXIF, XMP, IPTC or GPS
 * (sharp omits metadata unless `withMetadata()` is called), is auto-rotated
 * first so the orientation survives without the tag, and is at most
 * `maxDimension` on its longest side. PNG and WebP output keep any alpha
 * channel the source had; only the JPEG path — a format with no
 * transparency of its own — cannot preserve one. Animated GIFs are
 * flattened to their first frame; animation is not a feature the app uses
 * and the flattening removes another class of parser trouble.
 */
export const processImage = async (input: Buffer, type: DetectedImage, maxDimension: number): Promise<ProcessedImage> => {
  let meta: Metadata;
  try {
    meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  } catch {
    throw ApiError.unprocessable("That image could not be read. Try exporting it again as PNG or JPEG.");
  }
  if (!meta.width || !meta.height) throw ApiError.unprocessable("That image has no dimensions.");
  if (meta.width < 16 || meta.height < 16) throw ApiError.unprocessable("That image is too small to use.");

  const pipeline = sharp(input, { limitInputPixels: 40_000_000, pages: 1 })
    .rotate() // apply EXIF orientation, then drop the tag with the rest
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true });

  const encoded =
    type === "image/png" ? pipeline.png({ compressionLevel: 9, palette: false })
    : type === "image/webp" ? pipeline.webp({ quality: 86 })
    : type === "image/gif" ? pipeline.png({ compressionLevel: 9 }) // first frame, as PNG — keeps any transparency
    : pipeline.jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: "4:2:0" });

  const { data, info } = await encoded.toBuffer({ resolveWithObject: true });
  const contentType: DetectedImage = type === "image/gif" ? "image/png" : type;
  return {
    bytes: data,
    contentType,
    width: info.width,
    height: info.height,
    strippedMetadata: Boolean(meta.exif || meta.xmp || meta.iptc || meta.icc),
  };
};

/**
 * Converts any accepted image to WebP specifically — used where the app
 * wants one predictable format on disk (the requirement is "WebP
 * conversion"; `processImage` above already defaults every *screen* image
 * kind to keeping its own encoder, since a logo re-saved as WebP can dull
 * flat colours a designer picked PNG for). Same pipeline, same metadata
 * stripping, same dimension bound — only the output codec differs.
 */
export const convertToWebp = async (input: Buffer, maxDimension: number): Promise<ProcessedImage> => {
  const meta = await sharp(input, { limitInputPixels: 40_000_000 }).metadata();
  if (!meta.width || !meta.height) throw ApiError.unprocessable("That image has no dimensions.");
  if (meta.width < 16 || meta.height < 16) throw ApiError.unprocessable("That image is too small to use.");

  const { data, info } = await sharp(input, { limitInputPixels: 40_000_000, pages: 1 })
    .rotate()
    .resize({ width: maxDimension, height: maxDimension, fit: "inside", withoutEnlargement: true })
    .webp({ quality: 86 })
    .toBuffer({ resolveWithObject: true });

  return {
    bytes: data,
    contentType: "image/webp",
    width: info.width,
    height: info.height,
    strippedMetadata: Boolean(meta.exif || meta.xmp || meta.iptc || meta.icc),
  };
};
