import { z } from "zod";
import { auditFieldsSchema, idSchema, shortTextSchema } from "./common";

/**
 * A physical or virtual place matches happen — "Arena A", "Ground 1", "Robo
 * Cage". One fest's own list; the live dashboard groups matches by arena,
 * and a volunteer's scoring shift names one by id (`Shift.post`).
 */
export const arenaSchema = z
  .object({
    id: idSchema,
    festId: idSchema,
    name: shortTextSchema,
    location: shortTextSchema.optional(),
    /** Inactive arenas are hidden from the "assign a match" picker, not deleted. */
    active: z.boolean().default(true),
    createdBy: idSchema,
  })
  .merge(auditFieldsSchema);

export type Arena = z.infer<typeof arenaSchema>;

export const createArenaSchema = z.object({
  festId: idSchema,
  name: shortTextSchema,
  location: shortTextSchema.optional(),
});

export type CreateArena = z.infer<typeof createArenaSchema>;

export const updateArenaSchema = z.object({
  name: shortTextSchema.optional(),
  location: shortTextSchema.optional(),
  active: z.boolean().optional(),
});

export type UpdateArena = z.infer<typeof updateArenaSchema>;
