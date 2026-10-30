import { describe, expect, it } from "vitest";
import {
  autofill,
  autofillFor,
  profileMemoryFrom,
  profileUpdatesFrom,
  remaining,
  type ProfileMemory,
} from "@/core/services/autofill";
import {
  defaultRegistrationFields,
  registrationFieldsSchema,
  visibleFields,
  type RegistrationFields,
} from "@/core/models/registration-fields";
import { acceptedCount, holdsSeat, teamIsComplete } from "@/core/models/registration";

/**
 * The auto-fill engine's promise, stated as tests: it fills what it knows, it
 * never touches what the student typed, and it remembers what is new.
 */

const config = (overrides: Partial<RegistrationFields> = {}): RegistrationFields =>
  registrationFieldsSchema.parse({ ...defaultRegistrationFields(), ...overrides });

const profile: ProfileMemory = {
  name: "Ishita Rao",
  email: "ishita@college.edu",
  phone: "+919000000000",
  college: "SRM",
  department: "CSE",
  year: 3,
  studentId: "RA2111003",
  gender: "Female",
  city: "Chennai",
};

describe("profileMemoryFrom", () => {
  it("reads the flat document", () => {
    expect(profileMemoryFrom({ name: "A", phone: "+919000000000", college: "SRM", city: "Chennai" })).toMatchObject({
      name: "A",
      phone: "+919000000000",
      college: "SRM",
      city: "Chennai",
    });
  });

  it("reads a pre-refactor document too", () => {
    const memory = profileMemoryFrom({ fullName: "Old Name", student: { college: "VIT", department: "ECE", studentId: "19BCE" } });
    expect(memory).toMatchObject({ name: "Old Name", college: "VIT", department: "ECE", studentId: "19BCE" });
  });

  it("treats blanks and nulls as unknown, not as empty answers", () => {
    expect(profileMemoryFrom({ name: "   ", phone: null, college: undefined })).toEqual({
      name: undefined,
      email: undefined,
      phone: undefined,
      college: undefined,
      department: undefined,
      year: undefined,
      studentId: undefined,
      gender: undefined,
      city: undefined,
    });
  });

  it("is empty for a student with no profile yet", () => {
    expect(profileMemoryFrom(null)).toEqual({});
  });
});

describe("autofill", () => {
  it("fills every field the profile knows", () => {
    const result = autofillFor(config(), profile);
    expect(result.answers).toEqual({ phone: "+919000000000", college: "SRM", department: "CSE", year: "3" });
    expect(result.filled.sort()).toEqual(["college", "department", "phone", "year"]);
    expect(result.remaining).toEqual([]);
  });

  it("never overwrites a value the student has entered — including a cleared one", () => {
    const typed = { college: "A different college", phone: "" };
    const result = autofillFor(config(), profile, typed);
    expect(result.answers.college).toBe("A different college");
    expect(result.answers.phone).toBe("");
    expect(result.filled).not.toContain("college");
    expect(result.filled).not.toContain("phone");
  });

  it("is idempotent — running it again changes nothing", () => {
    const once = autofillFor(config(), profile);
    const twice = autofillFor(config(), profile, once.answers);
    expect(twice.answers).toEqual(once.answers);
    expect(twice.filled).toEqual([]);
  });

  it("only asks what the profile could not answer", () => {
    const fields = config({
      builtIn: { ...defaultRegistrationFields().builtIn, city: "required", gender: "required" },
    });
    const thin: ProfileMemory = { phone: "+919000000000", college: "SRM" };
    expect(remaining(fields, thin).map((f) => f.key)).toEqual(["department", "year", "gender", "city"]);
    // With everything known, the student is asked nothing at all.
    expect(remaining(fields, profile)).toEqual([]);
  });

  it("maps roll number onto the profile's studentId", () => {
    const fields = config({ builtIn: { rollNumber: "required" } });
    expect(autofillFor(fields, profile).answers).toEqual({ rollNumber: "RA2111003" });
  });

  it("does not fill a custom question from the profile, whatever it is called", () => {
    const fields = config({
      builtIn: {},
      custom: [{ key: "college", label: "Which college?", type: "text", requirement: "required" }],
    });
    // A custom field that happens to share a built-in's key is still custom.
    expect(autofillFor(fields, profile).answers).toEqual({});
  });

  it("skips a remembered value that is no longer an offered choice", () => {
    // The fest has narrowed "year" to 1–2 since this student last answered 3.
    // Filling it in would fail validation with nothing to explain it.
    const narrowed = visibleFields(config({ builtIn: { year: "required" } })).map((field) =>
      field.key === "year" ? { ...field, options: ["1", "2"] as const } : field,
    );
    expect(autofill(narrowed, profile).answers).toEqual({});
    expect(autofill(narrowed, { ...profile, year: 2 }).answers).toEqual({ year: "2" });
  });
});

describe("profileUpdatesFrom", () => {
  const fields = visibleFields(
    config({ builtIn: { ...defaultRegistrationFields().builtIn, city: "required", rollNumber: "optional" } }),
  );

  it("remembers what the profile did not already hold", () => {
    const updates = profileUpdatesFrom(fields, { phone: "+919000000000", college: "SRM", city: "Chennai", rollNumber: "RA1" }, {});
    expect(updates).toEqual({ phone: "+919000000000", college: "SRM", city: "Chennai", studentId: "RA1" });
  });

  it("never rewrites something the student already set", () => {
    const updates = profileUpdatesFrom(fields, { college: "Somewhere else", city: "Delhi" }, { college: "SRM" });
    expect(updates).toEqual({ city: "Delhi" });
  });

  it("stores the year as a number, and refuses a nonsense one", () => {
    expect(profileUpdatesFrom(fields, { year: "3" }, {})).toEqual({ year: 3 });
    expect(profileUpdatesFrom(fields, { year: "99" }, {})).toEqual({});
    expect(profileUpdatesFrom(fields, { year: "third" }, {})).toEqual({});
  });

  it("never writes the email — the address belongs to the account", () => {
    const withEmail = visibleFields(config({ builtIn: { email: "required" } }));
    expect(profileUpdatesFrom(withEmail, { email: "other@x.test" }, {})).toEqual({});
  });

  it("ignores custom answers and blanks", () => {
    const withCustom = visibleFields(
      config({ builtIn: { city: "required" }, custom: [{ key: "tshirt", label: "Size", type: "text", requirement: "optional" }] }),
    );
    expect(profileUpdatesFrom(withCustom, { tshirt: "M", city: "   " }, {})).toEqual({});
  });
});

describe("team state", () => {
  const leader = { isLeader: true, inviteStatus: "accepted" };
  const accepted = { isLeader: false, inviteStatus: "accepted" };
  const pending = { isLeader: false, inviteStatus: "pending" };

  it("counts the leader and anyone who accepted", () => {
    expect(acceptedCount([leader, pending, pending])).toBe(1);
    expect(acceptedCount([leader, accepted, pending])).toBe(2);
  });

  it("is complete only when the minimum have said yes", () => {
    expect(teamIsComplete([leader, pending, pending], { min: 3 })).toBe(false);
    expect(teamIsComplete([leader, accepted, accepted], { min: 3 })).toBe(true);
    expect(teamIsComplete([leader], { min: 1 })).toBe(true);
  });

  it("a draft holds a seat; a waitlisted entry does not", () => {
    expect(holdsSeat("draft")).toBe(true);
    expect(holdsSeat("confirmed")).toBe(true);
    expect(holdsSeat("waitlisted")).toBe(false);
    expect(holdsSeat("cancelled")).toBe(false);
  });
});
