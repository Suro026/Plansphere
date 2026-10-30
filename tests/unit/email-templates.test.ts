import { describe, expect, it } from "vitest";
import * as t from "@/server/email/templates";
import { EMAIL_TEMPLATES, type EmailMessage } from "@/server/email/types";

process.env.NEXT_PUBLIC_APP_URL = "https://plansphere.in";

/** Every template, built once with representative input. */
const all: Record<string, EmailMessage> = {
  registration_confirmed: t.registrationConfirmedEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", date: "2026-09-25", startTime: "10:00", venue: "Lab 4", ticketCode: "FF-7K2M9QX4TB", teamName: "Null Pointers", registrationId: "reg1" }),
  team_invite: t.teamInviteEmail({ to: "b@x.test", recipientName: "Arjun", leaderName: "Ishita", teamName: "Null Pointers", eventTitle: "CTF", festName: "Bits2Bytes", date: "2026-09-25" }),
  team_update: t.teamUpdateEmail({ to: "a@x.test", recipientName: "Ishita", teamName: "Null Pointers", eventTitle: "CTF", change: "declined", memberName: "Arjun" }),
  waitlist_promoted: t.waitlistPromotedEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", date: "2026-09-25", startTime: "10:00", venue: "Lab 4", ticketCode: "FF-7K2M9QX4TB", registrationId: "reg1" }),
  certificate_issued: t.certificateIssuedEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", type: "winner", certificateNumber: "FF-2026-ABCDEFGH" }),
  password_reset: t.passwordResetEmail({ to: "a@x.test", resetLink: "https://plansphere.in/auth/action?mode=resetPassword&oobCode=abc" }),
  staff_invite: t.staffInviteEmail({ to: "o@x.test", fullName: "Org", roleLabel: "Admin", setPasswordLink: "https://plansphere.in/auth/action?mode=resetPassword&oobCode=xyz", invitedBy: "super@x.test" }),
  email_verification: t.emailVerificationEmail({ to: "a@x.test", recipientName: "Ishita", verifyLink: "https://plansphere.in/auth/action?mode=verifyEmail&oobCode=v1" }),
  event_reminder: t.eventReminderEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", date: "2026-09-25", startTime: "10:00", venue: "Lab 4", ticketCode: "FF-7K2M9QX4TB", registrationId: "reg1" }),
  event_updated: t.eventUpdatedEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", changes: ["Venue: Lab 4 → Lab 5"], registrationId: "reg1" }),
  event_cancelled: t.eventCancelledEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes" }),
  payment_due: t.paymentDueEmail({ to: "a@x.test", recipientName: "Ishita", eventTitle: "CTF", festName: "Bits2Bytes", amountLabel: "₹500", holdMinutes: 15, registrationId: "reg1" }),
  announcement: t.announcementEmail({ to: "a@x.test", recipientName: "Ishita", festName: "Bits2Bytes", title: "Venue change", body: "Finals move to <Lab 5> & back." }),
};

describe("email templates", () => {
  it("cover every template name and label themselves correctly", () => {
    for (const name of EMAIL_TEMPLATES) {
      expect(all[name], `missing template ${name}`).toBeDefined();
      expect(all[name]!.template).toBe(name);
    }
  });

  it("always ship a plain-text body alongside HTML", () => {
    for (const [name, m] of Object.entries(all)) {
      expect(m.text.length, name).toBeGreaterThan(40);
      expect(m.html, name).toContain("<h1");
      expect(m.subject.length, name).toBeGreaterThan(5);
    }
  });

  it("link into plansphere.in, never into a firebaseapp.com handler", () => {
    for (const [name, m] of Object.entries(all)) {
      expect(m.html, name).toContain("https://plansphere.in/");
      expect(m.html, name).not.toContain("firebaseapp.com");
    }
    expect(all.registration_confirmed!.text).toContain("/registered/reg1");
    expect(all.certificate_issued!.text).toContain("/verify/FF-2026-ABCDEFGH");
    expect(all.certificate_issued!.text).toContain("/certificates");
    expect(all.event_reminder!.text).toContain("/my-pass?r=reg1");
  });

  it("escape user-supplied text in HTML", () => {
    expect(all.announcement!.html).toContain("&lt;Lab 5&gt; &amp; back.");
    expect(all.announcement!.html).not.toContain("<Lab 5>");
  });

  it("phrase team updates by what changed", () => {
    expect(all.team_update!.subject).toBe("Arjun declined — CTF");
    expect(t.teamUpdateEmail({ to: "m@x.test", recipientName: "Arjun", teamName: "NP", eventTitle: "CTF", change: "removed" }).subject).toBe("You were removed from NP — CTF");
  });
});
