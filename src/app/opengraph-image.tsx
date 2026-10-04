import { ImageResponse } from "next/og";
import { SITE } from "@/lib/site";
import { OG_ICON_MARK_BASE64 } from "@/lib/og-icon-mark";

export const alt = `${SITE.name} — ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const iconMark = OG_ICON_MARK_BASE64;

/** The default social card: ink ground, mint accent, the tagline — the Editorial system's dark chapter. */
export default function OpenGraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: 72,
          background: "#101010",
          color: "#f3f1ea",
          fontFamily: "'DM Sans', system-ui, sans-serif",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
          <img src={`data:image/png;base64,${iconMark}`} width={56} height={56} alt="" />
          <div style={{ fontSize: 30, fontWeight: 600, letterSpacing: -0.5 }}>{SITE.name}</div>
          <div style={{ marginLeft: "auto", fontSize: 22, color: "#9a9992" }}>plansphere.in</div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
          <div style={{ display: "flex", flexDirection: "column", fontSize: 108, fontWeight: 600, lineHeight: 0.96, letterSpacing: -5 }}>
            <span>Every fest.</span>
            <span>One pass.</span>
          </div>
          <div style={{ fontSize: 30, color: "#d8d6d0", maxWidth: 900, lineHeight: 1.35 }}>
            Register with your team in one go. Show a QR at the gate. Certificates anyone can verify.
          </div>
        </div>
        <div style={{ display: "flex", gap: 14 }}>
          {["QR passes that work offline", "Team registration", "Verified certificates"].map((t) => (
            <div key={t} style={{ border: "2px solid #cbf6df", color: "#cbf6df", borderRadius: 999, padding: "10px 22px", fontSize: 22 }}>
              {t}
            </div>
          ))}
        </div>
      </div>
    ),
    size,
  );
}
