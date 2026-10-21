import * as React from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DigitalTicket, ticketUrl } from "@/components/student/digital-ticket";
import { VerifySearch } from "@/components/verify/verify-search";
import { NotificationRow } from "@/components/shell/notifications";
import type { Notification } from "@/core/models/notification";
import { registration } from "../unit/fixtures";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

describe("DigitalTicket", () => {
  it("encodes the public /t/ URL in the QR and prints the code", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://plansphere.in";
    const reg = registration({ teamName: "Null Pointers", members: [...registration().members, { name: "Arjun", email: "arjun@x.test", isLeader: false, inviteStatus: "accepted" }] });
    const { container } = render(<DigitalTicket registration={reg} festName="Bits2Bytes" organizationName="SRM" />);

    expect(ticketUrl(reg.ticketCode)).toBe("https://plansphere.in/t/FF-7K2M9QX4TB");
    // react-qr-code renders an <svg>; the payload is what the gate parses.
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByText("FF-7K2M9QX4TB").length).toBeGreaterThan(0);
    expect(screen.getByText(/Team Null Pointers · 2 members/)).toBeInTheDocument();
  });
});

describe("DigitalTicket — who gets a QR", () => {
  const team = { teamName: "Null Pointers", members: [...registration().members, { name: "Arjun", email: "arjun@x.test", isLeader: false, inviteStatus: "pending" as const }] };
  const show = (over: Parameters<typeof registration>[0]) => render(<DigitalTicket registration={registration({ ...team, ...over })} festName="Bits2Bytes" />);

  it("shows no QR for a draft team — free or paid — and says the ticket is not valid yet", () => {
    for (const paymentStatus of [undefined, "not_required", "paid"] as const) {
      const { container, unmount } = show({ status: "draft", ...(paymentStatus ? { paymentStatus } : {}) });
      expect(container.querySelector("svg"), String(paymentStatus)).toBeNull();
      expect(screen.getByText("Team not complete yet")).toBeInTheDocument();
      expect(screen.getByText(/isn’t valid for entry until enough teammates have joined/)).toBeInTheDocument();
      // No code to read out or screenshot, and no download/print/wallet actions.
      expect(screen.queryByText("FF-7K2M9QX4TB")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Download PNG/ })).not.toBeInTheDocument();
      unmount();
    }
  });

  it("shows the QR the moment the same team is confirmed", () => {
    const { container } = show({ status: "confirmed" });
    expect(container.querySelector("svg")).not.toBeNull();
    expect(screen.getAllByText("FF-7K2M9QX4TB").length).toBeGreaterThan(0);
  });

  it("still hides the QR for an unpaid or refunded entry, with its own wording", () => {
    const unpaid = show({ status: "pending_payment", paymentStatus: "pending" });
    expect(unpaid.container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Ticket not issued yet")).toBeInTheDocument();
    unpaid.unmount();
    const refunded = show({ status: "confirmed", paymentStatus: "refund_pending" });
    expect(refunded.container.querySelector("svg")).toBeNull();
    expect(screen.getByText("Ticket withdrawn")).toBeInTheDocument();
  });
});

describe("VerifySearch", () => {
  it("rejects a malformed certificate number without navigating", async () => {
    const user = userEvent.setup();
    render(<VerifySearch />);
    await user.type(screen.getByLabelText("Certificate number"), "FF-7K2M9QX4TB");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/looks like PS-2026-7K2M9QX4/);
    expect(push).not.toHaveBeenCalled();
  });

  it("normalises spacing and case, then routes to the verification page", async () => {
    const user = userEvent.setup();
    push.mockClear();
    render(<VerifySearch />);
    await user.type(screen.getByLabelText("Certificate number"), " ff-2026-abcdefgh ");
    await user.click(screen.getByRole("button", { name: "Verify" }));
    expect(push).toHaveBeenCalledWith("/verify/FF-2026-ABCDEFGH");
  });
});

describe("NotificationRow", () => {
  const item: Notification = {
    id: "n1",
    userId: "u1",
    type: "team_invite",
    title: "Ishita added you to Null Pointers",
    body: "Capture the Flag",
    link: "/teams",
    read: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it("deep-links to the related screen and reports the open", async () => {
    const user = userEvent.setup();
    const onOpen = vi.fn();
    render(<NotificationRow item={item} onOpen={onOpen} />);
    const link = screen.getByRole("link", { name: /Ishita added you/ });
    expect(link).toHaveAttribute("href", "/teams");
    expect(screen.getByText("Team")).toBeInTheDocument();
    await user.click(link);
    expect(onOpen).toHaveBeenCalledWith(item);
  });

  it("renders a button when there is nothing to link to", () => {
    render(<NotificationRow item={{ ...item, link: undefined, type: "announcement", read: true }} onOpen={() => undefined} />);
    expect(screen.getByRole("button", { name: /Ishita added you/ })).toBeInTheDocument();
    expect(screen.getByText("Announcement")).toBeInTheDocument();
  });
});
