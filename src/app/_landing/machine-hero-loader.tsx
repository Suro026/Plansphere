"use client";

import * as React from "react";
import dynamic from "next/dynamic";

/*
 * Mounts the 3D event machine behind the hero — only when it is worth it.
 * The three.js chunk is fetched after the page is idle, never on the critical
 * path, and the static orbit artwork stays as the fallback until the first
 * real frame is drawn (and for good if anything goes wrong). It is skipped
 * entirely for visitors who ask for reduced motion or reduced data, on
 * low-memory devices, and where WebGL isn't available.
 */

const PlansphereMachine3D = dynamic(() => import("@/components/ui/plansphere-machine-3d"), { ssr: false });

class MachineBoundary extends React.Component<{ children: React.ReactNode; onFail: () => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error("Hero machine failed; keeping the static artwork.", error);
    this.props.onFail();
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

const webglAvailable = () => {
  try {
    const canvas = document.createElement("canvas");
    return Boolean(canvas.getContext("webgl2") || canvas.getContext("webgl"));
  } catch {
    return false;
  }
};

export function MachineHeroLoader() {
  const [mounted, setMounted] = React.useState(false);
  const [ready, setReady] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const layer = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    const device = navigator as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean } };
    const skip =
      window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
      window.matchMedia("(prefers-reduced-data: reduce)").matches ||
      device.connection?.saveData === true ||
      (device.deviceMemory !== undefined && device.deviceMemory <= 2) ||
      !webglAvailable();
    if (skip) return;

    const start = () => setMounted(true);
    // Safari has no requestIdleCallback, hence the optional-typed view of `window`.
    const idle = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    if (idle.requestIdleCallback) {
      const id = idle.requestIdleCallback(start, { timeout: 2500 });
      return () => idle.cancelIdleCallback?.(id);
    }
    const id = window.setTimeout(start, 900);
    return () => window.clearTimeout(id);
  }, []);

  // Once the first frame is drawn, fade the static orbit art out from the hero.
  React.useEffect(() => {
    const hero = layer.current?.closest(".minimal-hero");
    if (!hero) return;
    hero.classList.toggle("has-machine", ready && !failed);
    return () => hero.classList.remove("has-machine");
  }, [ready, failed]);

  if (!mounted || failed) return null;

  return (
    <div ref={layer} className={`machine-layer ${ready ? "machine-ready" : ""}`}>
      <MachineBoundary onFail={() => setFailed(true)}>
        <PlansphereMachine3D onReady={() => setReady(true)} onError={() => setFailed(true)} />
      </MachineBoundary>
    </div>
  );
}
