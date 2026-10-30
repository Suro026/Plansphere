"use client";

import * as React from "react";
import { toast } from "sonner";
import { useAuth } from "@/components/providers";
import { Button } from "@/components/ui/button";
import { AlertDialog, AlertDialogContent } from "@/components/ui/overlays";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { MetaList, MetaRow, StatusBanner, Tag } from "@/components/ui/primitives";
import { api } from "@/data/api-client";
import { hasAtLeast } from "@/core/models/user";

interface Provider {
  id: string;
  label: string;
  modes: string[];
  credentialFields: Array<{ key: string; label: string; secret: boolean; optional?: boolean }>;
}

interface View {
  platform: { enabled: boolean; liveEnabled: boolean };
  providers: Provider[];
  account: { provider: string; mode: string; status: string; merchantRef: string | null; merchantId: string | null; merchantName: string | null; credentialsVersion: number; credentialsSaved: boolean } | null;
  /** What this signed-in person may do — the server enforces it; the screen just shows what will work. */
  canConfigure: boolean;
  canApprove: boolean;
  available: boolean;
  blocker: string | null;
  webhookUrl: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  pending_review: "Waiting for approval",
  active: "Approved",
  suspended: "Suspended",
  not_configured: "Not set up",
};

/**
 * A fest's own merchant account for online payment.
 *
 * Credentials are write-only here: they are sent once, encrypted on the server,
 * and never shown again — the form only ever says whether they are saved.
 * Plansphere does not hold the money and takes no commission; payments settle
 * in the fest's own account with its payment provider.
 */
