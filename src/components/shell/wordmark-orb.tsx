/** The small CSS orb+wordmark, used instead of the raster logo wherever the
 *  surrounding background can be dark: `logo.png`'s own colors aren't known
 *  to be safe against a dark fill, so this mark is used instead wherever the
 *  background is dark or changes — the footer (always dark) and the
 *  homepage's scroll-aware nav (transparent → dark) — since it recolors
 *  correctly via explicit classes instead of baked-in pixels.
 *
 *  No "use client" here on purpose: it's static markup with no state, and
 *  both a server component (PublicFooter) and a client component
 *  (TransparentNav) import it — keeping it in a plain module means the
 *  server-rendered callers don't pull in any client-boundary overhead for
 *  what is, for them, just a `<span>`. */
export const WordmarkOrb = ({ inverted }: { inverted: boolean }) => (
  <span
    className={`grid h-7 w-7 flex-none -rotate-[15deg] place-items-center rounded-full ${inverted ? "bg-accent-fill text-text" : "bg-text text-bg"}`}
  >
    <span className="rotate-[15deg] font-display text-[13px] font-medium">P</span>
  </span>
);
