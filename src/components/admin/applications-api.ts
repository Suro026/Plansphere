"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/data/api-client";
import type { VerificationStatus } from "@/core/models/fest";

/**
 * The platform reviewer's routes, as hooks: the application queue, the audited identity-document link, and the decision.
 * Everything here is a server route; a reviewer's decision is never written by the client.
 */

export interface ApplicationRow {
  festId: string;
  name: string;
  slug: string;
  festType: string | null;
  organizationName: string;
  organizationType: string | null;
  city: string | null;
  state: string | null;
  submittedAt: string | null;
  applicant: { id: string; emailVerified: boolean; name?: string; email?: string };
  hasIdentityDocument: boolean;
}

export const useApplications = (status: VerificationStatus) =>
  useQuery({
    queryKey: ["applications", status],
    queryFn: async () => (await api<{ status: VerificationStatus; applications: ApplicationRow[] }>(`/api/admin/verifications?status=${status}`)).applications,
  });

export const useDecideApplication = () => {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ festId, ...decision }: { festId: string } & ({ action: "approve" } | { action: "reject"; reason: string })) =>
      api<{ festId: string; status: "approved" | "rejected" }>(`/api/admin/fests/${festId}/verification`, { method: "POST", body: decision }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["applications"] }),
  });
};

/** A short-lived link to the applicant's identity document. Opening one is audited by the server. */
export const fetchApplicationDocument = (festId: string) => api<{ url: string }>(`/api/admin/fests/${festId}/verification/document`);
