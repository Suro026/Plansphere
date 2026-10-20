"use client";

import * as React from "react";
import Image from "next/image";
import Link from "next/link";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  Command,
  Eye,
  Grid3x3,
  Menu,
  Moon,
  X,
} from "lucide-react";
import { PublicAuthControls } from "@/components/shell/signed-out-only";
import { SITE } from "@/lib/site";

const SITE_LEGAL_NAME = SITE.legalName;

/**
 * The landing page's interactive shell — the reference's `Home.tsx` header,
 * hero and command palette, ported structure-for-structure
 * (github.com/Xioonnox/plansphere, `client/src/pages/Home.tsx`). Everything
 * below the hero (statement band, platform, flow, dashboard, events, closing
 * band, footer) is static or server-rendered and arrives as `children`,
 * because the reference's `quiet-mode` class is read by CSS on *all* of
 * those sections (`.quiet-mode .white-section` etc. in landing.css) and so
 * has to sit on a shared ancestor — exactly where the reference puts it,
 * on the outermost `<main id="top">`.
 *
 * What changed from the reference, and nothing else:
 *   - nav/hero actions are real routes (`/sign-in`, `/register-event`, …)
 *     instead of `toast(...)`'s "coming soon";
 *   - the Sign in / Get started pair is Plansphere's real `PublicAuthControls`
 *     (shows the account menu once signed in) instead of two demo buttons;
 *   - the hero's centre image is `/hero-orbit.jpg`, a Plansphere-owned asset
 *     generated for this port (see scripts/generate-hero-orbit.mjs) in place
 *     of the reference's Manus-storage-hosted file, which this repo has no
 *     access to — same crop, size, position, opacity and counter-rotation;
 *   - the nav leads with the two audiences' real destinations — "Explore
 *     events" (`/explore`) and "For organizers" (`/for-colleges`) — plus
 *     "How it works" (`#flow`); the reference's "Platform" / "For colleges"
 *     anchors didn't tell a first-time visitor which side of the product
 *     they were on;
 *   - the hero names both paths (organizers → `/register-event`, students →
 *     `/explore`) instead of one mislabelled button, and the wordmark is the
 *     real `/logo.png` (the shared `Brand` asset) rather than a stand-in icon;
 *   - the mobile menu gets one addition the reference doesn't have: real
 *     sign-in access, since the reference's own mobile menu has no auth at
 *     all (its desktop login is also just a toast).
 */

const navItems = [
  { label: "Explore events", href: "/explore" },
  { label: "For organizers", href: "/for-colleges" },
  { label: "How it works", href: "#flow" },
] as const;

function NavLink({ href, className, onClick, children }: { href: string; className?: string; onClick?: () => void; children: React.ReactNode }) {
  // In-page anchors stay plain <a> (smooth scroll via CSS/UA); routes use <Link>.
  return href.startsWith("#") ? (
    <a href={href} className={className} onClick={onClick}>
      {children}
    </a>
  ) : (
    <Link href={href} className={className} onClick={onClick}>
      {children}
    </Link>
  );
}

export interface OrbitFeature {
  eyebrow: string;
  title: string;
  copy: string;
  icon: string;
}

function go(id: string) {
  document.querySelector(id)?.scrollIntoView({ behavior: "smooth" });
}

function Logo({ inverted = false, priority = false }: { inverted?: boolean; priority?: boolean }) {
  return (
    <Link href="/" className={`logo-mark ${inverted ? "logo-inverted" : ""}`} aria-label="Plansphere home">
      {/* The official logo, unaltered. It is dark ink on transparent, so on the
          dark nav/footer `.logo-inverted` gives it a light backing instead of
          recolouring it. */}
      <Image src="/logo.png" alt="" width={128} height={64} priority={priority} className="logo-image" />
    </Link>
  );
}

function Action({
  children,
  href,
  dark = false,
  outline = false,
}: {
  children: React.ReactNode;
  href: string;
  dark?: boolean;
  outline?: boolean;
}) {
  return (
    <Link href={href} className={`action-button ${dark ? "action-dark" : ""} ${outline ? "action-outline" : ""}`}>
      <span>{children}</span>
      <ArrowUpRight size={15} />
    </Link>
  );
}

