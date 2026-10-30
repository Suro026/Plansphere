"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ImageUploadField } from "@/components/ui/image-upload";
import { useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { z } from "zod";
import { Page } from "@/components/shell/student-shell";
import { NotificationBell } from "@/components/shell/notifications";
import { useAuth, useRepositories } from "@/components/providers";
import { bucketEntries, useMyEntries } from "@/components/student/use-my-entries";
import { Avatar, Dialog, DialogActions, DialogContent } from "@/components/ui/overlays";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import { Kick, MetaList, MetaRow, Skeleton, Tag } from "@/components/ui/primitives";
import { phoneSchema, shortTextSchema } from "@/core/models/common";
import { hasAtLeast } from "@/core/models/user";

const editSchema = z.object({
  fullName: shortTextSchema,
  phone: phoneSchema,
  college: shortTextSchema,
  studentId: shortTextSchema,
  department: z.string().trim().max(200).optional(),
  year: z.string().trim().max(2).optional(),
  gender: z.string().trim().max(60).optional(),
  city: z.string().trim().max(200).optional(),
});

type EditValues = z.input<typeof editSchema>;

/** Masks all but the last two digits — the design shows "+91 98400 •••21". */
const maskPhone = (phone?: string) => (phone ? phone.replace(/\d(?=[\d\s]{2}$)|\d(?=\d{2}$)/g, "•").replace(/\d(?=\d{2}$)/g, "•") : "—");

/** 4b — Student profile. The three numbers, the account rows, and Edit. */
export default function ProfilePage() {
  const { session, profile, refresh, auth, signOut } = useAuth();
  const router = useRouter();
  const repos = useRepositories();
  const { entries } = useMyEntries();
  const { attended } = bucketEntries(entries);
  const [editing, setEditing] = React.useState(false);

  const certificates = useQuery({
    queryKey: ["my-certificates", session?.uid],
    enabled: Boolean(session),
    queryFn: () => repos.certificates.listForUser(session!.uid),
  });

  const wins = (certificates.data ?? []).filter((c) => c.type !== "participation").length;
  const teams = [...new Set(entries.filter((e) => e.registration.teamName).map((e) => e.registration.teamName!))];

  if (!profile || !session) {
    return (
      <Page className="max-w-[720px] pt-3">
        <Skeleton className="mb-5 h-14 w-64" />
        <Skeleton className="mb-5 h-20" />
        <Skeleton className="h-48" />
      </Page>
    );
  }

  const roleLabel = session.role === "student" ? "Student" : session.role.replace("_", " ");
  const subline = [profile.college, profile.department, profile.year ? `Year ${profile.year}` : null]
    .filter(Boolean)
    .join(" · ");

  const exportData = async () => {
    const blob = new Blob([JSON.stringify({ profile, entries: entries.map((e) => e.registration), certificates: certificates.data ?? [] }, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `plansphere-${session.uid}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Page className="max-w-[720px] pb-8 pt-3">
      <div className="flex items-center gap-[13px]">
        <Avatar name={profile.name} src={profile.avatar} size={56} />
        <div className="min-w-0 flex-1">
          <div className="text-[19px] font-medium tracking-[-0.015em]">{profile.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Tag tone="neutral" className="capitalize">{roleLabel}</Tag>
            {subline ? <span className="text-[11.5px] text-neutral-500">{subline}</span> : null}
          </div>
        </div>
        <NotificationBell className="sm:hidden" />
        <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
          Edit
        </Button>
      </div>

      <div className="-mx-[18px] mt-[18px] flex border-y border-divider sm:mx-0">
        {[
          { v: attended.length, l: "Attended" },
          { v: certificates.data?.length ?? 0, l: "Certificates" },
          { v: wins, l: "Wins" },
        ].map((s, i) => (
          <div key={s.l} className={`flex-1 px-[18px] py-3.5 ${i ? "border-l border-divider" : ""}`}>
            <div className="text-[22px] font-medium">{s.v}</div>
            <div className="mt-[3px] text-[10.5px] uppercase tracking-[0.08em] text-neutral-500">{s.l}</div>
          </div>
        ))}
      </div>

      <div className="pt-4">
        <Kick className="mb-2">Account</Kick>
        <MetaList>
          <MetaRow label="Email">
            {profile.email} {session.emailVerified ? null : <span className="text-accent-300">· unverified</span>}
          </MetaRow>
          <MetaRow label="Phone">{maskPhone(profile.phone)}</MetaRow>
          <MetaRow label="College ID">{profile.studentId ?? "—"}</MetaRow>
          <MetaRow label="Saved for forms">
            {[profile.college, profile.department, profile.year ? `Year ${profile.year}` : null, profile.city]
              .filter(Boolean)
              .join(" · ") || "Nothing yet — registration forms will remember what you enter."}
          </MetaRow>
          <MetaRow label="Notifications">Email</MetaRow>
          <MetaRow label="Download my data">
            <button type="button" className="text-accent" onClick={exportData}>
              JSON export
            </button>
          </MetaRow>
          <MetaRow label="Password">
            <button
              type="button"
              className="text-accent"
              onClick={async () => {
                await auth.sendPasswordReset(profile.email);
                toast.success("Reset link sent to your email");
              }}
            >
              Send reset link
            </button>
          </MetaRow>
          {hasAtLeast(session.role, "volunteer") ? (
            <MetaRow label="Staff access">
              <Link href="/admin" className="no-underline">Open the admin side</Link>
            </MetaRow>
          ) : null}
          {/* The header's account menu is hidden below 640px, so the phone's only way out is here. */}
          <MetaRow label="Session">
            <button
              type="button"
              className="text-accent"
              onClick={async () => {
                await signOut();
                router.push("/");
              }}
            >
              Sign out
            </button>
          </MetaRow>
        </MetaList>

        <Kick className="mb-2 mt-[18px]">Teams</Kick>
        <div className="flex flex-wrap gap-[7px]">
          {teams.map((t) => (
            <Tag key={t} tone="neutral">
              {t}
            </Tag>
          ))}
          <a href="/explore" className="tag tag-outline no-underline">
            + register a team
          </a>
        </div>
      </div>

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent title="Edit profile" description="Your name is what goes on certificates — spell it the way you want it printed.">
          <EditForm
            defaults={{
              fullName: profile.name,
              phone: profile.phone ?? "",
              college: profile.college ?? "",
              studentId: profile.studentId ?? "",
              department: profile.department ?? "",
              year: profile.year ? String(profile.year) : "",
              gender: profile.gender ?? "",
              city: profile.city ?? "",
            }}
            photoUrl={profile.avatar}
            onSaved={async () => {
              await refresh();
              setEditing(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </Page>
  );
}

const EditForm = ({ defaults, photoUrl: initialPhoto, onSaved }: { defaults: EditValues; photoUrl?: string; onSaved: () => Promise<void> }) => {
  const { session } = useAuth();
  const repos = useRepositories();
  const form = useForm<EditValues>({ resolver: zodResolver(editSchema), defaultValues: defaults });
  const err = form.formState.errors;
  const [photoUrl, setPhotoUrl] = React.useState(initialPhoto ?? "");

  const submit = form.handleSubmit(async (v) => {
    if (!session) return;
    try {
      await repos.users.update(session.uid, {
        name: v.fullName,
        phone: v.phone,
        ...(photoUrl ? { avatar: photoUrl } : {}),
        college: v.college,
        studentId: v.studentId,
        department: v.department || undefined,
        // Remembered for every future registration form. See
        // core/services/autofill.ts — this page is the one place these are
        // edited; a registration only ever fills a gap.
        ...(v.year && Number(v.year) >= 1 && Number(v.year) <= 6 ? { year: Number(v.year) } : {}),
        ...(v.gender ? { gender: v.gender } : {}),
        ...(v.city ? { city: v.city } : {}),
      });
      toast.success("Profile saved");
      await onSaved();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save");
    }
  });

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-3.5">
      <ImageUploadField id="e-photo" label="Photo" kind="profilePhoto" aspect="1/1" value={photoUrl} onChange={setPhotoUrl} allowUrl={false} hint="Square works best · PNG, JPEG or WebP up to 3 MB" />
      <Field label="Full name" htmlFor="e-name" error={err.fullName?.message}>
        <Input id="e-name" {...form.register("fullName")} />
      </Field>
      <Field label="Phone" htmlFor="e-phone" error={err.phone?.message}>
        <Input id="e-phone" type="tel" {...form.register("phone")} />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="College" htmlFor="e-college" error={err.college?.message}>
          <Input id="e-college" {...form.register("college")} />
        </Field>
        <Field label="College ID" htmlFor="e-sid" error={err.studentId?.message}>
          <Input id="e-sid" {...form.register("studentId")} />
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Department" htmlFor="e-dept">
          <Input id="e-dept" {...form.register("department")} />
        </Field>
        <Field label="Year of study" htmlFor="e-year" error={err.year?.message}>
          <NativeSelect id="e-year" {...form.register("year")}>
            <option value="">—</option>
            {["1", "2", "3", "4", "5"].map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="City" htmlFor="e-city" error={err.city?.message}>
          <Input id="e-city" {...form.register("city")} />
        </Field>
        <Field label="Gender" htmlFor="e-gender" error={err.gender?.message} hint="Optional — some fests ask.">
          <NativeSelect id="e-gender" {...form.register("gender")}>
            <option value="">Prefer not to say</option>
            {["Female", "Male", "Non-binary", "Prefer not to say"].map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <DialogActions>
        <Button type="submit" variant="primary" loading={form.formState.isSubmitting}>
          Save
        </Button>
      </DialogActions>
    </form>
  );
};
