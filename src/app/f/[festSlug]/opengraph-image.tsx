import { ImageResponse } from "next/og";
import { repositories } from "@/data/repositories";
import { OG_ICON_MARK_BASE64 } from "@/lib/og-icon-mark";
import { formatDateRange } from "@/lib/utils";

export const alt = "Fest on Plansphere";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

const iconMark = OG_ICON_MARK_BASE64;

/** A fest's social card: name, college, dates, live counts. */
export default async function FestOpenGraphImage({ params }: { params: Promise<{ festSlug: string }> }) {
  const { festSlug } = await params;
  const fest = await repositories()
    .fests.getBySlug(festSlug)
    .catch(() => null);
  const name = fest?.name ?? "Plansphere";
  const sub = fest ? `${fest.organizationName} · ${fest.city} · ${formatDateRange(fest.startDate, fest.endDate)}` : "Every fest. One pass.";
  const stats = fest ? [`${fest.stats.events} events`, `${fest.stats.registrations.toLocaleString("en-IN")} registered`] : [];

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
        <div style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 24, color: "#9a9992" }}>
          <img src={`data:image/png;base64,${iconMark}`} width={40} height={40} alt="" />
          Plansphere · plansphere.in
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
          <div style={{ fontSize: name.length > 18 ? 76 : 100, fontWeight: 600, lineHeight: 1, letterSpacing: -3 }}>{name}</div>
          <div style={{ fontSize: 30, color: "#d8d6d0" }}>{sub}</div>
        </div>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          {stats.map((t) => (
            <div key={t} style={{ border: "2px solid #cbf6df", color: "#cbf6df", borderRadius: 999, padding: "10px 22px", fontSize: 24 }}>
              {t}
            </div>
          ))}
          <div style={{ marginLeft: "auto", fontSize: 24, color: "#9a9992" }}>Register with one pass →</div>
        </div>
      </div>
    ),
    size,
  );
}
