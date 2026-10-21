import type { EmailMessage } from "./types";
import { CERTIFICATE_LABELS, type CertificateType } from "@/core/models/certificate";

/**
 * Email bodies.
 *
 * Deliberately plain HTML with inline styles and a real text alternative:
 * mail clients strip stylesheets, and a certificate notice that renders as a
 * blank page is worse than one that renders as plain text. Every template
 * names itself (`template`) and what it is about (`meta`) so the delivery log
 * can be filtered without parsing subjects.
 */

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export const appUrl = (): string => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");

type Meta = NonNullable<EmailMessage["meta"]>;

const shell = (heading: string, body: string, footnote = "Plansphere · plansphere.in — sent automatically, please do not reply."): string => `
<div style="font-family:Inter,system-ui,-apple-system,'Segoe UI',sans-serif;background:#f4f4f8;padding:32px 16px;color:#1f2130">
  <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:12px;padding:32px;border:1px solid #e4e4ec">
    <div style="font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#7b7d90;margin:0 0 14px">Plansphere</div>
    <h1 style="margin:0 0 16px;font-size:21px;line-height:1.25;color:#161826;letter-spacing:-.01em">${escapeHtml(heading)}</h1>
    ${body}
    <hr style="border:none;border-top:1px solid #e4e4ec;margin:28px 0 16px" />
    <p style="margin:0;font-size:12px;color:#7b7d90">${escapeHtml(footnote)}</p>
  </div>
</div>`;

const p = (html: string) => `<p style="margin:0 0 14px;color:#374151;line-height:1.55">${html}</p>`;
const small = (html: string) => `<p style="margin:14px 0 0;font-size:13px;color:#6b7280;line-height:1.5">${html}</p>`;

const button = (href: string, label: string): string => `
  <p style="margin:22px 0 6px">
    <a href="${escapeHtml(href)}"
       style="display:inline-block;background:#5b4fcf;color:#ffffff;text-decoration:none;
              padding:12px 20px;border-radius:8px;font-weight:600;font-size:14px">${escapeHtml(label)}</a>
  </p>
  <p style="margin:0 0 6px;font-size:12px;color:#9a9cad;word-break:break-all">${escapeHtml(href)}</p>`;

const rows = (items: Array<[string, string | undefined]>): string => `
  <table style="border-collapse:collapse;margin:6px 0 4px">
    ${items
      .filter((item): item is [string, string] => Boolean(item[1]))
      .map(
        ([label, value]) => `
    <tr>
      <td style="padding:5px 14px 5px 0;color:#6b7280;font-size:13px;vertical-align:top;white-space:nowrap">${escapeHtml(label)}</td>
      <td style="padding:5px 0;color:#111827;font-size:13px;font-weight:600">${escapeHtml(value)}</td>
    </tr>`,
      )
      .join("")}
  </table>`;

const textRows = (items: Array<[string, string | undefined]>): string[] =>
  items.filter((item): item is [string, string] => Boolean(item[1])).map(([label, value]) => `${label.padEnd(9)} ${value}`);

const signoff = ["", "— Plansphere · plansphere.in"];

/* ═══════════════════════════ 1. Registration confirmation ═══════════════════════════ */

export const registrationConfirmedEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  date: string;
  startTime: string;
  venue: string;
  ticketCode: string;
  teamName?: string;
  registrationId: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/registered/${input.registrationId}`;
  const details: Array<[string, string | undefined]> = [
    ["Event", input.eventTitle],
    ["Fest", input.festName],
    ["Date", `${input.date} at ${input.startTime}`],
    ["Venue", input.venue],
    ["Team", input.teamName],
    ["Ticket", input.ticketCode],
  ];

  const text = [
    `Hello ${input.recipientName},`,
    "",
    `You're registered for "${input.eventTitle}" at ${input.festName}.`,
    "",
    ...textRows(details),
    "",
    "Your QR pass is in the app and works with no signal at the gate:",
    link,
    ...signoff,
  ].join("\n");

  const html = shell(
    "You're in",
    p(`Hello ${escapeHtml(input.recipientName)}, you're registered for <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)}.`) +
      rows(details) +
      button(link, "Open your pass") +
      small("The pass works offline once opened once. Show the QR at the gate; nobody needs to print anything."),
  );

  return { to: input.to, subject: `You're in — ${input.eventTitle}`, text, html, template: "registration_confirmed", meta: input.meta };
};