export const PaymentAccountPanel = ({ festId }: { festId: string }) => {
  const { session } = useAuth();
  const isSuper = session ? hasAtLeast(session.role, "super_admin") : false;
  const [view, setView] = React.useState<View | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [provider, setProvider] = React.useState("");
  const [mode, setMode] = React.useState("sandbox");
  const [merchantRef, setMerchantRef] = React.useState("");
  const [credentials, setCredentials] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [confirmApprove, setConfirmApprove] = React.useState(false);

  const apply = React.useCallback((next: View) => {
    setView(next);
    setProvider((current) => current || next.account?.provider || next.providers[0]?.id || "");
    setMode((current) => next.account?.mode ?? current);
    setMerchantRef((current) => current || next.account?.merchantRef || "");
  }, []);

  React.useEffect(() => {
    let live = true;
    api<View>(`/api/admin/fests/${festId}/payments`)
      .then((v) => live && apply(v))
      .catch(() => live && setLoadError(true));
    return () => {
      live = false;
    };
  }, [festId, apply]);

  if (loadError) return <StatusBanner tone="neutral">Online payment settings couldn’t be loaded.</StatusBanner>;
  if (!view) return <div className="text-[13px] text-neutral-500">Loading…</div>;

  const selected = view.providers.find((p) => p.id === provider);

  const save = async () => {
    if (!selected) return;
    setBusy("save");
    try {
      const next = await api<View>(`/api/admin/fests/${festId}/payments`, {
        method: "PUT",
        body: { provider: selected.id, mode, ...(merchantRef.trim() ? { merchantRef: merchantRef.trim() } : {}), credentials: Object.fromEntries(Object.entries(credentials).filter(([, v]) => v.trim())) },
      });
      setCredentials({});
      apply(next);
      toast.success("Saved — waiting for approval by the platform administrator");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t save");
    } finally {
      setBusy(null);
    }
  };

  const review = async (action: "approve" | "suspend") => {
    if (!view) return;
    setBusy(action);
    try {
      // Approval names the exact version and merchant that was reviewed; the server refuses if either has changed.
      const body = action === "approve" ? { action, expectedVersion: view.account?.credentialsVersion ?? 0, confirmMerchantId: view.account?.merchantId ?? "" } : { action };
      apply(await api<View>(`/api/admin/fests/${festId}/payments`, { method: "POST", body }));
      toast.success(action === "approve" ? "Payment account approved" : "Payment account suspended");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn’t update");
    } finally {
      setBusy(null);
    }
  };

  const complete = selected ? selected.credentialFields.filter((f) => !f.optional).every((f) => (credentials[f.key] ?? "").trim().length > 0) : false;

  return (
    <div className="flex flex-col gap-4">
      {!view.platform.enabled ? (
        <StatusBanner tone="neutral">Online payment is switched off for this deployment, so no event can collect payments yet. Free events are not affected.</StatusBanner>
      ) : null}

      {view.providers.length === 0 ? (
        <p className="max-w-[68ch] text-[13.5px] text-neutral-400">
          No payment provider is enabled on this deployment. Free events work as usual; paid events can’t be published until a provider has been verified and added.
        </p>
      ) : (
        <>
          <MetaList>
            <MetaRow label="Status">
              <Tag tone={view.account?.status === "active" ? "accent" : "neutral"}>{STATUS_LABEL[view.account?.status ?? "not_configured"] ?? "Not set up"}</Tag>
            </MetaRow>
            {view.account ? <MetaRow label="Provider">{view.providers.find((p) => p.id === view.account!.provider)?.label ?? view.account.provider} · {view.account.mode}</MetaRow> : null}
            {view.account?.merchantName ? <MetaRow label="Merchant (per provider)">{view.account.merchantName}</MetaRow> : null}
            {view.account ? <MetaRow label="Credentials">{view.account.credentialsSaved ? "Saved (hidden)" : "Not saved"}</MetaRow> : null}
            {view.webhookUrl ? (
              <MetaRow label="Webhook URL" mono>
                {view.webhookUrl}
              </MetaRow>
            ) : null}
            {view.blocker && view.account ? <MetaRow label="Not usable yet">{view.blocker}</MetaRow> : null}
          </MetaList>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Provider" htmlFor="pay-provider">
              <NativeSelect id="pay-provider" value={provider} onChange={(e) => { setProvider(e.target.value); setCredentials({}); }}>
                {view.providers.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Mode" htmlFor="pay-mode" hint={mode === "live" && !view.platform.liveEnabled ? "Live payments are not enabled on this deployment yet." : undefined}>
              <NativeSelect id="pay-mode" value={mode} onChange={(e) => setMode(e.target.value)}>
                {(selected?.modes ?? ["sandbox"]).map((m) => (
                  <option key={m} value={m}>
                    {m === "live" ? "Live (real money)" : "Sandbox (no real money)"}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Merchant reference (optional)" htmlFor="pay-ref" hint="Your merchant or app id — for the records. Not a secret." className="sm:col-span-2">
              <Input id="pay-ref" value={merchantRef} maxLength={200} onChange={(e) => setMerchantRef(e.target.value)} />
            </Field>
            {selected?.credentialFields.map((f) => (
              <Field key={f.key} label={f.label} htmlFor={`pay-${f.key}`} hint={view.account?.credentialsSaved ? "Saved. Enter a new value only to replace it." : undefined}>
                <Input
                  id={`pay-${f.key}`}
                  type={f.secret ? "password" : "text"}
                  autoComplete="off"
                  spellCheck={false}
                  value={credentials[f.key] ?? ""}
                  onChange={(e) => setCredentials((c) => ({ ...c, [f.key]: e.target.value }))}
                />
              </Field>
            ))}
          </div>

          {!view.canConfigure ? (
            <p className="max-w-[68ch] text-[12.5px] text-neutral-400">Only the fest’s owner or a platform administrator can change where payments go. You can see the status here and will be told when it changes.</p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {view.canConfigure ? (
              <Button variant="primary" onClick={save} loading={busy === "save"} disabled={!complete}>
                Save for approval
              </Button>
            ) : null}
            {isSuper && view.account && view.account.status !== "active" ? (
              <AlertDialog open={confirmApprove} onOpenChange={setConfirmApprove}>
                <Button variant="secondary" onClick={() => setConfirmApprove(true)} disabled={!view.account.credentialsSaved || !view.account.merchantId || !view.canApprove}>
                  Approve account
                </Button>
                <AlertDialogContent
                  title={`Approve ${view.account.merchantName ?? "this merchant"}?`}
                  description={`The provider says these credentials belong to “${view.account.merchantName ?? "an unidentified merchant"}” (${view.account.merchantId ?? "no id"}). Payments for this fest will settle there. Only approve if that is the institution’s own account.`}
                  confirmLabel="Approve"
                  loading={busy === "approve"}
                  onConfirm={async () => {
                    await review("approve");
                    setConfirmApprove(false);
                  }}
                />
              </AlertDialog>
            ) : null}
            {isSuper && view.account && view.account.status !== "active" && !view.canApprove ? (
              <span className="self-center text-[12px] text-neutral-500">A different platform administrator has to approve credentials you saved.</span>
            ) : null}
            {isSuper && view.account?.status === "active" ? (
              <Button variant="danger" onClick={() => review("suspend")} loading={busy === "suspend"}>
                Suspend
              </Button>
            ) : null}
          </div>
          <p className="max-w-[68ch] text-[12px] text-neutral-500">
            Payments go straight to your own merchant account — Plansphere never holds the money and adds no fee or commission. Saving new credentials sends the account back for approval.
          </p>
        </>
      )}
    </div>
  );
};
