import { describe, expect, it } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { pdfSafe } from "@/server/pdf-text";
import { buildTablePdf } from "@/server/export-pdf";
import { renderCertificatePdf } from "@/server/certificates/pdf";

const font = async () => (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);

describe("pdfSafe", () => {
  it("spells the rupee sign out instead of throwing", async () => {
    expect(pdfSafe(await font(), "₹100")).toBe("Rs. 100");
    expect(pdfSafe(await font(), "Winner · ₹30,000")).toBe("Winner · Rs. 30,000");
  });

  it("leaves everything WinAnsi can draw untouched", async () => {
    expect(pdfSafe(await font(), "Café — Naïve · “quoted” …")).toBe("Café — Naïve · “quoted” …");
  });

  it("replaces characters no standard font has, never throwing", async () => {
    expect(pdfSafe(await font(), "आरव 🎉 Mehta")).toBe("??? ? Mehta");
  });
});

describe("PDFs built from real-world cell text", () => {
  it("renders a registrations table with rupee prices and a non-Latin name", async () => {
    const bytes = await buildTablePdf({
      title: "CodeStorm · registrations",
      subtitle: "104 of 104 · exported",
      headers: ["Name", "Payment"],
      rows: [
        ["Pranav Kapoor", "₹100"],
        ["आरव शर्मा", "Free"],
      ],
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });

  it("renders a certificate whose name and note use characters outside WinAnsi", async () => {
    const bytes = await renderCertificatePdf({
      recipientName: "आरव शर्मा",
      type: "winner",
      eventTitle: "Hack Night ₹ edition",
      festName: "Fest",
      organizationName: "Institute",
      position: 1,
      issuedOn: new Date("2026-10-05"),
      certificateNumber: "PS-CERT-TEST",
      verifyUrl: "https://example.com/verify/PS-CERT-TEST",
      note: "Winner · ₹30,000",
    });
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
  });
});
