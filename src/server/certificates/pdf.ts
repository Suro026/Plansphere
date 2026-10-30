import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { CERTIFICATE_LABELS, type CertificateType } from "@/core/models/certificate";
import { pdfSafe } from "@/server/pdf-text";

/**
 * Renders a certificate as an A4-landscape PDF.
 *
 * Certificates are printed and framed, so unlike the app this is a light
 * page. Standard fonts only (no embedding), which keeps a 400-certificate run
 * fast and the files small. The design is deliberately restrained: the
 * recipient's name is the only large thing on the page; everything else is
 * small, precise, and includes the number a recruiter can check.
 */

export interface CertificateRenderInput {
  recipientName: string;
  type: CertificateType;
  eventTitle: string;
  festName: string;
  organizationName: string;
  teamName?: string;
  position?: number;
  issuedOn: Date;
  certificateNumber: string;
  verifyUrl: string;
  /** Optional line under the title — "Winner · ₹30,000" */
  note?: string;
  /**
   * Artwork to print on, as PNG or JPEG bytes.
   *
   * A college that has had a certificate designed wants that design, not
   * ours. When one is supplied it becomes the page — drawn edge to edge,
   * with our frame suppressed — and the text is laid over it unchanged, so
   * the name, the number and the verification link are still in the same
   * places and still say the same things. A template that fails to embed is
   * ignored rather than fatal: a certificate without its artwork beats no
   * certificate.
   */
  template?: Uint8Array;
}

const A4_LANDSCAPE: [number, number] = [841.89, 595.28];

const INK = rgb(0.086, 0.094, 0.149); // #161826
const MUTED = rgb(0.35, 0.365, 0.424); // #595d6c
const ACCENT = rgb(0.569, 0.518, 0.851); // #9184d9
const RULE = rgb(0.81, 0.83, 0.9);

const ordinal = (n: number) => {
  const s = ["th", "st", "nd", "rd"] as const;
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] ?? s[v] ?? s[0]}`;
};

export const renderCertificatePdf = async (input: CertificateRenderInput): Promise<Uint8Array> => {
  const doc = await PDFDocument.create();
  doc.setTitle(`${CERTIFICATE_LABELS[input.type]} — ${input.recipientName}`);
  doc.setAuthor(input.organizationName);
  doc.setSubject(`${input.eventTitle} · ${input.festName}`);
  doc.setCreator("Plansphere");

  const page = doc.addPage(A4_LANDSCAPE);
  const { width, height } = page.getSize();
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  // Everything below is drawn in a WinAnsi-only font, which throws on anything else
  // (a rupee sign in a prize note, a Devanagari name) — see `pdfSafe`.
  const t = (value: string) => pdfSafe(regular, value);
  const recipientName = t(input.recipientName);
  const eventTitle = t(input.eventTitle);
  const festName = t(input.festName);
  const organizationName = t(input.organizationName);
  const teamName = input.teamName ? t(input.teamName) : undefined;
  const note = input.note ? t(input.note) : undefined;
  const certificateNumber = t(input.certificateNumber);
  const verifyUrl = t(input.verifyUrl);

  const margin = 64;
  const centre = (text: string, font: typeof regular, size: number) => (width - font.widthOfTextAtSize(text, size)) / 2;

  let onTemplate = false;
  if (input.template && input.template.length > 0) {
    try {
      const bytes = input.template;
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const image = isPng ? await doc.embedPng(bytes) : await doc.embedJpg(bytes);
      // Cover the page, centred: a template drawn to a different aspect ratio
      // would letterbox, and a certificate with white bars is not printable.
      const scale = Math.max(width / image.width, height / image.height);
      page.drawImage(image, {
        x: (width - image.width * scale) / 2,
        y: (height - image.height * scale) / 2,
        width: image.width * scale,
        height: image.height * scale,
      });
      onTemplate = true;
    } catch (error) {
      console.warn("[certificates] template could not be embedded:", (error as Error).message);
    }
  }

  // Frame: a hairline border and one accent rule — the system's "accent as a line".
  // Suppressed on a template, which brings its own.
  if (!onTemplate) {
    page.drawRectangle({ x: 28, y: 28, width: width - 56, height: height - 56, borderColor: RULE, borderWidth: 1 });
    page.drawRectangle({ x: margin, y: height - 92, width: 56, height: 3, color: ACCENT });
  }

  // Issuer kicker.
  const kicker = t(`${festName.toUpperCase()}  ·  ${organizationName.toUpperCase()}`);
  page.drawText(kicker, { x: margin, y: height - 80, size: 9, font: regular, color: MUTED });

  // Title.
  const title = CERTIFICATE_LABELS[input.type].toUpperCase();
  page.drawText(title, { x: margin, y: height - 140, size: 13, font: regular, color: MUTED });

  // "This certifies that"
  page.drawText("This is to certify that", { x: margin, y: height - 190, size: 12, font: regular, color: MUTED });

  // Recipient — the one large element. Shrink to fit if the name is long.
  let nameSize = 44;
  while (bold.widthOfTextAtSize(recipientName, nameSize) > width - margin * 2 && nameSize > 22) nameSize -= 2;
  page.drawText(recipientName, { x: margin, y: height - 240, size: nameSize, font: bold, color: INK });

  // Body.
  const verb = input.type === "participation" ? "participated in" : `placed ${input.position ? ordinal(input.position) : "among the winners"} in`;
  const body1 = `${verb} ${eventTitle}`;
  const body2 = `at ${festName}, organised by ${organizationName}` + (teamName ? `, as part of team ${teamName}.` : ".");
  page.drawText(body1, { x: margin, y: height - 282, size: 14, font: regular, color: INK });
  page.drawText(body2, { x: margin, y: height - 304, size: 12, font: regular, color: MUTED });
  if (note) page.drawText(note, { x: margin, y: height - 326, size: 12, font: regular, color: ACCENT });

  // Attendance line — the trust claim, stated plainly.
  page.drawText("Attendance was verified at the venue by QR scan; this certificate was issued by the organising college's account.", {
    x: margin,
    y: height - 372,
    size: 9,
    font: regular,
    color: MUTED,
  });

  // Footer: date, number, verify URL.
  const issued = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric" }).format(input.issuedOn);
  page.drawLine({ start: { x: margin, y: 108 }, end: { x: width - margin, y: 108 }, thickness: 0.75, color: RULE });
  page.drawText("ISSUED ON", { x: margin, y: 90, size: 7.5, font: regular, color: MUTED });
  page.drawText(issued, { x: margin, y: 74, size: 11, font: regular, color: INK });

  page.drawText("CERTIFICATE NO.", { x: margin + 220, y: 90, size: 7.5, font: regular, color: MUTED });
  page.drawText(certificateNumber, { x: margin + 220, y: 74, size: 11, font: bold, color: INK });

  const verifyLabel = "VERIFY AT";
  page.drawText(verifyLabel, { x: width - margin - regular.widthOfTextAtSize(verifyUrl, 10), y: 90, size: 7.5, font: regular, color: MUTED });
  page.drawText(verifyUrl, { x: width - margin - regular.widthOfTextAtSize(verifyUrl, 10), y: 74, size: 10, font: regular, color: ACCENT });

  // Wordmark, bottom centre.
  page.drawText("Plansphere", { x: centre("Plansphere", bold, 9), y: 44, size: 9, font: bold, color: MUTED });

  return doc.save();
};