/* ═══════════════════════════ 2. Team invitation ═══════════════════════════ */

export const teamInviteEmail = (input: {
  to: string;
  recipientName: string;
  leaderName: string;
  teamName: string;
  eventTitle: string;
  festName: string;
  date: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/teams`;

  const text = [
    `Hello ${input.recipientName},`,
    "",
    `${input.leaderName} added you to team "${input.teamName}" for "${input.eventTitle}" at ${input.festName} (${input.date}).`,
    "",
    "Accept or decline from your Teams page:",
    link,
    "",
    `Sign in — or create an account — with this address (${input.to}) so the entry is linked to you.`,
    ...signoff,
  ].join("\n");

  const html = shell(
    "You've been added to a team",
    p(`Hello ${escapeHtml(input.recipientName)}, <strong>${escapeHtml(input.leaderName)}</strong> added you to team <strong>${escapeHtml(input.teamName)}</strong> for <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)} on ${escapeHtml(input.date)}.`) +
      p("A seat is held for you until you answer. Accept to put the event on your pass; decline to free the seat.") +
      button(link, "Respond to the invitation") +
      small(`Sign in — or create an account — with <strong>${escapeHtml(input.to)}</strong> so the entry is linked to you.`),
  );

  return { to: input.to, subject: `${input.leaderName} added you to ${input.teamName} — ${input.eventTitle}`, text, html, template: "team_invite", meta: input.meta };
};

/* ═══════════════════════════ 3. Team update ═══════════════════════════ */

export const teamUpdateEmail = (input: {
  to: string;
  recipientName: string;
  teamName: string;
  eventTitle: string;
  change: "accepted" | "declined" | "removed" | "renamed";
  memberName?: string;
  newName?: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/teams`;
  const line =
    input.change === "accepted" ? `${input.memberName} accepted the invitation and is now on ${input.teamName}.`
    : input.change === "declined" ? `${input.memberName} declined to join ${input.teamName}. Their seat was released — add a replacement from your Teams page.`
    : input.change === "removed" ? `You were removed from team ${input.teamName} for ${input.eventTitle}. The event is no longer on your pass.`
    : `Your team for ${input.eventTitle} is now called "${input.newName}".`;
  const heading =
    input.change === "accepted" ? `${input.memberName} joined your team`
    : input.change === "declined" ? `${input.memberName} declined`
    : input.change === "removed" ? `You were removed from ${input.teamName}`
    : "Your team was renamed";

  const text = [`Hello ${input.recipientName},`, "", line, "", link, ...signoff].join("\n");
  const html = shell("Team update — " + input.eventTitle, p(`Hello ${escapeHtml(input.recipientName)},`) + p(escapeHtml(line)) + button(link, "Open Teams"));

  return { to: input.to, subject: `${heading} — ${input.eventTitle}`, text, html, template: "team_update", meta: input.meta };
};

/* ═══════════════════════════ 4. Waitlist promotion ═══════════════════════════ */

/**
 * A seat opened up on a **paid** event. Unlike `waitlistPromotedEmail` this is
 * not a confirmation: the entry holds a seat only until `holdMinutes` pass, and
 * becomes a ticket when the payment is verified.
 */
