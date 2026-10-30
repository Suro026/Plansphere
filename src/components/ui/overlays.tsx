"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as DropdownPrimitive from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as AvatarPrimitive from "@radix-ui/react-avatar";
import { Drawer as VaulDrawer } from "vaul";
import { X } from "@phosphor-icons/react";
import { Toaster as SonnerToaster } from "sonner";
import { cn, initials } from "@/lib/utils";

/**
 * Overlays and the few primitives that need behaviour: Radix for focus
 * management, escape handling and ARIA; Vaul for the bottom sheet the
 * registration flow uses on a phone. All styled with Nocturne tokens.
 */

/* ───────────── dialog ───────────── */

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Wider dialogs for tables and forms; default is 440px per the DS. */
  size?: "sm" | "md" | "lg";
  hideClose?: boolean;
}

const dialogWidth = { sm: "max-w-[440px]", md: "max-w-[560px]", lg: "max-w-[760px]" };

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(({ title, description, size = "sm", hideClose, className, children, ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="dialog-backdrop data-[state=open]:animate-fade-in" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        "dialog fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
        "max-h-[calc(100dvh-2rem)] overflow-y-auto data-[state=open]:animate-rise",
        dialogWidth[size],
        className,
      )}
      {...props}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <DialogPrimitive.Title className="dialog-title">{title}</DialogPrimitive.Title>
          {description ? (
            <DialogPrimitive.Description className="mt-1 text-[13px] text-neutral-500">
              {description}
            </DialogPrimitive.Description>
          ) : (
            <DialogPrimitive.Description className="sr-only">{title}</DialogPrimitive.Description>
          )}
        </div>
        {hideClose ? null : (
          <DialogPrimitive.Close className="btn btn-secondary btn-icon -mr-1 -mt-1 h-8 w-8" aria-label="Close">
            <X size={15} />
          </DialogPrimitive.Close>
        )}
      </div>
      {children}
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
));
DialogContent.displayName = "DialogContent";

export const DialogActions = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("dialog-actions", className)} {...props} />
);

/* ───────────── alert dialog (confirmations) ───────────── */

export const AlertDialog = AlertDialogPrimitive.Root;
export const AlertDialogTrigger = AlertDialogPrimitive.Trigger;

export interface AlertDialogContentProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void | Promise<void>;
  children?: React.ReactNode;
}

export const AlertDialogContent = ({
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive,
  loading,
  onConfirm,
  children,
}: AlertDialogContentProps) => (
  <AlertDialogPrimitive.Portal>
    <AlertDialogPrimitive.Overlay className="dialog-backdrop data-[state=open]:animate-fade-in" />
    <AlertDialogPrimitive.Content
      className={cn(
        "dialog fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-[440px] -translate-x-1/2 -translate-y-1/2",
        "data-[state=open]:animate-rise",
      )}
    >
      <AlertDialogPrimitive.Title className="dialog-title">{title}</AlertDialogPrimitive.Title>
      {description ? (
        <AlertDialogPrimitive.Description className="dialog-body">{description}</AlertDialogPrimitive.Description>
      ) : null}
      {children}
      <div className="dialog-actions">
        <AlertDialogPrimitive.Cancel className="btn btn-secondary" disabled={loading}>
          {cancelLabel}
        </AlertDialogPrimitive.Cancel>
        <AlertDialogPrimitive.Action
          className={cn("btn", destructive ? "btn-danger" : "btn-primary")}
          disabled={loading}
          onClick={(event) => {
            // Keep the dialog open while an async confirm is in flight; the
            // caller closes it by flipping `open` once the work is done.
            event.preventDefault();
            void onConfirm();
          }}
        >
          {loading ? "Working…" : confirmLabel}
        </AlertDialogPrimitive.Action>
      </div>
    </AlertDialogPrimitive.Content>
  </AlertDialogPrimitive.Portal>
);

/* ───────────── bottom sheet (mobile) ───────────── */

export const Sheet = VaulDrawer.Root;
export const SheetTrigger = VaulDrawer.Trigger;
export const SheetClose = VaulDrawer.Close;

export interface SheetContentProps extends Omit<React.ComponentPropsWithoutRef<typeof VaulDrawer.Content>, "title"> {
  title: React.ReactNode;
  description?: React.ReactNode;
}

/**
 * The registration sheet from the design: rounded top, drag handle, surface
 * fill at the top elevation. On wider screens the same flow is rendered as a
 * side column, so this is only ever mounted below `sm`.
 */
export const SheetContent = React.forwardRef<
  React.ComponentRef<typeof VaulDrawer.Content>,
  SheetContentProps
