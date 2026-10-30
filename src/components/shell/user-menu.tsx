"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { SignOut, User as UserIcon, ShieldCheck } from "@phosphor-icons/react";
import { hasAtLeast } from "@/core/models/user";
import { useAuth } from "@/components/providers";
import { Avatar, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from "@/components/ui/overlays";
import { Button } from "@/components/ui/button";

/**
 * The account control at the end of every nav.
 *
 * Signed out it is the design's outlined "Sign in". Signed in, on the student
 * side, it is the person's first name as an outlined button (2a); on the
 * admin side it is the bare avatar (2d). Both open the same menu.
 */
export const UserMenu = ({ variant = "student" }: { variant?: "student" | "admin" }) => {
  const { status, session, profile, signOut } = useAuth();
  const router = useRouter();

  if (status === "loading") return <div className="h-9 w-20" aria-hidden />;

  if (status === "signed-out" || !session) {
    return (
      <Button asChild variant="primary">
        <Link href="/sign-in">Sign in</Link>
      </Button>
    );
  }

  const name = profile?.fullName ?? session.displayName ?? session.email;
  const first = name.split(/\s+/)[0] ?? name;
  const isStaff = hasAtLeast(session.role, "volunteer");
  const profileHref =
    session.role === "super_admin"
      ? "/admin/platform/profile"
      : session.role === "admin"
        ? "/admin/profile"
        : session.role === "volunteer"
          ? "/volunteer/profile"
          : "/profile";

  return (
    <Menu>
      <MenuTrigger asChild>
        {variant === "student" ? (
          <button type="button" className="btn btn-primary" aria-label="Account menu">
            {first} {profile?.fullName ? profile.fullName.split(/\s+/)[1]?.[0] : ""}
          </button>
        ) : (
          <button type="button" className="rounded-full" aria-label="Account menu">
            <Avatar name={name} src={profile?.photoUrl} size={30} />
          </button>
        )}
      </MenuTrigger>
      <MenuContent align="end">
        <MenuLabel>{session.email}</MenuLabel>
        <MenuItem asChild>
          <Link href={profileHref}>
            <UserIcon size={15} /> Profile
          </Link>
        </MenuItem>
        {isStaff && variant === "student" ? (
          <MenuItem asChild>
            <Link href="/admin">
              <ShieldCheck size={15} /> Admin side
            </Link>
          </MenuItem>
        ) : null}
        {variant === "admin" ? (
          <MenuItem asChild>
            <Link href="/explore">
              <UserIcon size={15} /> Student side
            </Link>
          </MenuItem>
        ) : null}
        <MenuSeparator />
        <MenuItem
          onSelect={async () => {
            await signOut();
            router.push("/");
          }}
        >
          <SignOut size={15} /> Sign out
        </MenuItem>
      </MenuContent>
    </Menu>
  );
};