export const paymentDueEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  amountLabel: string;
  holdMinutes: number;
  teamName?: string;
  registrationId: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/registered/${input.registrationId}`;
  const details: Array<[string, string | undefined]> = [
    ["Event", input.eventTitle],
    ["Fest", input.festName],
    ["Team", input.teamName],
    ["Amount", input.amountLabel],
  ];
  const text = [
    `Hello ${input.recipientName},`,
    "",
    `A seat opened up for "${input.eventTitle}" at ${input.festName}. It is held for you for ${input.holdMinutes} minutes — pay to confirm it.`,
    "",
    ...textRows(details),
    "",
    "Complete your payment:",
    link,
    ...signoff,
  ].join("\n");
  const html = shell(
    "A seat opened up — pay to confirm it",
    p(`Hello ${escapeHtml(input.recipientName)}, a seat opened up for <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)}. It is held for you for <strong>${input.holdMinutes} minutes</strong>; your ticket is issued once the payment is verified.`) +
      rows(details) +
      button(link, "Complete payment"),
  );
  return { to: input.to, subject: `Pay to confirm your seat — ${input.eventTitle}`, text, html, template: "payment_due", meta: input.meta };
};

export const waitlistPromotedEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  date: string;
  startTime: string;
  venue: string;
  ticketCode: string;
  teamName?: string;
  registrationId: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/registered/${input.registrationId}`;
  const details: Array<[string, string | undefined]> = [
    ["Event", input.eventTitle],
    ["Fest", input.festName],
    ["Date", `${input.date} at ${input.startTime}`],
    ["Venue", input.venue],
    ["Team", input.teamName],
    ["Ticket", input.ticketCode],
  ];
  const text = [
    `Hello ${input.recipientName},`,
    "",
    `A seat opened up: ${input.teamName ? `team ${input.teamName} is` : "you're"} now confirmed for "${input.eventTitle}" at ${input.festName}.`,
    "",
    ...textRows(details),
    "",
    "Your pass is ready:",
    link,
    ...signoff,
  ].join("\n");
  const html = shell(
    "A seat opened up — you're in",
    p(`Hello ${escapeHtml(input.recipientName)}, ${input.teamName ? `team <strong>${escapeHtml(input.teamName)}</strong> is` : "you're"} now <strong>confirmed</strong> for <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)}. You were on the waitlist; someone withdrew.`) +
      rows(details) +
      button(link, "Open your pass"),
  );
  return { to: input.to, subject: `You're off the waitlist — ${input.eventTitle}`, text, html, template: "waitlist_promoted", meta: input.meta };
};

/* ═══════════════════════════ 5. Certificate issued ═══════════════════════════ */

export const certificateIssuedEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  type: CertificateType;
  certificateNumber: string;
  attachmentFilename?: string;
  meta?: Meta;
}): EmailMessage => {
  const label = CERTIFICATE_LABELS[input.type];
  const link = `${appUrl()}/certificates`;
  const verify = `${appUrl()}/verify/${input.certificateNumber}`;

  const text = [
    `Hello ${input.recipientName},`,
    "",
    `Your ${label} for "${input.eventTitle}" at ${input.festName} is ready.`,
    `Certificate number: ${input.certificateNumber}`,
    "",
    input.attachmentFilename ? "The PDF is attached, and it is also in your Plansphere account:" : "Download it from your Plansphere account:",
    link,
    "",
    "Anyone can check it is genuine at:",
    verify,
    "",
    "Congratulations!",
    ...signoff,
  ].join("\n");

  const html = shell(
    "Your certificate is ready",
    p(`Hello ${escapeHtml(input.recipientName)}, your <strong>${escapeHtml(label)}</strong> for <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)} is ready.`) +
      rows([
        ["Number", input.certificateNumber],
        ["Verify", verify],
      ]) +
      button(link, "View in Plansphere") +
      small(input.attachmentFilename ? "The PDF is attached to this email too." : "Share the verification link with recruiters — it needs no account."),
  );

  return { to: input.to, subject: `Your ${label} — ${input.eventTitle}`, text, html, template: "certificate_issued", meta: input.meta };
};

/* ═══════════════════════════ 6. Password reset ═══════════════════════════ */

