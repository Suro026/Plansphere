"use client";

import * as React from "react";
import { CaretDown } from "@phosphor-icons/react";
import { cn } from "@/lib/utils";

/**
 * Form controls on native elements — Nocturne's forms are "no script", and the
 * native date, time and select pickers are what make the admin screens usable
 * on a phone at a venue. React Hook Form binds to these via `register`.
 */

export interface FieldProps extends React.HTMLAttributes<HTMLDivElement> {
  label?: React.ReactNode;
  htmlFor?: string;
  error?: string;
  hint?: React.ReactNode;
  /** Right-aligned content beside the label, e.g. a "Forgot?" link. */
  labelEnd?: React.ReactNode;
}

export const Field = ({ label, htmlFor, error, hint, labelEnd, className, children, ...props }: FieldProps) => (
  <div className={cn("field", className)} {...props}>
    {label ? (
      <div className="mb-[5px] flex items-baseline justify-between gap-3">
        <label htmlFor={htmlFor} className="!mb-0 field-label">
          {label}
        </label>
        {labelEnd}
      </div>
    ) : null}
    {children}
    {error ? (
      <div className="field-error" role="alert">
        {error}
      </div>
    ) : hint ? (
      <div className="field-hint">{hint}</div>
    ) : null}
  </div>
);

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean };

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, invalid, ...props }, ref) => (
    <input ref={ref} className={cn("input", className)} aria-invalid={invalid || undefined} {...props} />
  ),
);
Input.displayName = "Input";

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean };

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => (
    <textarea ref={ref} className={cn("input", className)} aria-invalid={invalid || undefined} {...props} />
  ),
);
Textarea.displayName = "Textarea";

export type SelectProps = React.SelectHTMLAttributes<HTMLSelectElement> & { invalid?: boolean };

export const NativeSelect = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, invalid, children, ...props }, ref) => (
    <div className="relative">
      <select ref={ref} className={cn("input", className)} aria-invalid={invalid || undefined} {...props}>
        {children}
      </select>
      <CaretDown
        size={14}
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-neutral-500"
        aria-hidden
      />
    </div>
  ),
);
NativeSelect.displayName = "NativeSelect";

/* ───────────── radio ───────────── */

export interface RadioOptionProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode;
  description?: React.ReactNode;
  block?: boolean;
}

export const RadioOption = React.forwardRef<HTMLInputElement, RadioOptionProps>(
  ({ label, description, block, className, ...props }, ref) => (
    <label className={cn("radio", block && "flex py-1", className)}>
      <input ref={ref} type="radio" {...props} />
      <span className="dot" aria-hidden />
      <span>
        {label}
        {description ? <span className="block text-[12px] text-neutral-500">{description}</span> : null}
      </span>
    </label>
  ),
);
RadioOption.displayName = "RadioOption";

/* ───────────── segmented control ───────────── */

export interface SegOption<T extends string> {
  value: T;
  label: React.ReactNode;
  disabled?: boolean;
}

export interface SegProps<T extends string> {
  options: ReadonlyArray<SegOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Stretch options to fill the container (the meal-slot picker). */
  fill?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * The `.seg` control as a proper radiogroup: arrow keys move, the selected
 * option carries the accent inset, and it works with no JavaScript for
 * selection — only the callback needs it.
 */
export function Seg<T extends string>({ options, value, onChange, fill, className, ...aria }: SegProps<T>) {
  const name = React.useId();
  return (
    <div className={cn("seg", fill && "seg-fill w-full", className)} role="radiogroup" aria-label={aria["aria-label"]}>
      {options.map((option) => (
        <label key={option.value} className="seg-opt">
          <input
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            disabled={option.disabled}
            onChange={() => onChange(option.value)}
          />
          {option.label}
        </label>
      ))}
    </div>
  );
}

/* ───────────── checkbox (native) ───────────── */

export interface CheckOptionProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: React.ReactNode;
  description?: React.ReactNode;
}

export const CheckOption = React.forwardRef<HTMLInputElement, CheckOptionProps>(
  ({ label, description, className, ...props }, ref) => (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-[14px]", className)}>
      <input
        ref={ref}
        type="checkbox"
        className="mt-[3px] h-4 w-4 flex-none cursor-pointer appearance-none rounded-[3px] border-[1.5px] border-divider bg-transparent checked:border-accent checked:bg-accent checked:[background-image:url(&quot;data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><path fill='none' stroke='%23f3f1ea' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' d='M3.5 8.5l2.8 2.8 6.2-6.6'/></svg>&quot;)] hover:border-accent focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        {...props}
      />
      <span>
        {label}
        {description ? <span className="block text-[12px] text-neutral-500">{description}</span> : null}
      </span>
    </label>
  ),
);
CheckOption.displayName = "CheckOption";
