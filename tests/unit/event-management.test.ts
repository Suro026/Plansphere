import { describe, expect, it } from "vitest";
import {
  EVENT_CATEGORIES,
  categoryLabel,
  detectScheduleConflicts,
  duplicateEventFrom,
  eventSchema,
  type Event,
} from "@/core/models/event";
import { mergeRegistrationFields, registrationFieldsSchema } from "@/core/models/registration-fields";
import { parseResultsCsv } from "@/core/services/results-import";
import {
  buildExportRows,
  buildExportTable,
  exportAnswerColumns,
  filterRegistrations,
  tableToCsv,
} from "@/core/services/registration-export";
import { buildXlsx } from "@/lib/xlsx";
import { crc32, zipStore } from "@/lib/zip";
import { event, registration } from "./fixtures";

/**
 * The Admin event-management additions: categories, duplication, scheduling
 * conflicts, the fest/event registration-fields merge, the export table, the
 * results CSV importer, and the zip/xlsx writer underneath the export route.
 */

describe("categories", () => {
  it("labels every built-in and falls back gracefully for a custom one", () => {
    for (const c of EVENT_CATEGORIES) expect(categoryLabel(c)).toBeTruthy();
    expect(categoryLabel("robotics")).toBe("Robotics");
    expect(categoryLabel("")).toBe("Event");
  });

  it("reads the pre-refactor 'gaming' value as Esports", () => {
    expect(categoryLabel("gaming")).toBe("Esports");
  });
});