>(({ title, description, className, children, ...props }, ref) => (
  <VaulDrawer.Portal>
    <VaulDrawer.Overlay className="dialog-backdrop" />
    <VaulDrawer.Content
      ref={ref}
      className={cn(
        "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg bg-surface shadow-lg outline-none",
        className,
      )}
      {...props}
    >
      <div className="mx-auto mb-3.5 mt-4 h-[3px] w-[34px] flex-none rounded-full bg-neutral-700" aria-hidden />
      <div className="flex-1 overflow-y-auto px-[18px] pb-[calc(22px+env(safe-area-inset-bottom))]">
        <VaulDrawer.Title className="text-[20px] font-medium leading-tight">{title}</VaulDrawer.Title>
        {description ? (
          <VaulDrawer.Description className="mb-4 mt-[3px] text-[12px] text-neutral-500">
            {description}
          </VaulDrawer.Description>
        ) : (
          <VaulDrawer.Description className="sr-only">{title}</VaulDrawer.Description>
        )}
        {children}
      </div>
    </VaulDrawer.Content>
  </VaulDrawer.Portal>
));
SheetContent.displayName = "SheetContent";

/* ───────────── dropdown menu ───────────── */

export const Menu = DropdownPrimitive.Root;
export const MenuTrigger = DropdownPrimitive.Trigger;

export const MenuContent = React.forwardRef<
  React.ComponentRef<typeof DropdownPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Content>
>(({ className, sideOffset = 6, ...props }, ref) => (
  <DropdownPrimitive.Portal>
    <DropdownPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 min-w-[180px] rounded-md bg-surface p-1 shadow-md data-[state=open]:animate-rise",
        className,
      )}
      {...props}
    />
  </DropdownPrimitive.Portal>
));
MenuContent.displayName = "MenuContent";

export const MenuItem = React.forwardRef<
  React.ComponentRef<typeof DropdownPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof DropdownPrimitive.Item> & { destructive?: boolean }
>(({ className, destructive, ...props }, ref) => (
  <DropdownPrimitive.Item
    ref={ref}
    className={cn(
      "flex cursor-pointer select-none items-center gap-2 rounded-sm px-2.5 py-1.5 text-[13.5px] outline-none",
      "data-[highlighted]:bg-[color-mix(in_srgb,var(--color-text)_7%,transparent)]",
      "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
      destructive && "text-danger",
      className,
    )}
    {...props}
  />
));
MenuItem.displayName = "MenuItem";

export const MenuLabel = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("kick px-2.5 pb-1 pt-2", className)} {...props} />
);

export const MenuSeparator = () => <DropdownPrimitive.Separator className="my-1 h-px bg-divider" />;

/* ───────────── tooltip ───────────── */

export const TooltipProvider = TooltipPrimitive.Provider;

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
}

export const Tooltip = ({ content, children, side = "top" }: TooltipProps) => (
  <TooltipPrimitive.Root delayDuration={300}>
    <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        side={side}
        sideOffset={6}
        className="z-50 max-w-[260px] rounded-sm bg-neutral-100 px-2.5 py-1.5 text-[12px] text-bg shadow-md data-[state=delayed-open]:animate-fade-in"
      >
        {content}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  </TooltipPrimitive.Root>
);

/* ───────────── avatar ───────────── */

export interface AvatarProps {
  name?: string | null;
  src?: string | null;
  size?: number;
  className?: string;
}

export const Avatar = ({ name, src, size = 30, className }: AvatarProps) => (
  <AvatarPrimitive.Root
    className={cn("inline-flex flex-none select-none overflow-hidden rounded-full bg-neutral-800 shadow-[inset_0_0_0_1px_var(--color-divider)]", className)}
    style={{ width: size, height: size }}
  >
    {src ? <AvatarPrimitive.Image src={src} alt={name ?? ""} className="h-full w-full object-cover" /> : null}
    <AvatarPrimitive.Fallback
      className="grid h-full w-full place-items-center text-neutral-300"
      style={{ fontSize: Math.max(10, Math.round(size * 0.38)) }}
      delayMs={src ? 300 : 0}
    >
      {initials(name)}
    </AvatarPrimitive.Fallback>
  </AvatarPrimitive.Root>
);

/* ───────────── toaster ───────────── */

export const Toaster = () => (
  <SonnerToaster
    position="bottom-center"
    theme="dark"
    offset={20}
    toastOptions={{
      unstyled: true,
      classNames: {
        toast:
          "flex w-full items-start gap-3 rounded-md bg-surface px-4 py-3 text-[13.5px] text-text shadow-md font-sans",
        title: "font-medium",
        description: "text-neutral-400 text-[12.5px]",
        actionButton: "btn btn-ghost btn-sm ml-auto",
        cancelButton: "btn btn-secondary btn-sm",
        icon: "mt-0.5 text-accent",
        error: "[&_[data-icon]]:text-danger",
      },
    }}
  />
);
