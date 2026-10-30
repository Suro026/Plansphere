import { Suspense } from "react";
import type { Metadata } from "next";
import { LandingExperience, type OrbitFeature } from "./_landing/landing-experience";
import { FlowSection, EventsSection } from "./_landing/sections";
import { HomeEvents } from "./_landing/home-data";
import "./landing.css";

/** What a participant actually does on Plansphere — shown in full beside the sphere. */
const ORBIT_FEATURES: readonly OrbitFeature[] = [
  { eyebrow: "01 / REGISTER", title: "Event registration", copy: "Sign up solo or as a team through each event's own registration form, with capacity limits.", icon: "✦" },
  { eyebrow: "02 / QR PASS", title: "QR check-in", copy: "Every registration gets a QR pass. Volunteers scan it at the gate and for meals, even offline.", icon: "◌" },
  { eyebrow: "03 / RESULTS", title: "Results & certificates", copy: "Live scores and published results, plus certificates anyone can verify by number. No login needed.", icon: "✳" },
];

export const metadata: Metadata = {
  title: "Plansphere — Every fest, start to finish.",
};

// Public data; a minute of staleness is fine and keeps Firestore reads low.
export const revalidate = 60;

/**
 * The landing page.
 *
 * `LandingExperience` (a client component) owns the header, hero, command
 * palette and footer. Everything between the hero and the footer is static or
 * server-rendered and passed in as `children`, because the `quiet-mode` class
 * (toggled from inside the header) is read by CSS on those sections, so it has
 * to live on their shared ancestor.
 *
 * The events grid is the only part that needs Firestore, so it sits behind its
 * own `<Suspense>` boundary — the hero still renders immediately as plain HTML.
 */
export default function LandingPage() {
  return (
    <LandingExperience features={ORBIT_FEATURES}>
      <Suspense fallback={<EventsSection items={null} />}>
        <HomeEvents />
      </Suspense>
      <FlowSection />
    </LandingExperience>
  );
}
