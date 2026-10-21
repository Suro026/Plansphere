import type { PDFFont } from "pdf-lib";

/**
 * pdf-lib's built-in fonts (Helvetica and friends) encode WinAnsi only, and
 * `drawText` *throws* on any character outside it — one rupee sign, one
 * Devanagari name or one emoji in a cell takes down the whole document.
 * Everything a person typed (or a price we format) goes through here first.
 */

/** Characters with a sensible plain-text spelling in WinAnsi. */
const SPELLINGS: Record<string, string> = {
  "₹": "Rs. ",
  "‑": "-", // non-breaking hyphen
  "−": "-", // minus sign
  " ": " ",
  " ": " ",
};

const supportedByFont = new WeakMap<PDFFont, Set<number>>();

const codePointsOf = (font: PDFFont): Set<number> => {
  let set = supportedByFont.get(font);
  if (!set) {
    set = new Set(font.getCharacterSet());
    supportedByFont.set(font, set);
  }
  return set;
};

/** `text` with every character `font` cannot draw replaced, never throwing. */
export const pdfSafe = (font: PDFFont, text: string): string => {
  const supported = codePointsOf(font);
  let out = "";
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if (supported.has(cp)) out += ch;
    else if (SPELLINGS[ch] !== undefined) out += SPELLINGS[ch];
    else if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0x0300 && cp <= 0x036f)) continue; // joiners, variation selectors, loose accents
    else out += "?";
  }
  return out.replace(/ {2,}/g, " ");
};
