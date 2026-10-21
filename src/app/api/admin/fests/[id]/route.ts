import { deletePaymentAccount, notifyPaymentAccountChange, suspendPaymentAccount } from "@/server/payments/account-change";
import { z } from "zod";
import { idSchema } from "@/core/models/common";
import { updateFestSchema } from "@/core/models/fest";
import { registrationFieldsSchema } from "@/core/models/registration-fields";
import { can, inScope } from "@/core/permissions";
import { ApiError, handler, ok, readBody, requirePermission } from "@/server/api";
import { COLLECTIONS, FieldValue, adminDb } from "@/server/firebase-admin";
import { compact, docToJson } from "@/server/serialize";
import { audit } from "@/server/audit";

/**
 * Global fest control: edit, archive, reopen, transfer, delete.
 *
 * The four verbs beyond "edit" are the super admin's alone, and each is
 * separated out rather than folded into the update body — partly because
 * they need their own guards (an archive changes what students can see; a
 * transfer changes who is accountable), and partly because an audit line
 * that says "archived" is worth more than one that says "updated: status".
 */

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("edit"), changes: updateFestSchema }),
  z.object({ action: z.literal("archive") }),
  z.object({ action: z.literal("reopen"), status: z.enum(["draft", "published"]).default("draft") }),
  z.object({ action: z.literal("transfer"), ownerId: idSchema }),
  z.object({ action: z.literal("registrationFields"), fields: registrationFieldsSchema }),
]);

const festFor = async (id: string) => {
  const ref = adminDb().collection(COLLECTIONS.fests).doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw ApiError.notFound("That fest no longer exists.");
  return { ref, data: snapshot.data() ?? {} };
};