export const passwordResetEmail = (input: { to: string; recipientName?: string; resetLink: string; meta?: Meta }): EmailMessage => {
  const name = input.recipientName ?? "there";
  const text = [
    `Hello ${name},`,
    "",
    "Someone asked to reset the password for this Plansphere account. If it was you, use the link below; it expires in one hour.",
    input.resetLink,
    "",
    "If you didn't ask for this, ignore this email — your password stays as it is.",
    ...signoff,
  ].join("\n");
  const html = shell(
    "Reset your password",
    p(`Hello ${escapeHtml(name)}, someone asked to reset the password for this Plansphere account. If it was you, set a new one below. The link expires in one hour.`) +
      button(input.resetLink, "Choose a new password") +
      small("If you didn't ask for this, ignore this email — your password stays as it is."),
  );
  return { to: input.to, subject: "Reset your Plansphere password", text, html, template: "password_reset", meta: input.meta };
};

/* ═══════════════════════════ 7. Organizer / staff invite ═══════════════════════════ */

export const staffInviteEmail = (input: { to: string; fullName: string; roleLabel: string; setPasswordLink: string; temporaryPassword?: string; invitedBy: string; meta?: Meta }): EmailMessage => {
  const signIn = `${appUrl()}/sign-in`;
  const text = [
    `Hello ${input.fullName},`,
    "",
    `You have been added to Plansphere as ${input.roleLabel} by ${input.invitedBy}.`,
    "",
    "Set your password using the link below, then sign in:",
    input.setPasswordLink,
    ...(input.temporaryPassword
      ? [
          "",
          "If that link has expired, sign in with the credentials below instead —",
          "you will be asked to choose your own password straight away:",
          `  ${signIn}`,
          `  Email:    ${input.to}`,
          `  Password: ${input.temporaryPassword}`,
          "",
          "The temporary password works only until you change it, and it cannot be",
          "used for anything else in the meantime.",
        ]
      : ["", "This link expires. If it has, ask for a new invitation."]),
    ...signoff,
  ].join("\n");

  const credentials = input.temporaryPassword
    ? rows([
        ["Sign in at", signIn],
        ["Email", input.to],
        ["Temporary password", input.temporaryPassword],
      ]) + small("Use the button above if you can. The temporary password is a fallback, works only until you change it, and you will be asked to choose your own the first time you sign in.")
    : small("This link expires. If it no longer works, ask for a new invitation.");

  const html = shell(
    "You've been added to Plansphere",
    p(`Hello ${escapeHtml(input.fullName)}, you have been added as <strong>${escapeHtml(input.roleLabel)}</strong> by ${escapeHtml(input.invitedBy)}. Set your password to activate the account.`) +
      button(input.setPasswordLink, "Set your password") +
      credentials,
  );

  return { to: input.to, subject: "You've been added to Plansphere", text, html, template: "staff_invite", meta: input.meta };
};

/* ═══════════════════════════ 8. Email verification ═══════════════════════════ */

export const emailVerificationEmail = (input: { to: string; recipientName?: string; verifyLink: string; meta?: Meta }): EmailMessage => {
  const name = input.recipientName ?? "there";
  const text = [
    `Hello ${name},`,
    "",
    "Confirm this address to finish setting up your Plansphere account. Registrations, passes and certificates are sent here.",
    input.verifyLink,
    "",
    "If you didn't create a Plansphere account, ignore this email.",
    ...signoff,
  ].join("\n");
  const html = shell(
    "Confirm your email",
    p(`Hello ${escapeHtml(name)}, confirm this address to finish setting up your Plansphere account. Registrations, passes and certificates are sent here.`) +
      button(input.verifyLink, "Confirm email") +
      small("If you didn't create a Plansphere account, ignore this email."),
  );
  return { to: input.to, subject: "Confirm your email for Plansphere", text, html, template: "email_verification", meta: input.meta };
};

/* ═══════════════════════════ Event reminder / update / cancel ═══════════════════════════ */

