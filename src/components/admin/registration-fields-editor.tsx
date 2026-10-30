"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Trash } from "@phosphor-icons/react";

import {
  BUILT_IN_FIELDS,
  BUILT_IN_FIELD_DEFINITIONS,
  FIELD_REQUIREMENTS,
  FIELD_TYPES,
  IDENTITY_FIELDS,
  defaultRegistrationFields,
  fieldKeyFor,
  visibleFields,
  type BuiltInField,
  type CustomField,
  type FieldRequirement,
  type RegistrationFields,
} from "@/core/models/registration-fields";
import { Button } from "@/components/ui/button";
import { Field, Input, NativeSelect } from "@/components/ui/field";
import { Kick, Note, Tag } from "@/components/ui/primitives";

/**
 * What this fest asks its students for.
 *
 * Each built-in field is required, optional or hidden; custom questions are
 * added below with their own label and type. The preview on the right is the
 * same `visibleFields` the registration form renders from, so what is shown
 * here is literally what a student will see — not a drawing of it.
 *
 * Name and email are not listed: they come from the signed-in account, and a
 * certificate addressed to a retyped "asdf" is the reason they are not
 * editable.
 */

const REQUIREMENT_LABELS: Record<FieldRequirement, string> = {
  required: "Required",
  optional: "Optional",
  hidden: "Not asked",
};

export interface RegistrationFieldsEditorProps {
  /** What is already saved — a fest's default set, or an event's own override. */
  initial: RegistrationFields | undefined;
  /** Persists the edited configuration. Throw to show the standard error toast. */
  onSave: (fields: RegistrationFields) => Promise<void>;
  onDone?: () => void;
  /**
   * Shown above the field list. An event's copy explains that this adds to
   * the fest's own questions rather than replacing them; the fest's copy
   * needs no such caveat.
   */
  note?: React.ReactNode;
  /** Label on the primary button — "Save the form" for a fest, "Save override" for an event. */
  saveLabel?: string;
}

