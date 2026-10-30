import type { Metadata } from "next";
import Link from "next/link";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Kick, MetaList, MetaRow } from "@/components/ui/primitives";
import { SITE, absoluteUrl } from "@/lib/site";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "What Plansphere stores about you, who can see it, which services process it, how long it stays, and the choices you have.",
  alternates: { canonical: absoluteUrl("/privacy") },
};

/**
 * Written from what the system actually does. Keep this in step with the
 * Firestore rules, the public lookups and the third-party list in the
 * README: if a field becomes visible somewhere new, it belongs here too.
 */
export default function PrivacyPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav />
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <Kick className="mb-2">Effective {SITE.legalUpdated}</Kick>
        <h1 className="mb-3 text-[34px] leading-[0.98] tracking-[-0.03em] sm:text-[46px] sm:leading-[0.94]">Privacy Policy</h1>
        <p className="mb-9 max-w-[56ch] text-[15px] text-neutral-400">
          Plansphere (“we”) runs college fests: registrations, gate check-in, meals, results and certificates. This policy explains
          what that involves for your personal data. It is written to be read, not skimmed past. It applies to plansphere.in and the emails we send.
        </p>

        <Section title="1. What we collect">
          <MetaList>
            <MetaRow label="Account">Name, email address, phone number, college, department and year, and a college ID if you add one. Email is verified before you can register.</MetaRow>
            <MetaRow label="Registrations">The events you registered for, your team name and your teammates’ names and emails, your ticket code, and payment status where an event has a fee.</MetaRow>
            <MetaRow label="Attendance">The time and gate at which your pass was scanned, and the staff account that scanned it. Meal collections are recorded the same way.</MetaRow>
            <MetaRow label="Certificates">The certificate (name, event, type, position, number) and a record of the email that delivered it.</MetaRow>
            <MetaRow label="Communications">Which system emails we sent you and whether they were delivered, so support can answer “I never got it”.</MetaRow>
            <MetaRow label="Technical">Server logs with your IP address, request path, timing and — when signed in — your account id, kept to run and secure the service. Error reports may include the page you were on and the error itself.</MetaRow>
          </MetaList>
        </Section>

        <Section title="2. Why we use it">
          <p>
            To run the fests you take part in: issue your pass, admit you at the gate, count meals, publish results and issue certificates you can prove
            are genuine. To keep the service secure and available. To send you the transactional email the service depends on: verification, password
            reset, registration confirmations, team invitations, waitlist promotions, event changes, reminders, certificates and messages from the
            organizers of a fest you registered for. We do not send marketing email and we do not sell or rent your data.
          </p>
        </Section>

        <Section title="3. Who can see it">
          <MetaList>
            <MetaRow label="You">Everything above that is about you, from your account.</MetaRow>
            <MetaRow label="A fest’s organizers">Admins of a fest see registrations, attendance, results and delivery logs for that fest only. Volunteers see only the names on the roster they are scanning.</MetaRow>
            <MetaRow label="Your teammates">Your name, that you are on the team, and the shared pass. Not your contact details.</MetaRow>
            <MetaRow label="The public">
              Two pages are public by design: a ticket page showing the holder’s name, event and entry time when a pass is scanned, and a certificate
              verification page showing what is printed on the certificate. Neither shows an email address, phone number or college ID.
            </MetaRow>
          </MetaList>
          <p>Access is enforced by security rules on the database itself, not only by the app; a request a rule does not allow is refused whatever screen it came from.</p>
        </Section>

        <Section title="4. Services that process data for us">
          <MetaList>
            <MetaRow label="Google Firebase">Authentication, database (Firestore) and file storage (certificate PDFs, images). Data is stored in Google Cloud.</MetaRow>
            <MetaRow label="Vercel">Hosts the website and runs the server code; keeps request logs for a short period.</MetaRow>
            <MetaRow label="Resend">Delivers our transactional email and reports whether it was delivered.</MetaRow>
            <MetaRow label="Sentry">Receives error reports so we can fix failures; configured without session replay and with credentials stripped.</MetaRow>
            <MetaRow label="Google reCAPTCHA (App Check)">Verifies that requests come from the real app, not a script. Subject to Google’s privacy policy.</MetaRow>
            <MetaRow label="Vercel Analytics">Privacy-friendly page analytics with no cookies and no cross-site tracking; loaded only if you accept analytics in the cookie banner.</MetaRow>
          </MetaList>
          <p>Each processes data only to provide its service to us. None of them is allowed to use your data for their own marketing.</p>
        </Section>

        <Section title="5. Cookies and local storage">
          <p>
            We use no advertising or cross-site tracking cookies. Signing in stores a session in your browser (essential — the site does not work
            without it). Your pass and your recent notifications are cached on your device so they work with no signal. The scanner keeps an offline
            queue on a volunteer’s device until it syncs. Your choice in the cookie banner is stored locally so we do not ask again. You can clear any
            of this from your browser at any time; you will simply be signed out.
          </p>
        </Section>

        <Section title="6. How long we keep it">
          <p>
            Registrations, attendance and certificates form the institutional record of a fest and are kept for as long as the hosting college needs
            them — a certificate’s verification link is expected to keep working for years. Server logs and error reports are kept for up to 90 days.
            Email delivery records are kept for one year. You can close your account at any time from your profile; that removes your login and
            contact details, while certificates already issued in your name stay verifiable.
          </p>
        </Section>

        <Section title="7. Your choices and rights">
          <p>
            You can see and edit your profile in the app, decline or leave a team, cancel a registration before an event starts, and reject analytics in
            the cookie banner. You can ask us for a copy of your data, ask us to correct it, or ask us to delete your account by writing to{" "}
            <a href={`mailto:${SITE.contact.privacy}`}>{SITE.contact.privacy}</a>. We answer within 30 days. For anything about a specific fest — a wrong
            name on a certificate, a registration you did not make — the fest’s contact address on its page is faster, since only its admins can change
            that record.
          </p>
        </Section>

        <Section title="8. Children">
          <p>Plansphere is for college students and staff. It is not directed at children under 16, and we do not knowingly collect their data. If you believe a child has created an account, tell us and we will remove it.</p>
        </Section>

        <Section title="9. Security">
          <p>
            Data travels over HTTPS only. Privileged operations run on the server behind role checks and are written to an audit log with who did what
            and when. Passwords are never stored by us — authentication is handled by Firebase, and we send links, never passwords. If a breach ever
            affects your data we will tell you and the relevant authority without undue delay.
          </p>
        </Section>

        <Section title="10. Changes and contact">
          <p>
            When this policy changes we update the date at the top and, for material changes, tell you by email or in the app. Questions go to{" "}
            <a href={`mailto:${SITE.contact.privacy}`}>{SITE.contact.privacy}</a>. Our <Link href="/terms">Terms &amp; Conditions</Link> cover the rest of
            the relationship.
          </p>
        </Section>
      </main>
      <PublicFooter />
    </div>
  );
}

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="mb-8 border-t border-divider pt-8">
    <h2 className="mb-3 text-[19px] tracking-[-0.015em]">{title}</h2>
    <div className="flex flex-col gap-3 text-[14px] leading-relaxed text-neutral-400 [&_p]:max-w-[60ch]">{children}</div>
  </section>
);
