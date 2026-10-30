import * as React from "react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import Team01, { hasTeamProfile } from "@/components/ui/team-01";
import { coordinatorSchema } from "@/core/models/event";

describe("Team01 — the event's team section", () => {
  const members = [
    { name: "Ishita Rao", role: "Event lead", photoUrl: "https://cdn.example.com/a.jpg", linkedinUrl: "https://linkedin.com/in/ishita" },
    { name: "Arjun Mehta", role: "Design head", websiteUrl: "https://arjun.example.com" },
    { name: "Kavya Nair", phone: "+919000000000" },
  ];

  it("shows each member with role, photo or initials, and only the links they gave", () => {
    render(<Team01 members={members} />);
    expect(screen.getByRole("heading", { name: /meet the team/i })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Ishita Rao" })).toHaveAttribute("src", "https://cdn.example.com/a.jpg");
    expect(screen.getByText("Design head")).toBeInTheDocument();
    expect(screen.getByText("AM")).toBeInTheDocument(); // no photo → initials
    expect(screen.getByRole("link", { name: /Ishita Rao on LinkedIn/ })).toHaveAttribute("href", "https://linkedin.com/in/ishita");
    expect(screen.getByRole("link", { name: /Arjun Mehta.s website/ })).toHaveAttribute("rel", "noopener noreferrer");
    expect(screen.getAllByRole("link")).toHaveLength(2);
    // Contact details stay in the sidebar, not on the cards.
    expect(screen.queryByText("+919000000000")).not.toBeInTheDocument();
  });

  it("renders nothing for an empty team, and a plain contact list is not a team profile", () => {
    const { container } = render(<Team01 members={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(hasTeamProfile([{ name: "A", phone: "1" }])).toBe(false);
    expect(hasTeamProfile(members)).toBe(true);
  });

  it("accepts events saved before the extra fields existed, and rejects non-https links", () => {
    expect(coordinatorSchema.safeParse({ name: "Old", phone: "1", email: "o@x.test" }).success).toBe(true);
    expect(coordinatorSchema.safeParse({ name: "New", linkedinUrl: "javascript:alert(1)" }).success).toBe(false);
    expect(coordinatorSchema.safeParse({ name: "New", photoUrl: "http://insecure.example.com/a.jpg" }).success).toBe(false);
  });
});