export const RegistrationFieldsEditor = ({ initial, onSave, onDone, note, saveLabel = "Save the form" }: RegistrationFieldsEditorProps) => {
  const [fields, setFields] = React.useState<RegistrationFields>(() => initial ?? defaultRegistrationFields());
  const [saving, setSaving] = React.useState(false);
  const [newLabel, setNewLabel] = React.useState("");

  const setBuiltIn = (key: BuiltInField, requirement: FieldRequirement) =>
    setFields((prev) => ({ ...prev, builtIn: { ...prev.builtIn, [key]: requirement } }));

  const setCustom = (index: number, changes: Partial<CustomField>) =>
    setFields((prev) => ({
      ...prev,
      custom: prev.custom.map((field, i) => (i === index ? { ...field, ...changes } : field)),
    }));

  const addCustom = () => {
    const label = newLabel.trim();
    if (!label) return;

    let key = fieldKeyFor(label);
    // Keys are frozen once answers exist under them, so a collision gets a
    // suffix rather than silently sharing a column.
    const taken = new Set(fields.custom.map((field) => field.key));
    if (taken.has(key)) {
      let n = 2;
      while (taken.has(`${key}_${n}`)) n += 1;
      key = `${key}_${n}`;
    }

    setFields((prev) => ({ ...prev, custom: [...prev.custom, { key, label, type: "text", requirement: "optional" }] }));
    setNewLabel("");
  };

  const removeCustom = (index: number) =>
    setFields((prev) => ({ ...prev, custom: prev.custom.filter((_, i) => i !== index) }));

  const save = async () => {
    setSaving(true);
    try {
      await onSave(fields);
      toast.success("Registration form updated");
      onDone?.();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Couldn't save the fields");
    } finally {
      setSaving(false);
    }
  };

  const preview = visibleFields(fields);
  const editable = BUILT_IN_FIELDS.filter((key) => !(IDENTITY_FIELDS as readonly string[]).includes(key));

  return (
    <div className="grid grid-cols-1 gap-7 lg:grid-cols-[1fr_300px]">
      <div>
        {note}
        <Kick className="mb-2">Standard details</Kick>
        <div className="flex flex-col">
          {editable.map((key) => {
            const definition = BUILT_IN_FIELD_DEFINITIONS[key];
            const current = fields.builtIn?.[key] ?? "hidden";
            return (
              <div key={key} className="flex items-center gap-3 border-t border-divider py-2.5 first:border-t-0">
                <div className="min-w-0 flex-1">
                  <div className="text-[13.5px]">{definition.label}</div>
                  {definition.profileKey ? (
                    <div className="text-[11.5px] text-neutral-500">Pre-filled from their profile when they have one</div>
                  ) : null}
                </div>
                <div className="seg flex-none" role="radiogroup" aria-label={definition.label}>
                  {FIELD_REQUIREMENTS.map((requirement) => (
                    <label key={requirement} className="seg-opt" data-state={current === requirement ? "on" : undefined}>
                      <input
                        type="radio"
                        name={`req-${key}`}
                        value={requirement}
                        checked={current === requirement}
                        onChange={() => setBuiltIn(key, requirement)}
                      />
                      {REQUIREMENT_LABELS[requirement]}
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>

        <Kick className="mb-2 mt-7">Custom questions</Kick>
        {fields.custom.length === 0 ? (
          <p className="mb-3 text-[13px] text-neutral-500">None yet — anything the list above does not cover goes here.</p>
        ) : (
          <div className="mb-3 flex flex-col gap-2.5">
            {fields.custom.map((field, index) => (
              <div key={field.key} className="panel flex flex-col gap-2.5 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-mono text-[11.5px] text-neutral-500">{field.key}</span>
                  <button type="button" className="btn btn-ghost px-2 text-[12px]" onClick={() => removeCustom(index)} aria-label={`Remove ${field.label}`}>
                    <Trash size={14} />
                  </button>
                </div>
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
                  <Field label="Label" htmlFor={`cf-label-${field.key}`}>
                    <Input id={`cf-label-${field.key}`} value={field.label} onChange={(event) => setCustom(index, { label: event.target.value })} />
                  </Field>
                  <Field label="Type" htmlFor={`cf-type-${field.key}`}>
                    <NativeSelect
                      id={`cf-type-${field.key}`}
                      value={field.type}
                      onChange={(event) => setCustom(index, { type: event.target.value as CustomField["type"] })}
                    >
                      {FIELD_TYPES.map((type) => (
                        <option key={type} value={type}>
                          {type}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                  <Field label="Asked" htmlFor={`cf-req-${field.key}`}>
                    <NativeSelect
                      id={`cf-req-${field.key}`}
                      value={field.requirement}
                      onChange={(event) => setCustom(index, { requirement: event.target.value as FieldRequirement })}
                    >
                      {FIELD_REQUIREMENTS.map((requirement) => (
                        <option key={requirement} value={requirement}>
                          {REQUIREMENT_LABELS[requirement]}
                        </option>
                      ))}
                    </NativeSelect>
                  </Field>
                </div>
                {field.type === "select" ? (
                  <Field label="Choices" htmlFor={`cf-opt-${field.key}`} hint="Comma separated.">
                    <Input
                      id={`cf-opt-${field.key}`}
                      value={(field.options ?? []).join(", ")}
                      onChange={(event) =>
                        setCustom(index, {
                          options: event.target.value
                            .split(",")
                            .map((option) => option.trim())
                            .filter(Boolean),
                        })
                      }
                    />
                  </Field>
                ) : null}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-wrap items-end gap-2">
          <Field label="Add a question" htmlFor="cf-new" className="min-w-[240px] flex-1">
            <Input
              id="cf-new"
              placeholder="T-shirt size"
              value={newLabel}
              onChange={(event) => setNewLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addCustom();
                }
              }}
            />
          </Field>
          <Button variant="secondary" onClick={addCustom} disabled={!newLabel.trim()}>
            <Plus size={14} /> Add
          </Button>
        </div>

        <div className="mt-6 flex flex-wrap gap-2">
          <Button variant="primary" onClick={save} loading={saving}>
            {saveLabel}
          </Button>
          <Button variant="secondary" onClick={() => setFields(defaultRegistrationFields())}>
            Reset to defaults
          </Button>
        </div>
      </div>

      <aside>
        <Kick className="mb-2">What a student sees</Kick>
        {preview.length === 0 ? (
          <p className="text-[13px] text-neutral-500">Just their name and email, taken from their account. The shortest possible form.</p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {preview.map((field) => (
              <div key={field.key} className="flex items-center justify-between gap-2 border-t border-divider py-1.5 first:border-t-0">
                <span className="truncate text-[13px]">{field.label}</span>
                {field.requirement === "required" ? <Tag tone="accent">Required</Tag> : <Tag tone="outline">Optional</Tag>}
              </div>
            ))}
          </div>
        )}

        <Note title="Changing this later is safe" className="mt-4">
          Answers already collected are stored as they were given and are never rewritten, so last year&rsquo;s entries still make sense after the form changes. Hiding a field stops it being asked; it does not delete what people have already answered.
        </Note>
      </aside>
    </div>
  );
};
