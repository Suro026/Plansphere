import { describe, expect, it } from "vitest";
import {
  BUILT_IN_FIELDS,
  answersSchema,
  cleanAnswers,
  defaultRegistrationFields,
  fieldKeyFor,
  registrationFieldsSchema,
  validateAnswers,
  visibleFields,
  type RegistrationFields,
} from "@/core/models/registration-fields";

/**
 * The dynamic registration form is data, so the tests are about the data:
 * what is asked, what is accepted, and what is thrown away.
 */

const config = (overrides: Partial<RegistrationFields> = {}): RegistrationFields =>
  registrationFieldsSchema.parse({ ...defaultRegistrationFields(), ...overrides });

describe("visibleFields", () => {
  it("never asks for the name or email — those come from the account", () => {
    const keys = visibleFields(config()).map((f) => f.key);
    expect(keys).not.toContain("fullName");
    expect(keys).not.toContain("email");
  });

  it("drops hidden fields and keeps catalogue order", () => {
    const keys = visibleFields(config()).map((f) => f.key);
    expect(keys).toEqual(["phone", "college", "department", "year"]);
  });

  it("asks nothing at all for a fest that predates the feature", () => {
    // Not the default set: an unconfigured fest must keep behaving exactly as
    // it did, or every registration already open starts failing validation.
    expect(visibleFields(undefined)).toEqual([]);
    expect(validateAnswers(undefined, {})).toEqual({});
    expect(cleanAnswers(undefined, { phone: "+919000000000" })).toEqual({});
  });

  it("appends custom questions after the built-ins, hidden ones excluded", () => {
    const fields = visibleFields(
      config({
        custom: [
          { key: "tshirt", label: "T-shirt size", type: "select", requirement: "required", options: ["S", "M", "L"] },
          { key: "notes", label: "Anything else", type: "textarea", requirement: "hidden" },
        ],
      }),
    );
    expect(fields.map((f) => f.key)).toEqual(["phone", "college", "department", "year", "tshirt"]);
    expect(fields.at(-1)).toMatchObject({ custom: true, options: ["S", "M", "L"], requirement: "required" });
  });

  it("asks for everything when every field is turned on", () => {
    const all = Object.fromEntries(BUILT_IN_FIELDS.map((key) => [key, "required" as const]));
    expect(visibleFields(config({ builtIn: all })).length).toBe(BUILT_IN_FIELDS.length - 2);
  });
});

describe("validateAnswers", () => {
  it("reports every missing required field at once, not just the first", () => {
    const problems = validateAnswers(config(), {});
    expect(Object.keys(problems).sort()).toEqual(["college", "phone"]);
    expect(problems.phone).toContain("required");
  });

  it("lets an optional field be blank but still checks it when filled", () => {
    const fields = config({
      builtIn: { ...defaultRegistrationFields().builtIn, phone: "hidden", college: "hidden" },
      custom: [{ key: "site", label: "Portfolio", type: "url", requirement: "optional" }],
    });
    expect(validateAnswers(fields, {})).toEqual({});
    expect(validateAnswers(fields, { site: "not-a-url" }).site).toContain("https://");
    expect(validateAnswers(fields, { site: "https://x.test/me" })).toEqual({});
  });

  it("refuses a value that is not one of the listed choices", () => {
    const fields = config({ custom: [{ key: "size", label: "Size", type: "select", requirement: "required", options: ["S", "M"] }] });
    expect(validateAnswers(fields, { phone: "+919000000000", college: "SRM", size: "XL" }).size).toContain("listed options");
    expect(validateAnswers(fields, { phone: "+919000000000", college: "SRM", size: "M" })).toEqual({});
  });

  it("treats whitespace as missing", () => {
    expect(validateAnswers(config(), { phone: "   ", college: "SRM" }).phone).toBeDefined();
  });

  it("checks a number field is a number", () => {
    const fields = config({ custom: [{ key: "age", label: "Age", type: "number", requirement: "required" }] });
    expect(validateAnswers(fields, { phone: "+919000000000", college: "SRM", age: "twenty" }).age).toContain("number");
    expect(validateAnswers(fields, { phone: "+919000000000", college: "SRM", age: "20" })).toEqual({});
  });
});

describe("cleanAnswers", () => {
  it("drops unknown keys, hidden fields and blanks, and trims the rest", () => {
    const cleaned = cleanAnswers(config(), {
      phone: "  +91 90000 00000  ",
      college: "SRM",
      department: "",
      github: "https://github.com/x", // hidden by default
      injected: "nope",
    });
    expect(cleaned).toEqual({ phone: "+91 90000 00000", college: "SRM" });
  });

  it("caps a long answer rather than rejecting the registration", () => {
    const fields = config({ custom: [{ key: "why", label: "Why", type: "textarea", requirement: "optional" }] });
    const cleaned = cleanAnswers(fields, { why: "x".repeat(5000) });
    expect(cleaned.why?.length).toBe(2000);
  });
});

describe("fieldKeyFor", () => {
  it("makes a stable, storable key out of a label", () => {
    expect(fieldKeyFor("T-shirt size")).toBe("t_shirt_size");
    expect(fieldKeyFor("  Hostel / Day scholar ")).toBe("hostel_day_scholar");
    expect(fieldKeyFor("2nd choice")).toBe("f2nd_choice");
    expect(fieldKeyFor("!!!")).toBe("field");
  });
});

describe("the stored shape", () => {
  it("accepts an empty configuration and fills the defaults", () => {
    expect(registrationFieldsSchema.parse({})).toEqual({ builtIn: {}, custom: [] });
  });

  it("refuses an answer map with a key longer than a field key can be", () => {
    expect(answersSchema.safeParse({ ["x".repeat(41)]: "y" }).success).toBe(false);
    expect(answersSchema.safeParse({ ok: "y" }).success).toBe(true);
  });
});
