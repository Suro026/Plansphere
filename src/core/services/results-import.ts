import type { Registration } from "../models/registration";

/**
 * Parsing a result sheet from CSV.
 *
 * The manual-entry table and this import produce the exact same row shape,
 * because they feed the same publish path — a CSV is a faster way to fill
 * the table, not a second, less-checked way to get a result onto the site.
 * Every row is matched against the event's eligible (checked-in) entries
 * before it is accepted; a name that doesn't resolve, a duplicate position or
 * a duplicate entry is reported and dropped rather than silently guessed at.
 */

export interface ImportedRow {
  position: number;
  registrationId: string;
  note: string;
}

export interface ImportResult {
  rows: ImportedRow[];
  /** One message per rejected line, in the order they were read. */
  errors: string[];
}

/** Splits one CSV line, honouring double-quoted fields with embedded commas. */
const splitCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((v) => v.trim());
};

/**
 * Resolves one CSV cell to an eligible entry: a registration id, a ticket
 * code, a team name or a leader's name, in that order of confidence.
 */
const resolve = (needle: string, eligible: readonly Registration[]): Registration | undefined => {
  const term = needle.trim().toLowerCase();
  if (!term) return undefined;
  return (
    eligible.find((e) => e.id.toLowerCase() === term) ??
    eligible.find((e) => e.ticketCode.toLowerCase() === term) ??
    eligible.find((e) => e.teamName?.toLowerCase() === term) ??
    eligible.find((e) => e.userName.toLowerCase() === term)
  );
};

/**
 * Parses a result sheet CSV: `position,entry,note` per line, an optional
 * header row (detected and skipped if its first cell is not a number), one
 * blank-tolerant pass. `entry` may be a registration id, a ticket code, a
 * team name or a leader's name — whatever the coordinator has on hand.
 */
export const parseResultsCsv = (csv: string, eligible: readonly Registration[]): ImportResult => {
  const lines = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const rows: ImportedRow[] = [];
  const errors: string[] = [];
  const usedPositions = new Set<number>();
  const usedRegistrations = new Set<string>();

  const dataLines = lines.length > 0 && Number.isNaN(Number(splitCsvLine(lines[0]!)[0])) ? lines.slice(1) : lines;

  dataLines.forEach((line, index) => {
    const lineNo = index + 1;
    const [posText, entryText, noteText] = splitCsvLine(line);

    const position = Number(posText);
    if (!posText || !Number.isInteger(position) || position < 1) {
      errors.push(`Line ${lineNo}: "${posText ?? ""}" is not a valid position.`);
      return;
    }
    if (usedPositions.has(position)) {
      errors.push(`Line ${lineNo}: position ${position} is already used in this sheet.`);
      return;
    }

    if (!entryText) {
      errors.push(`Line ${lineNo}: no entry named for position ${position}.`);
      return;
    }

    const match = resolve(entryText, eligible);
    if (!match) {
      errors.push(`Line ${lineNo}: "${entryText}" doesn't match a checked-in entry for this event.`);
      return;
    }
    if (usedRegistrations.has(match.id)) {
      errors.push(`Line ${lineNo}: "${entryText}" is already placed elsewhere in this sheet.`);
      return;
    }

    usedPositions.add(position);
    usedRegistrations.add(match.id);
    rows.push({ position, registrationId: match.id, note: (noteText ?? "").slice(0, 500) });
  });

  rows.sort((a, b) => a.position - b.position);
  return { rows, errors };
};
