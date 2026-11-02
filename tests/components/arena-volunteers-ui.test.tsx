import * as React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two screens of the arena roster.
 *
 * The admin's "Assign a volunteer" picker must offer volunteers who hold an event role as well as fest-scoped ones, and
 * saving goes through the server. The volunteer's own Live page must show the arena a shift assigns them, and say so
 * plainly when there is none.
 */

const h = vi.hoisted(() => ({
  volunteers: { data: undefined as unknown, isPending: false, isError: false },
  shifts: { data: [] as unknown[], loading: false },
  arenas: { data: [] as unknown[], loading: false },
  assign: vi.fn(),
  toastOk: vi.fn(),
  toastErr: vi.fn(),
  myArenaIds: new Set<string>(),
  session: { uid: "scorerA" },
}));

vi.mock("sonner", () => ({ toast: { success: h.toastOk, error: h.toastErr } }));
vi.mock("@/components/shell/admin-shell", () => ({
  AdminPage: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  useFest: () => ({ fest: { id: "fest1", name: "Bits2Bytes" } }),
}));
vi.mock("@/components/shell/volunteer-shell", () => ({ useVolunteerFest: () => ({ fest: { id: "fest1", name: "Bits2Bytes" }, basePath: "/volunteer/b2b" }) }));
vi.mock("@/components/providers", () => ({
  useRepositories: () => ({ arenas: { create: vi.fn(), update: vi.fn(), delete: vi.fn() }, matches: {} }),
  useAuth: () => ({ session: h.session }),
}));
vi.mock("@/components/admin/hooks", () => ({ useFestShifts: () => h.shifts }));
vi.mock("@/components/admin/arena-volunteers-api", () => ({
  useArenaVolunteers: () => h.volunteers,
  useAssignArenaVolunteer: () => ({ mutateAsync: h.assign }),
}));
vi.mock("@/components/live/hooks", () => ({
  useFestArenas: () => h.arenas,
  useMyScoringArenaIds: () => h.myArenaIds,
  useArenaMatches: () => ({ data: [], loading: false }),
  useMatchLog: () => ({ data: [], loading: false }),
}));
vi.mock("@/components/live/score-controls", () => ({ ScoreControls: () => null }));

import ArenasPage from "@/app/admin/[festSlug]/arenas/page";
import VolunteerLivePage from "@/app/volunteer/[festSlug]/live/page";

const arena = (id: string, name: string) => ({ id, festId: "fest1", name, active: true });

beforeEach(() => {
  h.volunteers = {
    data: [
      { id: "scorerA", name: "Scorer Alpha", email: "alpha@plansphere.test", source: "event" },
      { id: "leg1", name: "Legacy Volunteer", email: "leg1@plansphere.test", source: "fest" },
    ],
    isPending: false,
    isError: false,
  };
  h.shifts = { data: [], loading: false };
  h.arenas = { data: [arena("arenaA", "Arena A"), arena("arenaB", "Arena B")], loading: false };
  h.assign.mockReset().mockResolvedValue({ shift: { id: "s1" }, alreadyAssigned: false });
  h.toastOk.mockReset();
  h.toastErr.mockReset();
  h.myArenaIds = new Set();
});
afterEach(cleanup);

describe("Arenas page: Assign a volunteer", () => {
  it("offers event-role volunteers and fest-scoped volunteers side by side, in every arena's picker", () => {
    render(<ArenasPage />);
    const pickers = screen.getAllByRole("combobox");
    expect(pickers).toHaveLength(2);
    for (const picker of pickers) {
      const labels = within(picker).getAllByRole("option").map((o) => o.textContent);
      expect(labels).toEqual(expect.arrayContaining(["Scorer Alpha · alpha@plansphere.test", "Legacy Volunteer · leg1@plansphere.test"]));
    }
  });

  it("saves through the server with the chosen arena and person, and says so", async () => {
    render(<ArenasPage />);
    const [first] = screen.getAllByRole("combobox");
    fireEvent.change(first!, { target: { value: "scorerA" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" })[0]!);
    await waitFor(() => expect(h.assign).toHaveBeenCalledWith({ arenaId: "arenaA", userId: "scorerA" }));
    await waitFor(() => expect(h.toastOk).toHaveBeenCalledWith("Scorer Alpha assigned to Arena A"));
  });

  it("shows the server's reason when it refuses, and does not claim success", async () => {
    const { ApiClientError } = await import("@/data/api-client");
    h.assign.mockRejectedValue(new ApiClientError(422, { error: "That person cannot score at this event." }));
    render(<ArenasPage />);
    fireEvent.change(screen.getAllByRole("combobox")[0]!, { target: { value: "leg1" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Assign" })[0]!);
    await waitFor(() => expect(h.toastErr).toHaveBeenCalledWith("That person cannot score at this event."));
    expect(h.toastOk).not.toHaveBeenCalled();
  });

  it("lists who is assigned from the roster, and explains an empty picker", () => {
    h.shifts = { data: [{ id: "s1", duty: "scoring", post: "arenaA", cancelled: false, userName: "Scorer Alpha" }, { id: "s2", duty: "scoring", post: "arenaA", cancelled: true, userName: "Gone Person" }], loading: false };
    h.volunteers = { data: [], isPending: false, isError: false };
    render(<ArenasPage />);
    expect(screen.getByText("Scorer Alpha")).toBeTruthy();
    expect(screen.queryByText("Gone Person")).toBeNull();
    expect(screen.getAllByText(/No volunteers who can score yet/).length).toBe(2);
    expect(screen.queryByRole("combobox")).toBeNull();
  });
});

describe("Volunteer Live page: the assigned arena", () => {
  it("shows the arena an event-role volunteer's shift assigns them", () => {
    h.myArenaIds = new Set(["arenaB"]);
    render(<VolunteerLivePage />);
    expect(screen.getByText(/Matches at Arena B/)).toBeTruthy();
    expect(screen.queryByText("No arena assigned yet")).toBeNull();
  });

  it("offers a choice only among the arenas they are assigned to", () => {
    h.myArenaIds = new Set(["arenaA", "arenaB"]);
    render(<VolunteerLivePage />);
    expect(within(screen.getByRole("combobox")).getAllByRole("option").map((o) => o.textContent)).toEqual(["Arena A", "Arena B"]);
  });

  it("says no arena is assigned when there is no scoring shift", () => {
    render(<VolunteerLivePage />);
    expect(screen.getByText("No arena assigned yet")).toBeTruthy();
  });
});