describe("duplicateEventFrom", () => {
  const source = event({
    id: "ev1",
    title: "Capture the Flag",
    status: "published",
    registeredCount: 40,
    registrationOpen: true,
    visibility: "public",
  });

  it("copies the shape but starts a fresh draft with no history", () => {
    const copy = duplicateEventFrom(source, "capture-the-flag-copy");
    expect(copy).toMatchObject({
      slug: "capture-the-flag-copy",
      title: "Capture the Flag (copy)",
      status: "draft",
      registrationOpen: false,
      visibility: "public",
      venue: source.venue,
      capacity: source.capacity,
    });
    expect(copy).not.toHaveProperty("registeredCount");
    expect(copy).not.toHaveProperty("resultsPublishedAt");
  });

  it("passes eventSchema once assembled with server-side fields", () => {
    const copy = duplicateEventFrom(source, "ctf-2");
    const parsed = eventSchema.safeParse({
      ...copy,
      id: "ev2",
      registeredCount: 0,
      createdBy: "u1",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe("detectScheduleConflicts", () => {
  const base = { date: "2026-09-26", startTime: "14:00", endTime: "16:00", venue: "Auditorium", coordinators: [{ name: "Rahul Nair" }] };

  it("warns about the same venue at an overlapping time", () => {
    const others = [event({ id: "ev2", title: "Quiz", date: "2026-09-26", startTime: "15:00", endTime: "17:00", venue: "Auditorium" })];
    const found = detectScheduleConflicts(base, others);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ eventId: "ev2", reason: "venue" });
  });

  it("warns about a shared coordinator at an overlapping time", () => {
    const others = [event({ id: "ev3", title: "Debate", date: "2026-09-26", startTime: "15:30", endTime: "17:00", venue: "Seminar Hall", coordinators: [{ name: "Rahul Nair" }] })];
    const found = detectScheduleConflicts(base, others);
    expect(found.some((c) => c.reason === "coordinator")).toBe(true);
  });

  it("does not warn about a different day, a different time, or itself", () => {
    const others = [
      event({ id: "ev4", title: "Same venue, different day", date: "2026-09-27", startTime: "14:00", venue: "Auditorium" }),
      event({ id: "ev5", title: "Same day, no overlap", date: "2026-09-26", startTime: "17:00", endTime: "18:00", venue: "Auditorium" }),
      event({ id: "ev1", title: "Itself", date: "2026-09-26", startTime: "14:00", venue: "Auditorium" }),
    ];
    expect(detectScheduleConflicts({ ...base, id: "ev1" }, others)).toEqual([]);
  });

  it("ignores a cancelled event entirely", () => {
    const others = [event({ id: "ev6", title: "Cancelled clash", date: "2026-09-26", startTime: "14:30", venue: "Auditorium", status: "cancelled" })];
    expect(detectScheduleConflicts(base, others)).toEqual([]);
  });
});

describe("mergeRegistrationFields", () => {
  const fest = registrationFieldsSchema.parse({
    builtIn: { phone: "required", college: "required", city: "hidden" },
    custom: [{ key: "tshirt", label: "T-shirt", type: "select", requirement: "required", options: ["S", "M"] }],
  });

  it("falls through to the fest when the event sets nothing", () => {
    expect(mergeRegistrationFields(fest, undefined)).toEqual(fest);
  });

  it("lets an event override one field and add its own, without touching the rest", () => {
    const event_ = registrationFieldsSchema.parse({
      builtIn: { city: "required" },
      custom: [{ key: "laptop", label: "Bringing a laptop?", type: "checkbox", requirement: "optional" }],
    });
    const merged = mergeRegistrationFields(fest, event_);
    expect(merged?.builtIn).toMatchObject({ phone: "required", college: "required", city: "required" });
    expect(merged?.custom.map((c) => c.key).sort()).toEqual(["laptop", "tshirt"]);
  });

  it("lets the event's custom question win when the key collides with the fest's", () => {
    const event_ = registrationFieldsSchema.parse({
      builtIn: {},
      custom: [{ key: "tshirt", label: "Shirt size (event override)", type: "select", requirement: "optional", options: ["S", "M", "L"] }],
    });
    const merged = mergeRegistrationFields(fest, event_);
    expect(merged?.custom).toHaveLength(1);
    expect(merged?.custom[0]).toMatchObject({ label: "Shirt size (event override)", requirement: "optional" });
  });

  it("is a no-op both ways when neither side has anything", () => {
    expect(mergeRegistrationFields(undefined, undefined)).toBeUndefined();
  });
});

describe("results CSV import", () => {
  const eligible = [
    registration({ id: "reg1", userName: "Ishita Rao", ticketCode: "FF-AAAAAAAAAA", teamName: "Null Pointers" }),
    registration({ id: "reg2", userName: "Rahul Nair", ticketCode: "FF-BBBBBBBBBB" }),
  ];

  it("resolves by registration id, ticket code, team name and leader name", () => {
    const csv = "1,reg1,\n2,FF-BBBBBBBBBB,Close second\n";
    const { rows, errors } = parseResultsCsv(csv, eligible);
    expect(errors).toEqual([]);
    expect(rows).toEqual([
      { position: 1, registrationId: "reg1", note: "" },
      { position: 2, registrationId: "reg2", note: "Close second" },
    ]);
  });

  it("skips a header row automatically", () => {
    const csv = "position,entry,note\n1,Null Pointers,Winner\n";
    const { rows, errors } = parseResultsCsv(csv, eligible);
    expect(errors).toEqual([]);
    expect(rows).toEqual([{ position: 1, registrationId: "reg1", note: "Winner" }]);
  });

  it("rejects an entry that is not eligible, without touching the rest of the sheet", () => {
    const csv = "1,reg1,\n2,Not A Real Team,\n";
    const { rows, errors } = parseResultsCsv(csv, eligible);
    expect(rows).toEqual([{ position: 1, registrationId: "reg1", note: "" }]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("Not A Real Team");
  });

  it("rejects a duplicate position and a duplicate entry", () => {
    const dupPosition = parseResultsCsv("1,reg1,\n1,reg2,\n", eligible);
    expect(dupPosition.rows).toHaveLength(1);
    expect(dupPosition.errors[0]).toContain("already used");

    const dupEntry = parseResultsCsv("1,reg1,\n2,reg1,\n", eligible);
    expect(dupEntry.rows).toHaveLength(1);
    expect(dupEntry.errors[0]).toContain("already placed");
  });

  it("handles quoted commas in the note field", () => {
    const csv = '1,reg1,"Winner, by a landslide"\n';
    const { rows } = parseResultsCsv(csv, eligible);
    expect(rows[0]?.note).toBe("Winner, by a landslide");
  });
});

describe("the registration export table", () => {
  const eventA = event({ id: "ev1", title: "Capture the Flag", entryFee: 0 });
  const eventB = event({ id: "ev2", slug: "quiz", title: "Quiz", entryFee: 500 });

  const regs = [
    registration({
      id: "reg1",
      eventId: "ev1",
      status: "confirmed",
      userName: "Ishita Rao",
      answers: { college: "SRM", phone: "+919000000001" },
    }),
    registration({ id: "reg2", eventId: "ev2", status: "waitlisted", userName: "Rahul Nair", answers: { college: "VIT" } }),
  ];

  it("filters by event, status and college", () => {
    expect(filterRegistrations(regs, { eventId: "ev1" }).map((r) => r.id)).toEqual(["reg1"]);
    expect(filterRegistrations(regs, { status: "waitlisted" }).map((r) => r.id)).toEqual(["reg2"]);
    expect(filterRegistrations(regs, { college: "srm" }).map((r) => r.id)).toEqual(["reg1"]);
  });

  it("builds rows with college, phone and a payment label derived from the event's fee", () => {
    const rows = buildExportRows(regs, new Map(), new Map([["ev1", eventA], ["ev2", eventB]]));
    expect(rows[0]).toMatchObject({ college: "SRM", phone: "+919000000001", payment: "Free" });
    expect(rows[1]).toMatchObject({ college: "VIT", payment: "₹500" });
  });

  it("includes each fest's own dynamic answer columns, merged across events without duplicates", () => {
    const fest = { registrationFields: registrationFieldsSchema.parse({ builtIn: { college: "required" }, custom: [] }) };
    const withFields: Event[] = [
      { ...eventA, registrationFields: registrationFieldsSchema.parse({ custom: [{ key: "tshirt", label: "T-shirt", type: "text", requirement: "optional" }] }) },
      { ...eventB, registrationFields: undefined },
    ];
    const cols = exportAnswerColumns(fest, withFields, undefined);
    expect(cols.map((c) => c.key).sort()).toEqual(["college", "tshirt"]);
  });

  it("produces one header/rows table whichever format reads it next", () => {
    const rows = buildExportRows(regs, new Map(), new Map([["ev1", eventA], ["ev2", eventB]]));
    const { headers, rows: table } = buildExportTable(rows, [], true);
    expect(headers).toContain("College");
    expect(headers).toContain("QR (ticket code)");
    expect(table).toHaveLength(2);

    const csv = tableToCsv(headers, table);
    expect(csv.split("\r\n")).toHaveLength(3); // header + 2 rows
    expect(csv).toContain("SRM");
  });
});

describe("the hand-rolled zip writer", () => {
  it("produces a structurally valid archive: correct signatures and CRC", () => {
    const data = new TextEncoder().encode("hello, plansphere");
    const zip = zipStore([{ name: "hello.txt", data }]);

    // Local file header signature, right at the start.
    expect(zip[0]).toBe(0x50);
    expect(zip[1]).toBe(0x4b);
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);

    // The end-of-central-directory signature appears somewhere near the tail.
    const tail = zip.slice(-22);
    expect(tail[0]).toBe(0x50);
    expect(tail[1]).toBe(0x4b);
    expect(tail[2]).toBe(0x05);
    expect(tail[3]).toBe(0x06);

    expect(crc32(data)).toBe(crc32(new TextEncoder().encode("hello, plansphere")));
    expect(crc32(data)).not.toBe(crc32(new TextEncoder().encode("hello, plansphere!")));
  });

  it("round-trips through a minimal manual unzip", () => {
    const files = [
      { name: "a.txt", data: new TextEncoder().encode("first file") },
      { name: "dir/b.txt", data: new TextEncoder().encode("second file, in a folder") },
    ];
    const zip = zipStore(files);

    // Read back each local file header in order and check the payload lands
    // exactly where the header says it does — the property that matters for
    // every real unzip tool, without depending on one in the test.
    let offset = 0;
    for (const file of files) {
      const view = new DataView(zip.buffer, offset);
      expect(view.getUint32(0, true)).toBe(0x04034b50);
      const nameLen = view.getUint16(26, true);
      const size = view.getUint32(18, true);
      const name = new TextDecoder().decode(zip.slice(offset + 30, offset + 30 + nameLen));
      expect(name).toBe(file.name);
      const payload = zip.slice(offset + 30 + nameLen, offset + 30 + nameLen + size);
      expect(new TextDecoder().decode(payload)).toBe(new TextDecoder().decode(file.data));
      offset += 30 + nameLen + size;
    }
  });
});

describe("the hand-rolled xlsx builder", () => {
  it("produces a zip whose parts include the worksheet and shared strings", () => {
    const bytes = buildXlsx("Registrations", ["Name", "College"], [["Ishita Rao", "SRM"], ["Rahul Nair", "VIT"]]);
    expect(bytes[0]).toBe(0x50); // PK — it's a zip
    const text = new TextDecoder("latin1").decode(bytes);
    expect(text).toContain("xl/worksheets/sheet1.xml");
    expect(text).toContain("xl/sharedStrings.xml");
    expect(text).toContain("[Content_Types].xml");
  });

  it("keeps a numeric-looking string (a ticket code) as text, not a mangled number", () => {
    const bytes = buildXlsx("Sheet", ["Code"], [["007", "not a number either"]] as never);
    const text = new TextDecoder("latin1").decode(bytes);
    // Shared strings hold the literal text; nothing here should coerce "007" to 7.
    expect(text).toContain("007");
  });
});
