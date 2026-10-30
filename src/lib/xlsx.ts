import { zipStore } from "./zip";

/**
 * The smallest valid .xlsx: one sheet, shared strings, no styling beyond a
 * bold header row. Built directly from `zipStore` rather than a library —
 * see that file for why — because a registration export is a table, not a
 * workbook that needs formulas, multiple sheets or conditional formatting.
 */

export type CellValue = string | number | boolean | null | undefined;

const escapeXml = (text: string): string =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Column letters for a 1-based index: 1 → A, 27 → AA. */
const columnLetter = (n: number): string => {
  let s = "";
  let x = n;
  while (x > 0) {
    const rem = (x - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
};

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>`;

const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

const WORKBOOK_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>`;

const workbookXml = (sheetName: string) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets>
</workbook>`;

/** One bold style (index 1) for the header row; index 0 is the plain default. */
const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="1"><fill><patternFill patternType="none"/></fill></fills>
<borders count="1"><border/></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0"/></cellStyleXfs>
<cellXfs count="2"><xf numFmtId="0" fontId="0" xfId="0"/><xf numFmtId="0" fontId="1" xfId="0" applyFont="1"/></cellXfs>
</styleSheet>`;

/**
 * Builds a single-sheet workbook from a header row and data rows.
 *
 * Every value is written as a shared string except finite numbers, which are
 * numeric cells — that is the difference between a "phone number" a
 * spreadsheet mangles into scientific notation and one it doesn't, so a
 * caller who wants a numeric-looking string kept literal (a ticket code, a
 * phone number) should pass it as-is; only `typeof value === "number"`
 * becomes a number cell.
 */
export const buildXlsx = (sheetName: string, headers: readonly string[], rows: readonly (readonly CellValue[])[]): Uint8Array => {
  const strings: string[] = [];
  const stringIndex = new Map<string, number>();
  const sharedStringId = (value: string): number => {
    const existing = stringIndex.get(value);
    if (existing !== undefined) return existing;
    const id = strings.length;
    strings.push(value);
    stringIndex.set(value, id);
    return id;
  };

  const cellXml = (value: CellValue, colIndex: number, rowIndex: number, bold: boolean): string => {
    const ref = `${columnLetter(colIndex + 1)}${rowIndex + 1}`;
    const style = bold ? ' s="1"' : "";
    if (value === null || value === undefined || value === "") return `<c r="${ref}"${style}/>`;
    if (typeof value === "number" && Number.isFinite(value)) return `<c r="${ref}"${style}><v>${value}</v></c>`;
    const text = typeof value === "boolean" ? (value ? "TRUE" : "FALSE") : String(value);
    return `<c r="${ref}" t="s"${style}><v>${sharedStringId(text)}</v></c>`;
  };

  const headerRow = `<row r="1">${headers.map((h, i) => cellXml(h, i, 0, true)).join("")}</row>`;
  const dataRows = rows
    .map((row, r) => `<row r="${r + 2}">${row.map((v, c) => cellXml(v, c, r + 1, false)).join("")}</row>`)
    .join("");

  const sheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetData>${headerRow}${dataRows}</sheetData>
</worksheet>`;

  const sharedStringsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">
${strings.map((s) => `<si><t xml:space="preserve">${escapeXml(s)}</t></si>`).join("")}
</sst>`;

  const encoder = new TextEncoder();
  return zipStore([
    { name: "[Content_Types].xml", data: encoder.encode(CONTENT_TYPES) },
    { name: "_rels/.rels", data: encoder.encode(ROOT_RELS) },
    { name: "xl/workbook.xml", data: encoder.encode(workbookXml(sheetName)) },
    { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(WORKBOOK_RELS) },
    { name: "xl/styles.xml", data: encoder.encode(STYLES_XML) },
    { name: "xl/sharedStrings.xml", data: encoder.encode(sharedStringsXml) },
    { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheetXml) },
  ]);
};