/** PATCH /api/admin/fests/[id] */
export const PATCH = handler(async (request, context) => {
  // `fest:update` is the weakest of the verbs below; the rest are checked
  // individually once we know which one was asked for.
  const caller = await requirePermission(request, "fest:update");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing fest id.");
  if (!inScope(caller, id)) throw ApiError.forbidden("You do not manage this fest.");

  const input = await readBody(request, actionSchema);
  const { ref, data } = await festFor(id);
  const name = String(data.name ?? "this fest");

  const require = (permission: Parameters<typeof can>[1]) => {
    if (!can(caller.role, permission)) throw ApiError.forbidden("Only a super admin can do that.");
  };

  switch (input.action) {
    case "edit": {
      const changes = compact({ ...input.changes });
      if (Object.keys(changes).length === 0) throw ApiError.badRequest("Nothing to update.");

      // Publishing and unpublishing move through the same field, but only a
      // super admin may take a fest out of the archive this way.
      if (changes.status === "archived") require("fest:archive");

      await ref.update({ ...changes, updatedAt: FieldValue.serverTimestamp() });

      await audit(caller, {
        action: changes.status !== undefined && Object.keys(changes).length === 1 ? "fest_status_changed" : "fest_updated",
        summary:
          changes.status !== undefined && Object.keys(changes).length === 1
            ? `${name}: ${data.status ?? "draft"} → ${changes.status}`
            : `Updated ${name} · ${Object.keys(changes).join(", ")}`,
        festId: id,
        subjectType: "fest",
        subjectId: id,
        details: { fields: Object.keys(changes) },
      });

      break;
    }

    case "archive": {
      require("fest:archive");
      if (data.status === "archived") throw ApiError.unprocessable(`${name} is already archived.`);

      await ref.update({ status: "archived", archivedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });

      await audit(caller, {
        action: "fest_archived",
        summary: `Archived ${name}`,
        festId: id,
        subjectType: "fest",
        subjectId: id,
        details: { previousStatus: data.status ?? "draft" },
      });

      break;
    }

    case "reopen": {
      require("fest:archive");
      if (data.status !== "archived") throw ApiError.unprocessable(`${name} is not archived.`);

      await ref.update({ status: input.status, archivedAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() });

      await audit(caller, {
        action: "fest_reopened",
        summary: `Reopened ${name} as ${input.status}`,
        festId: id,
        subjectType: "fest",
        subjectId: id,
      });

      break;
    }

    case "transfer": {
      require("fest:transfer");

      const owner = await adminDb().collection(COLLECTIONS.users).doc(input.ownerId).get();
      if (!owner.exists) throw ApiError.unprocessable("No such account.");

      const ownerData = owner.data() ?? {};
      const ownerRole = ownerData.role === "organizer" ? "volunteer" : ownerData.role;
      if (ownerRole !== "admin" && ownerRole !== "super_admin") {
        throw ApiError.unprocessable("A fest can only be owned by an admin or a super admin.");
      }

      // Ownership without access is a broken state: give the new owner the
      // scope that goes with it, unless they are unscoped by role.
      const festIds: string[] = Array.isArray(ownerData.festIds) ? ownerData.festIds : [];
      if (ownerRole === "admin" && !festIds.includes(id)) {
        await owner.ref.update({ festIds: FieldValue.arrayUnion(id), updatedAt: FieldValue.serverTimestamp() });
      }

      await ref.update({ ownerId: input.ownerId, updatedAt: FieldValue.serverTimestamp() });

      // The payment account belongs to whoever owned the fest when it was set up. The new owner starts from a
      // suspended account and has to save, and have approved, credentials of their own.
      if (await suspendPaymentAccount(id, "ownership_transferred")) {
        await audit(caller, { action: "payment_account_suspended", summary: `Suspended the payment account of ${name} because ownership changed`, festId: id, subjectType: "fest", subjectId: id });
        await notifyPaymentAccountChange(id, caller.uid, "Payment account suspended", `${name} changed owner, so its payment account was suspended. The new owner needs to set up and get approval for their own.`);
      }

      await audit(caller, {
        action: "fest_transferred",
        summary: `${name} handed to ${ownerData.name ?? ownerData.fullName ?? ownerData.email ?? input.ownerId}`,
        festId: id,
        subjectType: "fest",
        subjectId: id,
        details: { from: data.ownerId ?? data.createdBy ?? null, to: input.ownerId, scopeGranted: ownerRole === "admin" },
      });

      break;
    }

    case "registrationFields": {
      require("fest:configureRegistration");

      // Two custom questions sharing a key would overwrite each other's
      // answers, so the set is checked before it is stored.
      const keys = input.fields.custom.map((f) => f.key);
      if (new Set(keys).size !== keys.length) throw ApiError.unprocessable("Two custom fields share the same key.");

      await ref.update({ registrationFields: input.fields, updatedAt: FieldValue.serverTimestamp() });

      const required = Object.entries(input.fields.builtIn ?? {}).filter(([, v]) => v === "required").length + input.fields.custom.filter((f) => f.requirement === "required").length;

      await audit(caller, {
        action: "fest_registration_fields_changed",
        summary: `${name}: ${required} required field(s), ${input.fields.custom.length} custom`,
        festId: id,
        subjectType: "fest",
        subjectId: id,
        details: { builtIn: input.fields.builtIn, custom: keys },
      });

      break;
    }
  }

  const updated = await ref.get();
  return ok({ fest: docToJson(updated) });
});

/**
 * DELETE /api/admin/fests/[id]
 *
 * Refused while anything still points at the fest. A fest with events,
 * registrations or certificates hanging off it cannot be deleted without
 * orphaning documents that people hold links to — archive it instead, which
 * is what the message says.
 */
export const DELETE = handler(async (request, context) => {
  const caller = await requirePermission(request, "fest:delete");
  const { id } = await context.params;
  if (!id) throw ApiError.badRequest("Missing fest id.");

  const db = adminDb();
  const { ref, data } = await festFor(id);

  const blockers: string[] = [];
  for (const [collection, label] of [
    [COLLECTIONS.events, "event"],
    [COLLECTIONS.registrations, "registration"],
    [COLLECTIONS.certificates, "certificate"],
  ] as const) {
    const found = await db.collection(collection).where("festId", "==", id).limit(1).get();
    if (!found.empty) blockers.push(label);
  }

  if (blockers.length > 0) {
    throw ApiError.unprocessable(
      `This fest still has ${blockers.join("s, ")}s attached. Archive it instead — deleting would orphan documents that students hold links to.`,
    );
  }

  // Nothing in a fest that can be deleted has payments, but its stored merchant credentials must not outlive it.
  await deletePaymentAccount(id);
  await ref.delete();

  await audit(caller, {
    action: "fest_deleted",
    summary: `Deleted ${data.name ?? id} (${data.slug ?? "no slug"})`,
    subjectType: "fest",
    subjectId: id,
    details: { slug: data.slug ?? null },
  });

  return ok({ id, deleted: true });
});
