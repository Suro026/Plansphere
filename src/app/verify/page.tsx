import type { Metadata } from "next";
import { PublicFooter, PublicNav } from "@/components/shell/public-nav";
import { VerifySearch } from "@/components/verify/verify-search";
import { Kick } from "@/components/ui/primitives";

export const metadata: Metadata = {
  alternates: { canonical: "/verify" },
  title: "Verify a certificate",
  description: "Check a Plansphere certificate against the issuing college’s record. No account needed.",
};

/** 3d — the entry point for anyone holding a certificate number but no QR. */
export default function VerifyIndexPage() {
  return (
    <div className="flex min-h-dvh flex-col">
      <PublicNav active="verify" />
      <main id="main" className="mx-auto w-full max-w-[720px] flex-1 px-[18px] pb-16 pt-8 sm:px-6 sm:pt-14">
        <Kick className="mb-2">Public verification · no account needed</Kick>
        <h1 className="mb-2.5 text-[32px] font-medium leading-[1.05] tracking-[-0.03em] sm:text-[40px]">Verify a certificate</h1>
        <p className="mb-7 max-w-[52ch] text-[15px] text-neutral-300">
          Every Plansphere certificate carries a number and a QR code. Scan the code, or type the number below, to see the record it was issued from.
        </p>
        <VerifySearch />
        <div className="mt-10 max-w-[52ch] text-[12.5px] leading-relaxed text-neutral-500">
          Certificates are generated server-side once attendance is confirmed at the gate and the event’s results are published. A participant cannot issue
          their own, and a revoked certificate stays visible here — marked as revoked — rather than disappearing.
        </div>
      </main>
      <PublicFooter />
    </div>
  );
}
