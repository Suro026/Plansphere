import Image from "next/image";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { SITE } from "@/lib/site";

/**
 * The wordmark. Nocturne's header brand is the official logo image — it
 * already carries the "Plansphere" wordmark, so no separate text is
 * rendered beside it; the role label ("ADMIN", "VOLUNTEER") is how the
 * design tells the two halves of the product apart without changing the
 * chrome.
 */
export const Brand = ({
  role,
  href = "/",
  className,
}: {
  role?: string;
  href?: string;
  className?: string;
}) => (
  <Link href={href} className={cn("nav-brand", className)}>
    <Image
      src="/logo.png"
      alt={SITE.name}
      width={128}
      height={64}
      className="h-7 w-auto object-contain sm:h-8"
      priority
    />
    {role ? <span className="nav-role">{role}</span> : null}
  </Link>
);
