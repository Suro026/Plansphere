"use client";

import * as React from "react";
import { toast } from "sonner";
import { RepositoryError } from "@/core/models/common";
import type { Event } from "@/core/models/event";
import { api } from "@/data/api-client";
import { Button } from "@/components/ui/button";
import { CheckOption, Field, Input, NativeSelect, Textarea } from "@/components/ui/field";
import { Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";

/**
 * "Announce" — one message to everyone holding a confirmed entry, in-app and
 * optionally by email. Admin-only (the route enforces it); the dialog just
 * makes the reach explicit before the send.
 */
export const AnnounceDialog = ({ festId, festName, events }: { festId: string; festName: string; events: Event[] }) => {
  const [open, setOpen] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [body, setBody] = React.useState("");
  const [eventId, setEventId] = React.useState("");
  const [email, setEmail] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  const reset = () => {
    setTitle("");
    setBody("");
    setEventId("");
    setEmail(false);
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim() || !body.trim()) return;
    setBusy(true);
    try {
      const result = await api<{ recipients: number; notified: number; emailed: number }>(`/api/admin/fests/${festId}/announcements`, {
        method: "POST",
        body: { title: title.trim(), body: body.trim(), ...(eventId ? { eventId } : {}), email },
      });
      toast.success(
        result.recipients === 0
          ? "Nobody to announce to yet — no confirmed entries."
          : `Sent to ${result.notified} participant${result.notified === 1 ? "" : "s"}${email ? ` · ${result.emailed} emailed` : ""}`,
      );
      setOpen(false);
      reset();
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn’t send the announcement");
    } finally {
      setBusy(false);
    }
  };

  const scope = eventId ? (events.find((ev) => ev.id === eventId)?.title ?? "that event") : festName;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Announce
      </Button>
      <DialogContent title="Announce to participants" description="Everyone with a confirmed entry gets it in their notifications. Tick email to reach inboxes too." size="md">
        <form onSubmit={submit} className="flex flex-col gap-3.5">
          <Field label="Audience" htmlFor="announce-scope">
            <NativeSelect id="announce-scope" value={eventId} onChange={(e) => setEventId(e.target.value)}>
              <option value="">Whole fest — {festName}</option>
              {events
                .filter((ev) => ev.status !== "draft" && ev.status !== "cancelled")
                .map((ev) => (
                  <option key={ev.id} value={ev.id}>
                    {ev.title} · {ev.registeredCount} registered
                  </option>
                ))}
            </NativeSelect>
          </Field>
          <Field label="Title" htmlFor="announce-title">
            <Input id="announce-title" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} placeholder="Venue change for the finals" autoFocus />
          </Field>
          <Field label="Message" htmlFor="announce-body" hint={`${body.length}/2000`}>
            <Textarea id="announce-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={2000} rows={5} placeholder="Keep it to what they need to do differently." />
          </Field>
          <CheckOption label="Also send by email" description={`One email per participant of ${scope}. Slower, but reaches people who haven’t opened the app.`} checked={email} onChange={(e) => setEmail(e.target.checked)} />
          <DialogActions>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={busy} disabled={!title.trim() || !body.trim()}>
              Send announcement
            </Button>
          </DialogActions>
        </form>
      </DialogContent>
    </Dialog>
  );
};
