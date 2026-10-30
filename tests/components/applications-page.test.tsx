import * as React from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The reviewer's Applications screen. Found missing in the Phase 6 pass: the approval API existed with no screen, so a
 * platform reviewer could only decide an application by calling the API by hand. The server holds every rule; this proves
 * the screen shows the queue, sends exactly the decision asked for, and does not offer an approval the server would refuse.
 */

const calls: Array<{ path: string; init?: { method?: string; body?: unknown } }> = [];
const queue = [
  { festId: "f1", name: "Verified Fest", slug: "verified-fest", festType: "tech", organizationName: "Org One", organizationType: "college", city: "Chennai", state: "TN", submittedAt: new Date().toISOString(), applicant: { id: "u1", emailVerified: true, name: "Verified Person", email: "v@x.test" }, hasIdentityDocument: true },
  { festId: "f2", name: "Unverified Fest", slug: "unverified-fest", festType: "tech", organizationName: "Org Two", organizationType: "college", city: "Pune", state: "MH", submittedAt: new Date().toISOString(), applicant: { id: "u2", emailVerified: false, name: "Unverified Person", email: "u@x.test" }, hasIdentityDocument: false },
];

vi.mock("@/data/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/data/api-client")>("@/data/api-client");
  return {
    ...actual,
    api: async (path: string, init?: { method?: string; body?: unknown }) => {
      calls.push({ path, init });
      if (path.startsWith("/api/admin/verifications")) return { status: "pending", applications: queue };
      if (path.includes("/verification/document")) return { url: "https://example.test/doc" };
      return { festId: "f1", status: "approved" };
    },
  };
});

import ApplicationsPage from "@/app/admin/platform/applications/page";

const renderPage = () =>
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <ApplicationsPage />
    </QueryClientProvider>,
  );

beforeEach(() => {
  calls.length = 0;
});

describe("Applications (platform reviewer)", () => {
  it("lists the pending queue with who applied and whether their address is verified", async () => {
    renderPage();
    expect(await screen.findByText("Verified Fest")).toBeInTheDocument();
    expect(screen.getByText("Unverified Fest")).toBeInTheDocument();
    expect(screen.getByText("Email verified")).toBeInTheDocument();
    expect(screen.getByText("Email not verified")).toBeInTheDocument();
    expect(calls[0]!.path).toBe("/api/admin/verifications?status=pending");
  });

  it("does not offer an approval the server would refuse: the applicant's address is not verified", async () => {
    renderPage();
    await screen.findByText("Verified Fest");
    const approve = screen.getAllByRole("button", { name: "Approve" });
    expect(approve[0]).toBeEnabled();
    expect(approve[1]).toBeDisabled();
  });

  it("approves only after a confirmation, sending exactly an approve decision for that event", async () => {
    renderPage();
    await screen.findByText("Verified Fest");
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" })[0]!);
    expect(await screen.findByText(/becomes the Event Head of this event, and only this event/)).toBeInTheDocument();
    expect(calls.some((c) => c.init?.method === "POST")).toBe(false); // nothing sent yet
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.path === "/api/admin/fests/f1/verification" && c.init?.method === "POST")).toBe(true));
    expect(calls.find((c) => c.init?.method === "POST")!.init!.body).toEqual({ action: "approve" });
  });

  it("rejects only with a reason, and sends it", async () => {
    renderPage();
    await screen.findByText("Verified Fest");
    fireEvent.click(screen.getAllByRole("button", { name: "Reject" })[0]!);
    const submit = await screen.findByRole("button", { name: "Reject application" });
    expect(submit).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Could not match the organization." } });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);
    await waitFor(() => expect(calls.some((c) => c.init?.method === "POST")).toBe(true));
    expect(calls.find((c) => c.init?.method === "POST")!.init!.body).toEqual({ action: "reject", reason: "Could not match the organization." });
  });

  it("offers the identity document only where one was attached", async () => {
    renderPage();
    await screen.findByText("Verified Fest");
    expect(screen.getAllByRole("button", { name: "View ID document" })).toHaveLength(1);
  });
});
