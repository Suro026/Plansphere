import Link from "next/link";
import type { Metadata } from "next";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { Kick, MetaList, MetaRow, Tag, Timeline, TimelineItem } from "@/components/ui/primitives";

export const metadata: Metadata = {
  alternates: { canonical: "/for-colleges" },
  title: "For colleges",
  description: "Run a fest end to end — events, teams, gate scanning, meals, results and certificates — from one admin.",
};

/**
 * The pitch the landing page and footer link to. Creating a college event is
 * self-service from here: `/register-event` takes the application, the
 * Plansphere team verifies the institution, and on approval the applicant
 * becomes the Event Super Admin of that one event. Staff beyond that first
 * admin (more admins, coordinators, volunteers) are invited from inside the
 * event console, so an audit log stands behind every account on the event.
 */
export default function ForCollegesPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="colleges" />

      <section className="mx-auto w-full max-w-[1180px] px-[18px] pb-10 pt-8 sm:px-6 sm:pt-14 lg:px-10">
        <div className="max-w-[640px]">
          <span className="mb-4 block text-[10px] font-semibold uppercase tracking-[0.16em] text-neutral-600">
            [ for colleges ]
          </span>
          <h1 className="mb-5 text-[38px] leading-[0.96] tracking-[-0.03em] sm:text-[58px] sm:leading-[0.9] sm:tracking-[-0.035em]">
            Create your college event.
            <br />
            Then <em className="text-emphasis text-accent not-italic sm:italic">run it.</em>
          </h1>
          <div className="mb-6 flex flex-wrap gap-2">
            <Tag tone="neutral">Reviewed by the Plansphere team before it goes live</Tag>
          </div>
          <p className="mb-[26px] max-w-[520px] text-[16px] text-neutral-400 sm:text-[17px]">
            Tech fest, cultural fest, sports meet or conference: apply with your college and event details. Once the Plansphere team verifies it you are its Event Super Admin —
            build your team, open registrations, run the gate and meals offline, and publish results that turn into verifiable certificates.
          </p>
          <div className="flex flex-wrap gap-2.5">
            <Link href="/register-event" className="btn btn-primary btn-lg">
              Create a College Event
            </Link>
            <Link href="/explore" className="btn btn-secondary btn-lg">
              See fests already running
            </Link>
          </div>
        </div>
      </section>

      {/* What you get */}
      <section className="bg-text text-bg">
        <div className="mx-auto w-full max-w-[1180px] px-[18px] py-12 sm:px-6 lg:px-10 lg:py-16">
          <span className="mb-8 block text-[10px] font-semibold uppercase tracking-[0.16em] text-[color:color-mix(in_srgb,var(--color-bg)_58%,transparent)] lg:mb-11">
            [ what you get ]
          </span>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[
              {
                kick: "Before the fest",
                title: "Set up in under 30 minutes",
                body: "Create the fest, add events through the wizard — solo or team, free or paid, with gates and meal slots — and publish when the lineup is ready. Registrations open and close on the dates you set.",
              },
              {
                kick: "On the day",
                title: "A gate that keeps working offline",
                body: "Volunteers scan passes from their phones. The roster is cached, duplicates are caught locally, and every scan syncs the moment the network is back — nothing is lost, nobody is let in twice.",
              },
              {
                kick: "After",
                title: "Results become certificates",
                body: "Upload results, and the system works out who is eligible from attendance. Certificates are generated, emailed, and carry a public verification link a recruiter can check in seconds.",
              },
            ].map((c) => (
              <div
                key={c.kick}
                className="flex min-h-[220px] flex-col justify-between border border-[color:color-mix(in_srgb,var(--color-bg)_16%,transparent)] p-5 transition-colors duration-200 hover:border-accent-fill"
              >
                <span className="text-[10px] uppercase tracking-[0.12em] text-accent-fill">{c.kick}</span>
                <div>
                  <h3 className="mb-2 font-display text-[19px] tracking-[-0.02em]">{c.title}</h3>
                  <p className="text-[12.5px] leading-[1.55] text-[color:color-mix(in_srgb,var(--color-bg)_82%,transparent)]">{c.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Roles + how onboarding works */}
      <section className="mx-auto grid w-full max-w-[1180px] grid-cols-1 gap-10 px-[18px] py-12 sm:px-6 lg:grid-cols-2 lg:px-10 lg:py-16">
        <div>
          <Kick className="mb-3">Who does what</Kick>
          <MetaList>
            <MetaRow label="Platform super admin">Runs Plansphere itself. Not scoped to any one event — sees the whole platform.</MetaRow>
            <MetaRow label="You, the Event Super Admin">Create the event; once the Plansphere team approves it you run it — competitions, team, registrations, certificates. Your access covers this event only.</MetaRow>
            <MetaRow label="Admin(s) and coordinators">Whoever you invite to run parts of it — each works only on the competitions you assign.</MetaRow>
            <MetaRow label="Volunteer(s)">Scans entry and meals, or runs the live scoreboard at the posts they're rostered on — nothing more.</MetaRow>
            <MetaRow label="Student(s)">Registers, holds the pass, collects certificates. Self-serve sign-up.</MetaRow>
          </MetaList>
          <div className="mt-4 max-w-[52ch] text-[12.5px] text-neutral-500">
            Creating the event is self-service; approval is a manual check by the Plansphere team. Every account on your team — admins, coordinators,
            volunteers — is invited from inside your own event console, so an audit log stands behind every action taken on your event.
          </div>
        </div>
        <div>
          <Kick className="mb-3">Getting started</Kick>
          <Timeline>
            <TimelineItem title={<><span className="text-neutral-500">Now · </span>Create your college event</>} meta="Create an account, tell us about your college and the event. Takes minutes." />
            <TimelineItem title={<><span className="text-neutral-500">Review · </span>The Plansphere team verifies it</>} meta="Every application is checked by hand and your email address must be verified. The event stays private until then. You are emailed the decision." />
            <TimelineItem title={<><span className="text-neutral-500">Approved · </span>You are the Event Super Admin</>} meta="No second account needed: the one you applied with now runs the event. Add competitions and invite your admins, coordinators and volunteers." />
            <TimelineItem title={<><span className="text-neutral-500">Same day · </span>Add events, invite your team</>} meta="Build the lineup, add other admins and volunteers from the Staff page, and preview every event exactly as students will see it." />
            <TimelineItem title={<><span className="text-neutral-500">Launch · </span>Publish</>} meta="The fest appears on Explore and registrations open on schedule. Live counts are on your dashboard from the first sign-up." />
          </Timeline>
        </div>
      </section>

      {/* Closing CTA */}
      <section className="bg-grid-lines bg-accent-fill text-text">
        <div className="mx-auto flex w-full max-w-[860px] flex-col items-center gap-5 px-[18px] py-14 text-center sm:px-6 lg:py-20">
          <p className="text-[28px] leading-[0.98] tracking-[-0.03em] sm:text-[40px] sm:leading-[0.94] sm:tracking-[-0.035em]">
            Apply once. <em className="text-emphasis">Run your whole event.</em>
          </p>
          <div className="mt-1 flex flex-wrap items-center justify-center gap-x-7 gap-y-3">
            <Link href="/register-event" className="btn btn-primary btn-lg">
              Create a College Event
            </Link>
            <Link href="/explore" className="btn btn-secondary btn-lg">
              See fests already running
            </Link>
          </div>
        </div>
      </section>

      <PublicFooter />
    </div>
  );
}