export function LandingExperience({
  features,
  children,
}: {
  features: readonly OrbitFeature[];
  children: React.ReactNode;
}) {
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [quietMode, setQuietMode] = React.useState(false);
  const [scrolled, setScrolled] = React.useState(false);
  const [activeFeature, setActiveFeature] = React.useState(0);
  const [cursor, setCursor] = React.useState({ x: 0, y: 0 });
  const reduceMotionRef = React.useRef(false);

  React.useEffect(() => {
    reduceMotionRef.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const onScroll = () => setScrolled(window.scrollY > 65);
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setMenuOpen(false);
      }
      if (event.altKey && event.key.toLowerCase() === "p") {
        event.preventDefault();
        setQuietMode((mode) => !mode);
      }
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  React.useEffect(() => {
    if (reduceMotionRef.current) return;
    const timer = window.setInterval(() => setActiveFeature((feature) => (feature + 1) % features.length), 4200);
    return () => window.clearInterval(timer);
  }, [features.length]);

  const cycleFeature = () => setActiveFeature((feature) => (feature + 1) % features.length);
  const shellStyle = { "--cursor-x": `${cursor.x}px`, "--cursor-y": `${cursor.y}px` } as React.CSSProperties;

  return (
    <main
      id="main"
      className={`minimal-shell ${quietMode ? "quiet-mode" : ""}`}
      style={shellStyle}
      onMouseMove={(event) => setCursor({ x: event.clientX, y: event.clientY })}
    >
      <div className="cursor-spotlight" />
      <div className="starfield" aria-hidden="true" />
      <div className="cosmic-dust cosmic-dust-one" aria-hidden="true" />
      <div className="cosmic-dust cosmic-dust-two" aria-hidden="true" />

      <header className={`minimal-nav ${scrolled ? "nav-scrolled" : ""}`}>
        <div className="nav-inner minimal-nav-inner">
          <Logo inverted={scrolled} priority />
          <nav className="minimal-desktop-nav" aria-label="Main navigation">
            {navItems.map((item) => (
              <NavLink key={item.href} href={item.href}>
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="minimal-nav-actions">
            <button type="button" className="command-hint" onClick={() => setPaletteOpen(true)}>
              <Command size={12} /> <span>⌘ K</span>
            </button>
            <PublicAuthControls variant="landing" />
          </div>
          <button type="button" className="minimal-menu-button" onClick={() => setMenuOpen(!menuOpen)} aria-label={menuOpen ? "Close menu" : "Open menu"} aria-expanded={menuOpen}>
            {menuOpen ? <X size={19} /> : <Menu size={19} />}
          </button>
        </div>
        {menuOpen && (
          <div className="minimal-mobile-menu">
            {navItems.map((item) => (
              <NavLink key={item.href} href={item.href} onClick={() => setMenuOpen(false)}>
                {item.label}
              </NavLink>
            ))}
            <button type="button" onClick={() => setPaletteOpen(true)}>
              <Command size={14} /> Open command palette
            </button>
            <PublicAuthControls variant="landing" />
          </div>
        )}
      </header>

      <section className="minimal-hero">
        <span className="shooting-star shooting-star-one" aria-hidden="true" />
        <span className="shooting-star shooting-star-two" aria-hidden="true" />
        <div className="hero-hairline" />
        <div className="page-width minimal-hero-grid">
          <div className="minimal-hero-copy">
            <div className="editorial-kicker">
              <span>PLATFORM / 001</span>
              <span>COLLEGE EVENTS, END TO END</span>
            </div>
            <h1>
              Make the
              <br />
              <span>moment</span>
              <br />
              <em>matter.</em>
            </h1>
            <p>
              Plansphere is where colleges register and run their fests, and where students find events, sign up and
              keep their tickets.
            </p>
            <div className="minimal-hero-actions">
              <div className="hero-path">
                <Action href="/register-event">Register Your Event</Action>
                <span className="hero-path-note">For organizers: create and manage your fest.</span>
              </div>
              <div className="hero-path">
                <Action href="/explore" outline>
                  Explore Events
                </Action>
                <span className="hero-path-note">For students: discover events and register.</span>
              </div>
            </div>
          </div>

          <div className="minimal-hero-art">
            <div className="hero-art-label label-top" aria-hidden="true">
              <span>PS / 2026</span>
              <span>01—03</span>
            </div>
            <div
              className="hero-orbit-art"
              role="button"
              tabIndex={0}
              aria-label="Rotate through Plansphere features"
              style={{ "--active-feature": activeFeature } as React.CSSProperties}
              onClick={cycleFeature}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") cycleFeature();
              }}
            >
              <div className="art-circle art-circle-back" />
              <div className="art-circle art-circle-main" />
              <div className="art-ring ring-a" />
              <div className="art-ring ring-b" />
              <div className="art-ring ring-c" />
              <div className="art-crosshair" />
              <div className="art-dot dot-a" />
              <div className="art-dot dot-b" />
              <div className="art-star star-a" />
              <div className="art-star star-b" />
              <div className="art-number">0{activeFeature + 1}</div>
              {/* eslint-disable-next-line @next/next/no-img-element -- exact reference treatment (filter/mix-blend-mode on a plain <img>) */}
              <img src="/hero-orbit.jpg" alt="Abstract event energy" />
              {features.map((feature, index) => (
                <button
                  type="button"
                  key={feature.eyebrow}
                  className={`sphere-feature feature-${index} ${activeFeature === index ? "feature-active" : ""}`}
                  aria-label={`Show ${feature.title}`}
                  onClick={(event) => {
                    event.stopPropagation();
                    setActiveFeature(index);
                  }}
                >
                  <span className="feature-icon">{feature.icon}</span>
                  <span>
                    <b>{feature.eyebrow}</b>
                    <strong>{feature.title}</strong>
                    <small>{feature.copy}</small>
                  </span>
                </button>
              ))}
              <div className="sphere-rotate-hint">
                <span>click to rotate</span>
                <ArrowRight size={13} />
              </div>
            </div>
            <div className="hero-art-label label-bottom" aria-hidden="true">
              <span>
                EVERYTHING
                <br />
                IN MOTION
              </span>
              <span className="tiny-arrow">↗</span>
            </div>
          </div>
        </div>
        <button type="button" className="minimal-scroll-cue" onClick={() => go("#signal")}>
          <ArrowDown size={14} />
          <span>SCROLL TO BEGIN</span>
        </button>
      </section>

      {children}

      <footer className="minimal-footer">
        <div className="page-width">
          <div className="footer-main">
            <Logo inverted />
            <div className="footer-tagline">
              Make the moment
              <br />
              <em>matter.</em>
            </div>
            <div className="footer-actions">
              <button type="button" onClick={() => setQuietMode(!quietMode)}>
                <Moon size={13} /> {quietMode ? "Wake mode" : "Quiet mode"}
              </button>
              <button type="button" onClick={() => setPaletteOpen(true)}>
                <Command size={13} /> Command
              </button>
            </div>
          </div>
          <div className="footer-rule" />
          <div className="footer-bottom">
            <span>© {SITE_LEGAL_NAME}</span>
            <span>India / {new Date().getFullYear()}</span>
            <span>
              <Link href="/privacy" className="footer-link">
                Privacy
              </Link>
              &nbsp;&nbsp;
              <Link href="/terms" className="footer-link">
                Terms
              </Link>
            </span>
          </div>
        </div>
      </footer>

      {paletteOpen && (
        <div className="palette-backdrop" onClick={() => setPaletteOpen(false)}>
          <div className="command-palette" onClick={(event) => event.stopPropagation()}>
            <div className="palette-input">
              <Command size={16} />
              <span>What would you like to explore?</span>
              <kbd>esc</kbd>
            </div>
            <div className="palette-options">
              <button
                type="button"
                onClick={() => {
                  setPaletteOpen(false);
                  go("#platform");
                }}
              >
                <Grid3x3 size={16} />
                <span>Explore the platform</span>
                <small>⌘ 1</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPaletteOpen(false);
                  go("#flow");
                }}
              >
                <Eye size={16} />
                <span>See how it works</span>
                <small>⌘ 2</small>
              </button>
              <button
                type="button"
                onClick={() => {
                  setPaletteOpen(false);
                  setQuietMode(!quietMode);
                }}
              >
                <Moon size={16} />
                <span>Toggle quiet mode</span>
                <small>⌘ Q</small>
              </button>
            </div>
            <div className="palette-footer">
              <span>Plansphere command</span>
              <span>↑↓ navigate&nbsp;&nbsp; ↵ select</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
