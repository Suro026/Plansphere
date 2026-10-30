"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useAuth } from "@/components/providers";
import { useCreateFest } from "@/components/admin/platform-api";
import { Brand } from "@/components/shell/brand";
import { UserMenu } from "@/components/shell/user-menu";
import { FestFields, emptyFest, festFormSchema, toCreateFest, useFestForm } from "@/components/admin/fest-form";
import { Button } from "@/components/ui/button";
import { Kick, Note } from "@/components/ui/primitives";
import { RepositoryError } from "@/core/models/common";
import { hasAtLeast } from "@/core/models/user";

/** Create a fest. Admins and above; it starts as a draft. */
export default function NewFestPage() {
  const { session } = useAuth();
  const router = useRouter();
  const create = useCreateFest();
  const form = useFestForm(emptyFest());
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    // Creating the container is the platform owner's; an admin runs the
    // fests they are given.
    if (session && !hasAtLeast(session.role, "super_admin")) router.replace("/admin");
  }, [session, router]);

  const submit = async () => {
    const valid = await form.trigger();
    if (!valid) return toast.error("Some fields need fixing");
    setBusy(true);
    try {
      // Through the server, not the repository: this is a mutation that has
      // to land in the audit trail, and a trail the client writes is not one.
      const { fest } = await create.mutateAsync(toCreateFest(festFormSchema.parse(form.getValues())));
      toast.success("Fest created as a draft");
      router.push(`/admin/${fest.slug}/overview`);
    } catch (error) {
      toast.error(error instanceof RepositoryError ? error.message : "Couldn't create the fest");
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-divider">
        <nav className="nav mx-auto w-full max-w-[1180px] px-5 py-3.5 lg:px-8" aria-label="Admin">
          <Brand href="/admin" role="ADMIN" />
          <UserMenu variant="admin" />
        </nav>
      </header>
      <main id="main" className="mx-auto grid w-full max-w-[1180px] flex-1 gap-10 px-5 pb-[38px] pt-7 lg:grid-cols-[1fr_340px] lg:px-8">
        <div>
          <Kick className="mb-2">New fest</Kick>
          <h2 className="mb-[22px] text-[28px]">Set up a fest</h2>
          <form onSubmit={(e) => e.preventDefault()} noValidate>
            <FestFields form={form} />
          </form>
          <div className="mt-[26px] flex flex-wrap gap-2">
            <Button asChild variant="secondary">
              <Link href="/admin">Cancel</Link>
            </Button>
            <Button variant="primary" onClick={submit} loading={busy}>
              Create fest
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-3.5">
          <Note title="Under 30 minutes">
            Create the fest, add events with the wizard, invite the admins who run them, roster volunteers by gate. Publish when the lineup is ready — until then only staff can see it.
          </Note>
          <Note title="One address for everything">
            The fest lives at /f/&lt;address&gt;. Tickets, certificates and the public verification page all point back to it, so pick the address the college will print on posters.
          </Note>
        </div>
      </main>
    </div>
  );
}