export const eventReminderEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  date: string;
  startTime: string;
  venue: string;
  ticketCode: string;
  registrationId: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/my-pass?r=${input.registrationId}`;
  const details: Array<[string, string | undefined]> = [
    ["When", `${input.date} at ${input.startTime}`],
    ["Venue", input.venue],
    ["Ticket", input.ticketCode],
  ];
  const text = [
    `Hello ${input.recipientName},`,
    "",
    `Reminder: "${input.eventTitle}" at ${input.festName} is tomorrow.`,
    "",
    ...textRows(details),
    "",
    "Open your pass before you leave so it is cached for the gate:",
    link,
    ...signoff,
  ].join("\n");
  const html = shell(
    `Tomorrow: ${input.eventTitle}`,
    p(`Hello ${escapeHtml(input.recipientName)}, <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)} is tomorrow.`) +
      rows(details) +
      button(link, "Open your pass") +
      small("Open the pass once while online and it works at the gate with no signal."),
  );
  return { to: input.to, subject: `Tomorrow: ${input.eventTitle} · ${input.startTime}`, text, html, template: "event_reminder", meta: input.meta };
};

export const eventUpdatedEmail = (input: {
  to: string;
  recipientName: string;
  eventTitle: string;
  festName: string;
  changes: string[];
  registrationId: string;
  meta?: Meta;
}): EmailMessage => {
  const link = `${appUrl()}/registered/${input.registrationId}`;
  const text = [`Hello ${input.recipientName},`, "", `"${input.eventTitle}" at ${input.festName} has changed:`, ...input.changes.map((c) => `  • ${c}`), "", link, ...signoff].join("\n");
  const html = shell(
    `${input.eventTitle} has changed`,
    p(`Hello ${escapeHtml(input.recipientName)}, the organizers updated <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)}:`) +
      `<ul style="margin:0 0 8px 18px;padding:0;color:#111827;font-size:14px;line-height:1.7">${input.changes.map((c) => `<li>${escapeHtml(c)}</li>`).join("")}</ul>` +
      button(link, "See the details"),
  );
  return { to: input.to, subject: `Update: ${input.eventTitle}`, text, html, template: "event_updated", meta: input.meta };
};

export const eventCancelledEmail = (input: { to: string; recipientName: string; eventTitle: string; festName: string; reason?: string; meta?: Meta }): EmailMessage => {
  const link = `${appUrl()}/my-events`;
  const text = [
    `Hello ${input.recipientName},`,
    "",
    `"${input.eventTitle}" at ${input.festName} has been cancelled by the organizers.${input.reason ? ` Reason: ${input.reason}` : ""}`,
    "",
    "Your entry no longer admits anyone. Any fee paid is handled by the organizers directly.",
    link,
    ...signoff,
  ].join("\n");
  const html = shell(
    `${input.eventTitle} is cancelled`,
    p(`Hello ${escapeHtml(input.recipientName)}, <strong>${escapeHtml(input.eventTitle)}</strong> at ${escapeHtml(input.festName)} has been cancelled by the organizers.${input.reason ? ` Reason: ${escapeHtml(input.reason)}` : ""}`) +
      p("Your entry no longer admits anyone. Any fee paid is handled by the organizers directly.") +
      button(link, "My events"),
  );
  return { to: input.to, subject: `Cancelled: ${input.eventTitle}`, text, html, template: "event_cancelled", meta: input.meta };
};

/* ═══════════════════════════ Announcement ═══════════════════════════ */

export const announcementEmail = (input: { to: string; recipientName: string; festName: string; title: string; body: string; link?: string; meta?: Meta }): EmailMessage => {
  const link = input.link ?? `${appUrl()}/my-events`;
  const text = [`Hello ${input.recipientName},`, "", `${input.festName} — ${input.title}`, "", input.body, "", link, ...signoff].join("\n");
  const html = shell(
    input.title,
    p(`Hello ${escapeHtml(input.recipientName)}, a message from the organizers of <strong>${escapeHtml(input.festName)}</strong>:`) +
      `<div style="white-space:pre-wrap;color:#111827;font-size:14px;line-height:1.6;margin:0 0 6px">${escapeHtml(input.body)}</div>` +
      button(link, "Open Plansphere"),
  );
  return { to: input.to, subject: `${input.festName}: ${input.title}`, text, html, template: "announcement", meta: input.meta };
};
