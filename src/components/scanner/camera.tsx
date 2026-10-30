"use client";

import * as React from "react";
import type { Html5Qrcode } from "html5-qrcode";

/**
 * The camera viewport. Wraps html5-qrcode, loaded lazily because it touches
 * `window` at import. Decodes continuously while `active`; the parent pauses
 * it after a hit and resumes on "Scan next", so one ticket held in front of
 * the lens does not fire twenty times.
 */
export interface CameraProps {
  active: boolean;
  onDecode: (text: string) => void;
  onError?: (message: string) => void;
  className?: string;
}

export interface CameraHandle {
  toggleTorch: () => Promise<boolean>;
  torchSupported: boolean;
}

export const Camera = React.forwardRef<CameraHandle, CameraProps>(({ active, onDecode, onError, className }, ref) => {
  const id = React.useId().replace(/:/g, "");
  const scanner = React.useRef<Html5Qrcode | null>(null);
  const running = React.useRef(false);
  const lastText = React.useRef<{ text: string; at: number } | null>(null);
  const [torchSupported, setTorchSupported] = React.useState(false);
  const torchOn = React.useRef(false);
  const onDecodeRef = React.useRef(onDecode);
  onDecodeRef.current = onDecode;

  React.useImperativeHandle(ref, () => ({
    torchSupported,
    toggleTorch: async () => {
      const s = scanner.current;
      if (!s) return false;
      try {
        torchOn.current = !torchOn.current;
        await s.applyVideoConstraints({ advanced: [{ torch: torchOn.current } as MediaTrackConstraintSet] });
        return torchOn.current;
      } catch {
        torchOn.current = false;
        return false;
      }
    },
  }));

  React.useEffect(() => {
    let cancelled = false;

    const start = async () => {
      const { Html5Qrcode } = await import("html5-qrcode");
      if (cancelled) return;
      const s = new Html5Qrcode(`qr-${id}`, { verbose: false });
      scanner.current = s;
      try {
        await s.start(
          { facingMode: "environment" },
          { fps: 12, qrbox: (w, h) => ({ width: Math.min(w, h) * 0.72, height: Math.min(w, h) * 0.72 }), aspectRatio: 1 },
          (text) => {
            // The same code within 2.5s is the same ticket still in frame.
            const now = Date.now();
            if (lastText.current && lastText.current.text === text && now - lastText.current.at < 2500) return;
            lastText.current = { text, at: now };
            onDecodeRef.current(text);
          },
          () => undefined,
        );
        running.current = true;
        try {
          const caps = s.getRunningTrackCapabilities() as MediaTrackCapabilities & { torch?: boolean };
          setTorchSupported(Boolean(caps?.torch));
        } catch {
          setTorchSupported(false);
        }
      } catch (error) {
        // Browser errors are DOMExceptions with internal names; translate the
        // ones that mean something to a volunteer and hide the rest.
        const name = error instanceof Error ? error.name : "";
        onError?.(
          name === "NotAllowedError" || name === "PermissionDeniedError"
            ? "Camera permission was refused. Allow the camera in your browser settings, or enter the code manually."
            : name === "NotFoundError" || name === "OverconstrainedError"
              ? "No usable camera was found on this device. Enter the code manually."
              : name === "NotReadableError"
                ? "The camera is in use by another app. Close it and try again, or enter the code manually."
                : "Camera unavailable. Check permissions, or enter the code manually.",
        );
      }
    };

    void start();

    return () => {
      cancelled = true;
      const s = scanner.current;
      scanner.current = null;
      if (s && running.current) {
        running.current = false;
        s.stop().catch(() => undefined).finally(() => s.clear());
      }
    };
  }, [id, onError]);

  // Pause/resume without tearing the camera down.
  React.useEffect(() => {
    const s = scanner.current;
    if (!s || !running.current) return;
    try {
      if (active) s.resume();
      else s.pause(true);
    } catch {
      /* state race during teardown */
    }
  }, [active]);

  return <div id={`qr-${id}`} className={className} />;
});
Camera.displayName = "Camera";
