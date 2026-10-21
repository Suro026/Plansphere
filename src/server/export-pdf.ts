import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { pdfSafe } from "./pdf-text";

/**
 * A tabular PDF — the registration export's third format.
 *
 * Not the certificate renderer's design language (this is a working sheet,
 * not something framed): landscape A4, small monospace-ish text, a header
 * row repeated on every page, and columns sized by content so a ticket code
 * and a one-word status do not take equal space. Truncates a cell rather
 * than wrapping it — a wrapped table is a table with an unpredictable number
 * of rows per page, and a coordinator scanning a printed sheet wants every
 * row to line up.
 */

const INK = rgb(0.086, 0.094, 0.149);
const MUTED = rgb(0.4, 0.42, 0.46);
const RULE = rgb(0.85, 0.86, 0.9);
const HEADER_BG = rgb(0.94, 0.94, 0.96);

const PAGE: [number, number] = [841.89, 595.28]; // A4 landscape

export const buildTablePdf = async (input: {
  title: string;
  subtitle?: string;
  headers: readonly string[];
  rows: readonly (string | number)[][];
}): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.setTitle(input.title);
  doc.setCreator("Plansphere");

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const margin = 32;
  const rowHeight = 16;
  const headerHeight = 20;
  const fontSize = 8;

  const colCount = Math.max(1, input.headers.length);
  const usableWidth = PAGE[0] - margin * 2;
  const colWidth = usableWidth / colCount;
  const maxChars = Math.max(4, Math.floor(colWidth / (fontSize * 0.52)));

  // Both fonts share the WinAnsi character set, so one font's check covers either.
  const truncate = (text: string): string => {
    const safe = pdfSafe(regular, text);
    return safe.length > maxChars ? `${safe.slice(0, maxChars - 1)}…` : safe;
  };

  let page = doc.addPage(PAGE);
  let y = PAGE[1] - margin;

  const drawTitle = () => {
    page.drawText(pdfSafe(bold, input.title), { x: margin, y, size: 13, font: bold, color: INK });
    y -= 16;
    if (input.subtitle) {
      page.drawText(pdfSafe(regular, input.subtitle), { x: margin, y, size: 9, font: regular, color: MUTED });
      y -= 14;
    }
    y -= 4;
  };

  const drawHeaderRow = () => {
    page.drawRectangle({ x: margin, y: y - headerHeight + 4, width: usableWidth, height: headerHeight, color: HEADER_BG });
    for (let c = 0; c < colCount; c += 1) {
      page.drawText(truncate(String(input.headers[c] ?? "")), { x: margin + c * colWidth + 3, y: y - 12, size: fontSize, font: bold, color: INK });
    }
    y -= headerHeight;
    page.drawLine({ start: { x: margin, y }, end: { x: margin + usableWidth, y }, thickness: 0.5, color: RULE });
  };

  const newPage = () => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - margin;
    drawHeaderRow();
  };

  drawTitle();
  drawHeaderRow();

  for (const row of input.rows) {
    if (y - rowHeight < margin) newPage();
    for (let c = 0; c < colCount; c += 1) {
      page.drawText(truncate(String(row[c] ?? "")), { x: margin + c * colWidth + 3, y: y - 11, size: fontSize, font: regular, color: INK });
    }
    y -= rowHeight;
  }

  if (input.rows.length === 0) {
    page.drawText("Nothing matches the current filters.", { x: margin, y: y - 11, size: fontSize, font: regular, color: MUTED });
  }

  return doc.save();
};
