"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

/**
 * Plansphere — the event machine.
 *
 * One machine you can spin: a fest's whole journey across five stations on a
 * metal plate — Register (the sign-up kiosk), QR Pass (the pass printer),
 * Gate (the scanner), Live (the scoreboard) and Certify (the seal press and
 * certificate printer) — with a conveyor carrying a single entry through all
 * of them. Procedural three.js: no models,
 * no images, nothing fetched.
 *
 * Adapted from the supplied "Agentic Factory" 3D component (same geometry,
 * camera, conveyor and motion), re-skinned for Plansphere: ink, sage and mint
 * instead of steel and amber, the station screens repainted with Plansphere's
 * own flow, and the demo chrome (title bar, mode bar, credit link, debug
 * globals) removed. It is always the clean "hero" variant: the machine sits in
 * the right 58 % of a wide frame, the wheel and touch scroll the page, and a
 * click on a station only reports it.
 *
 * Fills its box: give it a size. Dependency: three.
 */

export type MachineStationId = "engine" | "admin" | "storefront" | "cabinet" | "cashdesk";

export type PlansphereMachineProps = {
  className?: string;
  /** The first real frame is drawn. */
  onReady?: () => void;
  /** WebGL or the scene failed to start; the host should keep its static artwork. */
  onError?: () => void;
  /** A station was clicked. */
  onStation?: (id: MachineStationId) => void;
};

export default function PlansphereMachine3D({ className, onReady, onError, onStation }: PlansphereMachineProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const handlers = useRef({ onReady, onError, onStation });
  useEffect(() => {
    handlers.current = { onReady, onError, onStation };
  }, [onReady, onError, onStation]);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    let dispose: (() => void) | undefined;
    let cancelled = false;
    // The in-scene screens are painted on canvases: wait for fonts first.
    document.fonts.ready.then(() => {
      if (cancelled) return;
      dispose = initMachineScene(root, getComputedStyle(root).fontFamily, {
        onStation: (id) => handlers.current.onStation?.(id),
        onReady: () => handlers.current.onReady?.(),
        onError: () => handlers.current.onError?.(),
      });
    });
    return () => {
      cancelled = true;
      dispose?.();
    };
  }, []);

  return (
    <div ref={rootRef} className={["plansphere-machine", className].filter(Boolean).join(" ")}>
      <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      <div
        id="scene"
        role="img"
        aria-label="Interactive 3D machine showing a fest's journey in five stations: Register, QR Pass, Gate, Live and Certify. Drag to rotate. Hover a station to read what it does."
      />
      {/* The controls below are hidden in this variant; the scene code still drives them. */}
      <div className="debug-ui">
        <div className="status" id="status">
          <span id="status-text" />
        </div>
        <div id="journey">
          <strong id="journey-title" />
          <small id="journey-detail" />
          <i id="journey-progress" />
        </div>
        <nav aria-label="Machine mode">
          <button data-mode="assembled" aria-pressed="true" tabIndex={-1} />
          <button data-mode="cutaway" aria-pressed="false" tabIndex={-1} />
          <button data-mode="stations" aria-pressed="false" tabIndex={-1} />
          <button data-mode="order" aria-pressed="false" tabIndex={-1} />
        </nav>
        <nav aria-label="Camera">
          <button data-camera="overview" aria-pressed="true" tabIndex={-1} />
          <button data-camera="side" aria-pressed="false" tabIndex={-1} />
          <button data-camera="top" aria-pressed="false" tabIndex={-1} />
          <button data-camera="station" aria-pressed="false" tabIndex={-1} />
          <button data-camera="flight" aria-pressed="false" tabIndex={-1} />
          <button id="play" aria-pressed="false" tabIndex={-1} />
        </nav>
      </div>
      <div id="labels" />
      <div id="tooltip" role="tooltip">
        <strong />
        <p />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The scene.
// ---------------------------------------------------------------------------

type MachineMode = "assembled" | "cutaway" | "stations" | "order";
type MachineCamera = "overview" | "side" | "top" | "station" | "flight";

type MachineSceneOptions = {
  onStation?: (id: MachineStationId) => void;
  onReady?: () => void;
  onError?: () => void;
};

/** Narrower than this the machine is centred in a short box under the headline. */
const MOBILE_WIDTH = 720;

function initMachineScene(root: HTMLElement, fontFamily: string, options: MachineSceneOptions): () => void {
  const cleanups: Array<() => void> = [];
  const frameWidth = () => root.clientWidth;
  const frameHeight = () => root.clientHeight;
  // Every listener goes through here, so dispose() can take it off again.
  const listen = (target: EventTarget, type: string, handler: (event: never) => void) => {
    const fn = handler as unknown as EventListener;
    target.addEventListener(type, fn);
    cleanups.push(() => target.removeEventListener(type, fn));
  };
  function $<T extends HTMLElement = HTMLElement>(id: string): T {
    const el = root.querySelector<T>(`#${id}`);
    if (!el) throw new Error(`Scene markup is missing #${id}`);
    return el;
  }
  const dispose = () => {
    for (const fn of cleanups.reverse()) fn();
    cleanups.length = 0;
  };
  try {
    const TAU = Math.PI * 2;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const MINT = "#7fd1a8";
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(33, frameWidth() / frameHeight(), 0.1, 150);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(Math.min(devicePixelRatio, frameWidth() < 900 ? 1.5 : 1.75));
    renderer.setSize(frameWidth(), frameHeight());
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.12;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.localClippingEnabled = true;
    $("scene").appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.065;
    controls.enablePan = false;
    controls.minDistance = 7;
    controls.maxDistance = 55;
    controls.minPolarAngle = 0.09;
    controls.maxPolarAngle = Math.PI * 0.475;
    controls.rotateSpeed = 0.48;
    controls.zoomSpeed = 0.7;
    // Inside a landing page the wheel and the finger scroll the page, not the scene.
    controls.enableZoom = false;
    const coarse = matchMedia("(pointer:coarse)").matches;
    if (coarse) controls.enableRotate = false;
    // OrbitControls locks touch scrolling; give vertical panning back to the page.
    renderer.domElement.style.touchAction = "pan-y";
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const env = pmrem.fromScene(room, 0.04);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.62;
    room.dispose();
    pmrem.dispose();
    scene.add(new THREE.HemisphereLight(0xdbe5f4, 0x29211a, 2));
    const key = new THREE.DirectionalLight(0xfff1d8, 4.2);
    key.position.set(-4, 12, 7);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    Object.assign(key.shadow.camera, { left: -10, right: 10, top: 9, bottom: -9, near: 0.5, far: 35 });
    key.shadow.normalBias = 0.035;
    key.shadow.bias = -0.0002;
    key.shadow.radius = 4;
    scene.add(key);
    const rim = new THREE.DirectionalLight(0xc4d4ed, 3.1);
    rim.position.set(3, 7, -8);
    scene.add(rim);
    const warm = new THREE.PointLight(0xcbf6df, 24, 20, 2);
    warm.position.set(-4, 5, 3);
    scene.add(warm);
    const front = new THREE.DirectionalLight(0xffffff, 1);
    front.position.set(5, 3, 10);
    scene.add(front);

    const mat = (color: number, metalness = 0.1, roughness = 0.4, extra: THREE.MeshStandardMaterialParameters = {}) =>
      new THREE.MeshStandardMaterial({ color, metalness, roughness, ...extra });
    const M = {
      body: mat(0x30363f, 0.75, 0.29),
      base: mat(0x292f37, 0.85, 0.32),
      edge: mat(0x707986, 0.85, 0.24),
      chrome: mat(0xc3cad0, 0.92, 0.18),
      dark: mat(0x12171d, 0.45, 0.38),
      rubber: mat(0x0b1015, 0.1, 0.6),
      accent: mat(0x8fb8a2, 0.5, 0.3),
      ivory: mat(0xe0ded4, 0.48, 0.26),
      sage: mat(0x7b9a8a, 0.8, 0.3),
      light: mat(0xcbf6df, 0.2, 0.25, { emissive: 0x7fd1a8, emissiveIntensity: 1.5 }),
    };
    type Vec3 = [number, number, number];
    type Material = THREE.Material;
    const geometries = new Map<string, THREE.BufferGeometry>();
    function boxGeo(w: number, h: number, d: number, r = 0.04) {
      const k = `b${w},${h},${d},${r}`;
      if (!geometries.has(k))
        geometries.set(k, r ? new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 3, h / 3, d / 3)) : new THREE.BoxGeometry(w, h, d));
      return geometries.get(k)!;
    }
    function box(parent: THREE.Object3D, w: number, h: number, d: number, x: number, y: number, z: number, m: Material = M.body, r = 0.04) {
      const o = new THREE.Mesh(boxGeo(w, h, d, r), m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    }
    function cyl(parent: THREE.Object3D, r: number, h: number, x: number, y: number, z: number, m: Material = M.chrome, r2: number = r, segments = 24) {
      const k = `c${r},${r2},${h},${segments}`;
      if (!geometries.has(k)) geometries.set(k, new THREE.CylinderGeometry(r, r2, h, segments));
      const o = new THREE.Mesh(geometries.get(k)!, m);
      o.position.set(x, y, z);
      o.castShadow = true;
      o.receiveShadow = true;
      parent.add(o);
      return o;
    }
    function ball(parent: THREE.Object3D, r: number, x: number, y: number, z: number, m: Material = M.chrome) {
      const k = `s${r}`;
      if (!geometries.has(k)) geometries.set(k, new THREE.SphereGeometry(r, 12, 8));
      const o = new THREE.Mesh(geometries.get(k)!, m);
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    }
    function tube(parent: THREE.Object3D, pts: Vec3[], r: number, m: Material = M.chrome) {
      const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(...p)));
      const o = new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(12, pts.length * 7), r, 8, false), m);
      o.castShadow = true;
      parent.add(o);
      return o;
    }
    function screw(parent: THREE.Object3D, x: number, y: number, z: number) {
      cyl(parent, 0.055, 0.026, x, y, z, M.chrome, undefined, 12);
      box(parent, 0.068, 0.005, 0.009, x, y + 0.014, z, M.dark, 0);
    }
    type Draw = (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
    function canvasTexture(w: number, h: number, draw: Draw) {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      draw(ctx, w, h);
      const t = new THREE.CanvasTexture(c);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = Math.min(4, renderer.capabilities.getMaxAnisotropy());
      return { texture: t, canvas: c, ctx };
    }
    function print(ctx: CanvasRenderingContext2D, txt: string, x: number, y: number, size = 20, color = "#f4f1ea", weight = 500) {
      ctx.fillStyle = color;
      ctx.font = `${weight} ${size}px ${fontFamily}`;
      ctx.fillText(txt, x, y);
    }
    function screenMaterial(texture: THREE.Texture) {
      return new THREE.MeshBasicMaterial({ map: texture, toneMapped: false });
    }
    type Painted = THREE.Texture | { texture: THREE.Texture };
    function screen(parent: THREE.Object3D, w: number, h: number, x: number, y: number, z: number, tex: Painted) {
      const map = "texture" in tex ? tex.texture : tex;
      const o = new THREE.Mesh(new THREE.PlaneGeometry(w, h), screenMaterial(map));
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    }
    const machine = new THREE.Group();
    scene.add(machine);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(70, 70), new THREE.ShadowMaterial({ opacity: 0.2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.43;
    floor.receiveShadow = true;
    scene.add(floor);
    const shadow = canvasTexture(128, 128, (c, w, h) => {
      const g = c.createRadialGradient(64, 64, 12, 64, 64, 64);
      g.addColorStop(0, "rgba(0,0,0,.7)");
      g.addColorStop(0.55, "rgba(0,0,0,.4)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      c.fillStyle = g;
      c.fillRect(0, 0, w, h);
    });
    const contact = new THREE.Mesh(
      new THREE.PlaneGeometry(18, 13),
      new THREE.MeshBasicMaterial({ map: shadow.texture, transparent: true, depthWrite: false, opacity: 0.55 }),
    );
    contact.rotation.x = -Math.PI / 2;
    contact.position.y = -0.415;
    scene.add(contact);
    // A chamfered, layered platform with engraved nomenclature and captive screws.
    box(machine, 12.8, 0.38, 8.25, 0, -0.09, 0, M.base, 0.17);
    box(machine, 12.6, 0.055, 8.08, 0, 0.13, 0, M.edge, 0.11);
    box(machine, 12.49, 0.09, 7.96, 0, 0.19, 0, M.body, 0.1);
    box(machine, 12.55, 0.027, 8.02, 0, -0.19, 0, M.dark, 0.06);
    box(machine, 11.9, 0.026, 0.032, 0, -0.17, 4.115, M.light, 0.01);
    for (const x of [-5.6, 5.6])
      for (const z of [-3.35, 3.35]) {
        cyl(machine, 0.39, 0.25, x, -0.31, z, M.rubber);
        cyl(machine, 0.29, 0.09, x, -0.4, z, M.dark);
        screw(machine, x, 0.253, z);
      }
    for (const x of [-6.02, 6.02]) for (const z of [-3.73, 3.73]) screw(machine, x, 0.255, z);
    const engraving = canvasTexture(1536, 176, (c, w, h) => {
      c.fillStyle = "#252b32";
      c.fillRect(0, 0, w, h);
      c.strokeStyle = "#4d545c";
      c.lineWidth = 2;
      c.strokeRect(2, 2, w - 4, h - 4);
      print(c, "PLANSPHERE", 45, 79, 40, "#d9d8cd", 650);
      print(c, "·  register  ·  scan  ·  score  ·  certify", 345, 79, 34, "#b8bdc1", 450);
      print(c, "COLLEGE FESTS    /    END TO END", 47, 133, 19, "#737e88", 500);
      print(c, "No. 001", 1360, 130, 23, "#9fc9b3");
    });
    const plate = screen(machine, 7.35, 0.84, -0.4, 0.25, 3.51, engraving);
    plate.rotation.x = -Math.PI / 2;
    for (let i = 0; i < 16; i++) box(machine, 0.015, 0.009, 0.11 + (i % 4) * 0.035, -5.6 + i * 0.09, 0.249, 3.5, M.edge, 0);
    // Faint drafting marks stay local to the machine, leaving the headline area empty.
    const drafting = new THREE.Group();
    scene.add(drafting);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x69717a, transparent: true, opacity: 0.12 });
    const draftingPoints: THREE.Vector3[] = [];
    for (const r of [7.5, 8.1])
      for (let i = 0; i < 120; i++)
        for (const j of [i, i + 1]) {
          const a = (j / 120) * TAU;
          draftingPoints.push(new THREE.Vector3(Math.cos(a) * r, -0.4, Math.sin(a) * r * 0.72));
        }
    for (let i = 0; i < 52; i++) {
      const a = (i / 52) * TAU;
      const r = 8.1;
      draftingPoints.push(
        new THREE.Vector3(Math.cos(a) * r, -0.395, Math.sin(a) * r * 0.72),
        new THREE.Vector3(
          Math.cos(a) * (r + (i % 4 === 0 ? 0.16 : 0.07)),
          -0.395,
          Math.sin(a) * (r + (i % 4 === 0 ? 0.16 : 0.07)) * 0.72,
        ),
      );
    }
    drafting.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(draftingPoints), lineMat));

    // The five stations along the belt. `step` is the station's place in a fest's flow.
    type StationDef = { id: MachineStationId; name: string; step: number; output: string; pos: Vec3; desc: string };
    type Station = StationDef & {
      group: THREE.Group;
      base: THREE.Vector3;
      glowMat: THREE.MeshStandardMaterial;
      label: HTMLDivElement;
      index: number;
      anchor: THREE.Vector3;
    };
    const definitions: StationDef[] = [
      { id: "engine", name: "QR Pass", step: 2, output: "pass", pos: [-4.15, 0.29, -0.65], desc: "Every registration gets a QR pass." },
      { id: "admin", name: "Gate", step: 3, output: "check-in", pos: [-1.65, 0.29, -2.03], desc: "Volunteers scan passes at the gate and for meals." },
      { id: "storefront", name: "Live", step: 4, output: "scores", pos: [1.5, 0.29, -2.08], desc: "Live scores and public scoreboards." },
      { id: "cabinet", name: "Register", step: 1, output: "registration", pos: [4.03, 0.29, 0.12], desc: "Students sign up, solo or as a team." },
      { id: "cashdesk", name: "Certify", step: 5, output: "certificate", pos: [0.93, 0.29, 1.85], desc: "Results are published; certificates can be verified by number." },
    ];
    const stations: Station[] = [];
    const cutPlane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 10);
    const shellMaterials: THREE.Material[] = [];
    function shell<T extends THREE.Material>(m: T): T {
      const s = m.clone() as T;
      s.clippingPlanes = [cutPlane];
      s.clipShadows = true;
      s.side = THREE.DoubleSide;
      shellMaterials.push(s);
      return s;
    }
    const S = { body: shell(M.body), ivory: shell(M.ivory), accent: shell(M.accent), edge: shell(M.edge) };
    const gears: Array<{ g: THREE.Group; vertical: boolean }> = [];
    function gear(parent: THREE.Object3D, x: number, y: number, z: number, r = 0.3, vertical = false) {
      const g = new THREE.Group();
      g.position.set(x, y, z);
      if (vertical) g.rotation.x = Math.PI / 2;
      parent.add(g);
      cyl(g, r, 0.09, 0, 0, 0, M.sage);
      cyl(g, r * 0.66, 0.105, 0, 0, 0, M.dark);
      cyl(g, r * 0.22, 0.14, 0, 0, 0, M.chrome);
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * TAU;
        const b = box(g, r * 0.26, 0.085, r * 0.2, Math.cos(a) * r, 0, Math.sin(a) * r, M.sage, 0.008);
        b.rotation.y = -a;
      }
      g.userData.moving = true;
      gears.push({ g, vertical });
      return g;
    }
    definitions.forEach((d, i) => {
      const group = new THREE.Group();
      group.position.fromArray(d.pos);
      machine.add(group);
      const glowMat = M.light.clone();
      glowMat.emissiveIntensity = 0.5;
      box(group, 2.05, 0.12, 1.78, 0, 0.03, 0, M.dark, 0.1);
      box(group, 1.97, 0.03, 1.7, 0, 0.12, 0, glowMat, 0.09);
      box(group, 2.03, 0.17, 1.75, 0, 0.215, 0, M.body, 0.1);
      for (const x of [-0.85, 0.85]) for (const z of [-0.7, 0.7]) screw(group, x, 0.311, z);
      // Internal mechanics become visible when the shell is cut at deck height.
      gear(group, -0.35, 0.45, 0, 0.27);
      gear(group, 0.22, 0.45, 0.12, 0.21);
      box(group, 0.6, 0.15, 0.36, 0.52, 0.47, -0.33, M.dark);
      for (let j = 0; j < 6; j++) box(group, 0.025, 0.16, 0.37, 0.3 + j * 0.08, 0.47, -0.33, M.edge, 0.004);
      tube(
        group,
        [
          [-0.7, 0.4, -0.4],
          [-0.55, 0.48, 0.4],
          [0.35, 0.45, 0.6],
          [0.7, 0.58, 0.23],
        ],
        0.023,
        M.light,
      );
      const plaque = canvasTexture(512, 116, (c, w, h) => {
        c.fillStyle = "#151a20";
        c.fillRect(0, 0, w, h);
        print(c, String(i + 1).padStart(2, "0"), 24, 76, 42, MINT, 550);
        print(c, d.name.toUpperCase(), 111, 73, 35, "#d7d9d7", 550);
      });
      screen(group, 1.54, 0.345, 0, 0.27, 0.891, plaque);
      const label = document.createElement("div");
      label.className = "station-label";
      label.innerHTML = `<div class="stem"></div><div class="label-card"><div class="label-title"><span>${String(i + 1).padStart(2, "0")}</span>${d.name}</div><div class="label-meta">Step ${d.step} · ${d.output}</div></div>`;
      $("labels").appendChild(label);
      cleanups.push(() => label.remove());

      stations.push({ ...d, group, base: new THREE.Vector3(...d.pos), glowMat, label, index: i, anchor: new THREE.Vector3(0, 2.5, 0) });
    });
    const engine = stations[0]!.group;
    box(engine, 1.74, 0.62, 1.33, 0, 0.65, -0.05, S.ivory, 0.13);
    box(engine, 1.5, 0.1, 1.16, 0, 0.99, -0.04, S.body, 0.025);
    for (const x of [-0.68, 0.68]) {
      cyl(engine, 0.065, 1.73, x, 1.35, -0.18, M.chrome);
      box(engine, 0.22, 1.8, 0.22, x, 1.37, -0.44, S.ivory, 0.035);
    }
    box(engine, 1.82, 0.27, 0.4, 0, 2.28, -0.35, S.accent, 0.045);
    box(engine, 1.55, 0.06, 0.06, 0, 2.13, -0.115, M.chrome, 0.01);
    const printhead = new THREE.Group();
    engine.add(printhead);
    printhead.position.set(0, 1.9, -0.08);
    printhead.userData.moving = true;
    box(printhead, 0.45, 0.36, 0.44, 0, 0, 0, M.body, 0.05);
    cyl(printhead, 0.11, 0.13, 0, -0.24, 0.03, M.chrome, 0.04);
    box(printhead, 0.24, 0.045, 0.022, 0, 0.09, 0.23, M.light, 0.01);
    tube(
      engine,
      [
        [-0.68, 2.1, -0.35],
        [-0.42, 2.52, -0.4],
        [0.25, 2.5, -0.4],
        [0.35, 2.01, -0.12],
      ],
      0.032,
      M.dark,
    );
    const reels: THREE.Group[] = [];
    for (const [x, y] of [
      [-1.03, 1.82],
      [-0.94, 2.78],
    ] as const) {
      const reel = new THREE.Group();
      reel.position.set(x, y, -0.48);
      engine.add(reel);
      reel.userData.moving = true;
      // A roll of pass stock: ivory paper on a dark core, with a mint stripe so the turn is visible.
      const paper = cyl(reel, 0.4, 0.46, 0, 0, 0, M.ivory);
      paper.rotation.x = Math.PI / 2;
      const core = cyl(reel, 0.12, 0.54, 0, 0, 0, M.dark);
      core.rotation.x = Math.PI / 2;
      for (const z of [-0.245, 0.245]) {
        const flange = cyl(reel, 0.43, 0.03, 0, 0, z, M.chrome);
        flange.rotation.x = Math.PI / 2;
      }
      box(reel, 0.1, 0.045, 0.47, 0.4, 0, 0, M.light, 0.01);
      reels.push(reel);
    }
    // The strip of pass stock feeding down into the printer.
    tube(
      engine,
      [
        [-1.34, 2.42, -0.48],
        [-1.2, 2.2, -0.4],
        [-0.9, 1.96, -0.2],
        [-0.6, 1.86, -0.1],
      ],
      0.04,
      M.ivory,
    );
    // The QR pass the engine prints. Procedural, deliberately not a scannable code.
    const passCells: boolean[][] = Array.from({ length: 21 }, (_, y) =>
      Array.from({ length: 21 }, (_, x) => {
        const finder = (x < 7 && y < 7) || (x > 13 && y < 7) || (x < 7 && y > 13);
        if (finder) return false;
        return ((x * 7 + y * 13 + x * y * 3) % 5 < 2) !== ((x + y) % 7 === 0);
      }),
    );
    const videoTexture = canvasTexture(384, 640, () => {});
    function drawVideo(t: number) {
      const c = videoTexture.ctx;
      const w = 384;
      const h = 640;
      c.fillStyle = "#cbf6df";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#a7ccb8";
      c.beginPath();
      c.arc(330, 205, 210, 0, TAU);
      c.fill();
      print(c, "ENTRY", 28, 57, 24, "#242320", 650);
      print(c, "PASS.", 24, 103, 42, "#242320", 700);
      c.fillStyle = "#f4f1ea";
      c.beginPath();
      c.roundRect(52, 140, 280, 280, 14);
      c.fill();
      const cell = 11;
      const ox = 192 - (21 * cell) / 2;
      const oy = 280 - (21 * cell) / 2;
      c.fillStyle = "#171b20";
      for (let y = 0; y < 21; y++) for (let x = 0; x < 21; x++) if (passCells[y]![x]) c.fillRect(ox + x * cell, oy + y * cell, cell - 1, cell - 1);
      for (const [fx, fy] of [
        [0, 0],
        [14, 0],
        [0, 14],
      ] as const) {
        c.fillRect(ox + fx * cell, oy + fy * cell, 7 * cell - 1, 7 * cell - 1);
        c.fillStyle = "#f4f1ea";
        c.fillRect(ox + (fx + 1) * cell, oy + (fy + 1) * cell, 5 * cell - 1, 5 * cell - 1);
        c.fillStyle = "#171b20";
        c.fillRect(ox + (fx + 2) * cell, oy + (fy + 2) * cell, 3 * cell - 1, 3 * cell - 1);
      }
      // A scan line sweeps the code.
      const scan = 140 + ((t * 0.5) % 1) * 280;
      c.fillStyle = "rgba(80,103,91,.55)";
      c.fillRect(52, scan, 280, 6);
      c.fillStyle = "#171b20";
      c.beginPath();
      c.roundRect(25, 465, 334, 123, 12);
      c.fill();
      const texts = ["Show it at the gate.", "Scan once, walk in.", "Meals too.", "Works offline."];
      const n = Math.floor(t * 0.7) % 4;
      print(c, texts[n]!, 45, 505, 25, "#f4f1ea", 550);
      print(c, texts[(n + 1) % 4]!, 45, 547, 25, "#f4f1ea", 550);
      c.fillStyle = "#cbf6df";
      c.fillRect(27, 615, Math.max(10, ((t * 0.13) % 1) * 330), 5);
      videoTexture.texture.needsUpdate = true;
    }
    drawVideo(0);
    const outputVideo = new THREE.Group();
    outputVideo.userData.moving = true;
    engine.add(outputVideo);
    box(outputVideo, 0.62, 1.08, 0.055, 0, 1.36, 0.61, M.dark, 0.035);
    screen(outputVideo, 0.56, 0.98, 0, 1.36, 0.641, videoTexture);
    box(engine, 1.14, 0.12, 0.2, 0, 0.83, 0.66, M.dark, 0.025);
    for (const x of [-0.42, 0.42]) {
      const r = cyl(engine, 0.115, 0.18, x, 0.92, 0.6, M.chrome);
      r.rotation.z = Math.PI / 2;
    }
    for (let i = 0; i < 5; i++) box(engine, 0.08, 0.03, 0.22, -0.38 + i * 0.19, 1.011, -0.02, M.edge, 0.005);

    const admin = stations[1]!.group;
    box(admin, 1.9, 0.66, 1.36, 0, 0.67, -0.04, S.body, 0.11);
    const consoleTop = new THREE.Group();
    consoleTop.position.set(0, 1.01, -0.08);
    consoleTop.rotation.x = -0.32;
    admin.add(consoleTop);
    box(consoleTop, 1.76, 0.12, 1.27, 0, 0, 0, S.ivory, 0.04);
    const queue = canvasTexture(640, 340, () => {});
    function drawQueue(t: number) {
      const c = queue.ctx;
      c.fillStyle = "#111b20";
      c.fillRect(0, 0, 640, 340);
      print(c, "GATE CHECK-IN", 25, 45, 21, "#acb9b8", 550);
      print(c, "LIVE", 540, 45, 20, MINT, 600);
      for (let i = 0; i < 3; i++) {
        const y = 74 + i * 76;
        c.fillStyle = "#202c30";
        c.beginPath();
        c.roundRect(21, y, 598, 61, 6);
        c.fill();
        c.fillStyle = i === 0 ? "#9fc9b3" : "#626f69";
        c.fillRect(34, y + 10, 27, 41);
        print(c, ["Gate scan", "Meal scan", "Team entry"][i]!, 77, y + 29, 19, "#d4d8cc");
        print(c, i === 0 ? "SCANNING" : "READY", 77, y + 49, 11, i === 0 ? MINT : "#81948f");
        c.fillStyle = "#334348";
        c.fillRect(377, y + 26, 214, 7);
        c.fillStyle = i === 0 ? MINT : "#607475";
        c.fillRect(377, y + 26, i === 0 ? ((t * 0.15) % 1) * 214 : 41 + i * 27, 7);
      }
    }
    drawQueue(0);
    const qs = screen(consoleTop, 1.53, 0.79, 0, 0.067, -0.17, queue);
    qs.rotation.x = -Math.PI / 2;
    const toggles: THREE.Mesh[] = [];
    for (let i = 0; i < 4; i++) {
      const x = -0.57 + i * 0.38;
      cyl(consoleTop, 0.074, 0.035, x, 0.1, 0.45, M.dark);
      const t = cyl(consoleTop, 0.025, 0.15, x, 0.19, 0.45, M.chrome);
      t.rotation.x = -0.4;
      t.userData.moving = true;
      toggles.push(t);
      ball(consoleTop, 0.04, x, 0.275, 0.421, M.ivory);
    }
    cyl(admin, 0.075, 0.06, 0.77, 1.05, -0.62, M.light);
    for (let i = 0; i < 7; i++) box(admin, 0.55, 0.027, 0.02, 0, 0.46 + i * 0.05, 0.655, M.dark, 0.003);
    // The gate scanner: a post with a reader head and a mint beam sweeping the pass.
    cyl(admin, 0.045, 0.62, 0.74, 1.31, 0.52, M.chrome);
    box(admin, 0.4, 0.17, 0.26, 0.74, 1.66, 0.52, M.dark, 0.05);
    box(admin, 0.3, 0.03, 0.18, 0.74, 1.57, 0.52, M.light, 0.01);
    const scanBeam = new THREE.Mesh(
      new THREE.PlaneGeometry(0.34, 0.5),
      new THREE.MeshBasicMaterial({ color: 0xcbf6df, transparent: true, opacity: 0.32, side: THREE.DoubleSide, depthWrite: false }),
    );
    scanBeam.position.set(0.74, 1.3, 0.52);
    scanBeam.userData.moving = true;
    admin.add(scanBeam);

    const storefront = stations[2]!.group;
    box(storefront, 1.35, 0.18, 0.88, 0, 0.44, 0, S.ivory, 0.045);
    cyl(storefront, 0.095, 1.04, 0, 0.93, -0.31, M.chrome);
    box(storefront, 0.56, 0.91, 0.14, 0, 0.99, -0.34, S.body, 0.04);
    box(storefront, 2.42, 1.72, 0.2, 0, 1.94, -0.17, S.ivory, 0.08);
    box(storefront, 2.28, 1.59, 0.1, 0, 1.94, -0.044, M.dark, 0.045);
    const webTexture = canvasTexture(896, 592, (c, w, h) => {
      c.fillStyle = "#edece3";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#dedfd7";
      c.fillRect(0, 0, w, 56);
      c.fillStyle = "#adaeaa";
      for (let i = 0; i < 3; i++) {
        c.beginPath();
        c.arc(26 + i * 19, 27, 4, 0, TAU);
        c.fill();
      }
      print(c, "PLANSPHERE LIVE", 33, 100, 22, "#22282b", 650);
      print(c, "Events    Scores    Results", 535, 98, 14, "#6a7271");
      c.fillStyle = "#cbf6df";
      c.beginPath();
      c.roundRect(32, 131, 287, 401, 10);
      c.fill();
      // A knockout bracket: four matches, two semi-finals, a final.
      c.strokeStyle = "#242827";
      c.lineWidth = 3;
      c.fillStyle = "#242827";
      for (let i = 0; i < 4; i++) {
        const y = 270 + i * 54;
        c.fillRect(52, y, 62, 22);
        c.fillRect(52, y + 28, 62, 22 - 6);
      }
      for (let i = 0; i < 2; i++) {
        const y = 285 + i * 108;
        c.beginPath();
        c.moveTo(114, y + 11);
        c.lineTo(150, y + 11);
        c.lineTo(150, y + 65);
        c.lineTo(114, y + 65);
        c.moveTo(150, y + 38);
        c.lineTo(184, y + 38);
        c.stroke();
        c.fillRect(184, y + 26, 58, 22);
      }
      c.beginPath();
      c.moveTo(242, 337);
      c.lineTo(262, 337);
      c.lineTo(262, 445);
      c.lineTo(242, 445);
      c.moveTo(262, 391);
      c.lineTo(285, 391);
      c.stroke();
      print(c, "LIVE NOW", 52, 181, 29, "#242827", 700);
      print(c, "SCOREBOARD.", 52, 220, 29, "#242827", 700);
      print(c, "Scores,", 359, 197, 41, "#22282b", 600);
      print(c, "as they happen.", 359, 252, 41, "#22282b", 600);
      print(c, "A public scoreboard for", 362, 300, 19, "#77807b");
      print(c, "every tournament.", 362, 329, 19, "#77807b");
      for (let i = 0; i < 3; i++) {
        c.fillStyle = "#d1d5cd";
        c.fillRect(362, 363 + i * 16, 400 - i * 43, 5);
      }
      c.fillStyle = "#232a2b";
      c.beginPath();
      c.roundRect(359, 447, 279, 62, 7);
      c.fill();
      print(c, "Open scoreboard  ↗", 390, 486, 22, "#f4f1ea", 500);
      print(c, "OPEN TO EVERYONE", 33, 571, 12, "#879088");
    });
    screen(storefront, 2.16, 1.43, 0, 1.95, 0.011, webTexture);
    ball(storefront, 0.024, 0, 2.747, -0.05, M.dark);
    box(storefront, 0.21, 0.019, 0.008, 0, 1.149, 0.013, M.light, 0.003);
    const flyPost = new THREE.Group();
    flyPost.userData.moving = true;
    storefront.add(flyPost);
    box(flyPost, 0.59, 0.77, 0.045, 0.94, 0.81, 0.55, M.ivory, 0.025);
    const postTex = canvasTexture(220, 290, (c, w, h) => {
      c.fillStyle = "#f4f1ea";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#cbf6df";
      c.fillRect(15, 16, 190, 168);
      print(c, "3 – 2", 36, 124, 66, "#272e30", 700);
      print(c, "FINAL · LIVE", 40, 162, 17, "#3f5248", 600);
      print(c, "SCOREBOARD", 17, 225, 23, "#283030", 600);
      c.fillStyle = "#b0b5b0";
      c.fillRect(17, 244, 153, 6);
      c.fillRect(17, 258, 104, 5);
    });
    screen(flyPost, 0.55, 0.72, 0.94, 0.81, 0.575, postTex);

    const cabinet = stations[3]!.group;
    box(cabinet, 1.75, 1.77, 1.02, 0, 1.24, -0.13, S.body, 0.12);
    box(cabinet, 1.58, 0.13, 1.09, 0, 2.16, -0.13, S.accent, 0.04);
    box(cabinet, 1.47, 1.38, 0.055, 0, 1.31, 0.405, M.dark, 0.025);
    const orderTex = canvasTexture(480, 460, (c, w, h) => {
      c.fillStyle = "#172224";
      c.fillRect(0, 0, w, h);
      print(c, "REGISTRATIONS", 30, 51, 27, "#e8e8d8", 550);
      print(c, "Solo and team entries", 30, 81, 16, "#869991");
      ["Solo entry", "Team entry", "Team entry"].forEach((n, i) => {
        const y = 110 + i * 100;
        c.fillStyle = "#283839";
        c.beginPath();
        c.roundRect(22, y, 436, 83, 8);
        c.fill();
        c.fillStyle = ["#7fd1a8", "#bdbf9c", "#7d938e"][i]!;
        c.beginPath();
        c.arc(58, y + 40, 19, 0, TAU);
        c.fill();
        print(c, n[0]!, 49, y + 47, 20, "#1b2828", 600);
        print(c, n, 93, y + 33, 23, "#e6e8dc", 550);
        print(c, "Registered", 93, y + 58, 15, "#94a59b");
        print(c, "✓", 410, y + 49, 25, "#9fc9b3");
      });
    });
    screen(cabinet, 1.31, 1.255, 0, 1.37, 0.44, orderTex);
    box(cabinet, 1.27, 0.075, 0.29, 0, 0.57, 0.55, M.chrome, 0.02);
    for (let i = 0; i < 3; i++) box(cabinet, 1.15, 0.021, 0.12, 0, 0.58 + i * 0.15, -0.35, M.sage, 0.006);
    tube(
      cabinet,
      [
        [0.69, 0.43, -0.2],
        [0.89, 0.65, -0.2],
        [0.89, 1.8, -0.2],
        [0.65, 1.99, -0.2],
      ],
      0.033,
      M.chrome,
    );
    const incoming = new THREE.Group();
    incoming.userData.moving = true;
    cabinet.add(incoming);
    box(incoming, 0.86, 0.42, 0.043, 0, 0, 0, M.light, 0.035);
    const nameTex = canvasTexture(432, 204, (c, w, h) => {
      c.fillStyle = "#cbf6df";
      c.fillRect(0, 0, w, h);
      c.fillStyle = "#2a2e26";
      c.beginPath();
      c.arc(58, 98, 32, 0, TAU);
      c.fill();
      print(c, "R", 44, 112, 34, "#cbf6df", 550);
      print(c, "New entry", 108, 91, 38, "#222822", 600);
      print(c, "Registered  +", 108, 138, 23, "#3f5248", 500);
    });
    screen(incoming, 0.82, 0.39, 0, 0, 0.026, nameTex);

    const cashdesk = stations[4]!.group;
    box(cashdesk, 1.91, 0.63, 1.32, 0, 0.65, -0.06, S.ivory, 0.12);
    box(cashdesk, 1.96, 0.19, 1.38, 0, 0.42, -0.04, S.body, 0.04);
    box(cashdesk, 1.37, 0.09, 0.038, 0, 0.44, 0.66, M.dark, 0.01);
    box(cashdesk, 0.37, 0.042, 0.03, 0, 0.45, 0.687, M.chrome, 0.009);
    box(cashdesk, 1.02, 0.25, 0.91, -0.33, 1.04, -0.03, S.body, 0.045);
    // The seal press: a pad on the desk and a stamp that comes down on it, then lifts.
    cyl(cashdesk, 0.27, 0.03, -0.45, 1.18, 0.12, M.dark);
    cyl(cashdesk, 0.2, 0.012, -0.45, 1.2, 0.12, M.sage);
    const press = new THREE.Group();
    press.userData.moving = true;
    press.position.set(-0.45, 1.5, 0.12);
    cashdesk.add(press);
    cyl(press, 0.075, 0.48, 0, 0.3, 0, M.chrome);
    ball(press, 0.11, 0, 0.58, 0, M.ivory);
    cyl(press, 0.21, 0.09, 0, 0, 0, M.accent);
    cyl(press, 0.17, 0.02, 0, -0.055, 0, M.light);
    box(cashdesk, 0.64, 0.6, 0.52, 0.58, 1.04, -0.15, S.body, 0.045);
    box(cashdesk, 0.48, 0.07, 0.09, 0.59, 1.37, -0.1, M.dark, 0.01);
    cyl(cashdesk, 0.06, 0.65, -0.35, 1.6, -0.56, M.chrome);
    box(cashdesk, 1.13, 0.46, 0.19, -0.35, 1.98, -0.56, S.body, 0.045);
    const cashTex = canvasTexture(512, 176, () => {});
    function drawCash() {
      const c = cashTex.ctx;
      c.fillStyle = "#12231e";
      c.fillRect(0, 0, 512, 176);
      print(c, "RESULTS PUBLISHED", 22, 44, 23, "#9cae91", 500);
      print(c, "✓ Verified", 26, 131, 62, "#e3f7e6", 500);
    }
    drawCash();
    screen(cashdesk, 1.015, 0.349, -0.35, 1.98, -0.459, cashTex);
    const receipt = new THREE.Group();
    receipt.position.set(0.59, 1.37, -0.1);
    receipt.userData.moving = true;
    cashdesk.add(receipt);
    // The certificate the desk prints.
    const receiptTex = canvasTexture(280, 540, (c, w, h) => {
      c.fillStyle = "#f4f1ea";
      c.fillRect(0, 0, w, h);
      print(c, "PLANSPHERE", 25, 52, 24, "#333d36", 650);
      print(c, "CERTIFICATE", 32, 87, 19, "#566059");
      c.strokeStyle = "#8a9189";
      c.setLineDash([5, 6]);
      c.beginPath();
      c.moveTo(22, 115);
      c.lineTo(258, 115);
      c.stroke();
      print(c, "Participation", 25, 154, 22, "#333d36");
      print(c, "Event / Fest", 25, 190, 21, "#333d36");
      print(c, "VERIFIED", 25, 263, 31, "#333d36", 650);
      print(c, "Check by number", 25, 317, 22, "#687067");
      for (let i = 0; i < 44; i++) {
        c.fillStyle = "#333d36";
        c.fillRect(25 + i * 5, 370, 1 + (i % 3), 83);
      }
      print(c, "No. 0001", 81, 496, 17, "#59635b");
    });
    const rp = screen(receipt, 0.41, 0.83, 0, 0.415, 0.01, receiptTex);
    rp.material.side = THREE.DoubleSide;
    receipt.rotation.x = -0.16;
    const coin = new THREE.Group();
    coin.userData.moving = true;
    cashdesk.add(coin);
    const coinDisc = cyl(coin, 0.22, 0.065, 0, 0, 0, M.accent, undefined, 32);
    coinDisc.rotation.x = Math.PI / 2;
    const coinRing = new THREE.Mesh(new THREE.TorusGeometry(0.174, 0.014, 6, 32), M.light);
    coinRing.position.z = 0.037;
    coin.add(coinRing);
    const markTex = canvasTexture(128, 128, (c, w, h) => {
      c.clearRect(0, 0, w, h);
      c.textAlign = "center";
      print(c, "✓", 64, 92, 84, "#2f4a3b", 650);
    });
    const mark = screen(coin, 0.28, 0.28, 0, 0, 0.04, markTex);
    mark.material.transparent = true;
    cyl(cashdesk, 0.33, 0.09, 1.04, 0.39, 0.55, M.dark);
    cyl(cashdesk, 0.26, 0.025, 1.04, 0.445, 0.55, M.sage);

    // Conveyor: a closed spline, instanced treads, continuous rails and phase-locked cargo.
    const path = new THREE.CatmullRomCurve3(
      [
        [-3.95, 0.84, 0.65],
        [-3.1, 0.84, -0.12],
        [-1.45, 0.84, -0.79],
        [1.32, 0.84, -0.8],
        [3.3, 0.84, 0.19],
        [3.43, 0.84, 1.21],
        [1.35, 0.84, 2.7],
        [-1.4, 0.84, 2.52],
        [-3.54, 0.84, 1.65],
      ].map((p) => new THREE.Vector3(p[0], p[1], p[2])),
      true,
      "catmullrom",
      0.25,
    );
    const belt = new THREE.Group();
    machine.add(belt);
    const frameMesh = new THREE.Mesh(new THREE.TubeGeometry(path, 150, 0.35, 8, true), M.dark);
    frameMesh.scale.y = 0.3;
    frameMesh.position.y = 0.51;
    belt.add(frameMesh);
    const beltCount = 148;
    const beltSlats = new THREE.InstancedMesh(boxGeo(0.135, 0.065, 0.63, 0.012), M.body, beltCount);
    beltSlats.receiveShadow = true;
    beltSlats.castShadow = false;
    belt.add(beltSlats);
    beltSlats.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const dummy = new THREE.Object3D();
    const pVec = new THREE.Vector3();
    const tVec = new THREE.Vector3();
    function updateBelt(t: number) {
      for (let i = 0; i < beltCount; i++) {
        const u = (i / beltCount + t * 0.012) % 1;
        path.getPointAt(u, pVec);
        path.getTangentAt(u, tVec);
        dummy.position.copy(pVec);
        dummy.rotation.set(0, -Math.atan2(tVec.z, tVec.x), 0);
        dummy.updateMatrix();
        beltSlats.setMatrixAt(i, dummy.matrix);
      }
      beltSlats.instanceMatrix.needsUpdate = true;
    }
    updateBelt(0);
    for (const side of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i <= 160; i++) {
        path.getPointAt(i / 160, pVec);
        path.getTangentAt(i / 160, tVec);
        pts.push(pVec.clone().add(new THREE.Vector3(-tVec.z * 0.36 * side, 0.09, tVec.x * 0.36 * side)));
      }
      const railPath = new THREE.CatmullRomCurve3(pts);
      belt.add(new THREE.Mesh(new THREE.TubeGeometry(railPath, 160, 0.028, 6, false), M.chrome));
    }
    for (let i = 0; i < 16; i++) {
      const p = path.getPointAt(i / 16);
      cyl(belt, 0.045, 0.43, p.x, 0.53, p.z, M.chrome);
    }
    // Pneumatic lines link the station footings independently from the conveyor.
    const pipes = new THREE.Group();
    machine.add(pipes);
    for (let i = 0; i < 4; i++) {
      const a = stations[i]!.base;
      const b = stations[i + 1]!.base;
      const points = [
        a.clone().add(new THREE.Vector3(0.4, 0.12, 0)),
        a.clone().lerp(b, 0.35).add(new THREE.Vector3(0, 0.1, -0.6)),
        a.clone().lerp(b, 0.65).add(new THREE.Vector3(0, 0.1, -0.6)),
        b.clone().add(new THREE.Vector3(-0.4, 0.12, 0)),
      ];
      const curve = new THREE.CatmullRomCurve3(points);
      pipes.add(new THREE.Mesh(new THREE.TubeGeometry(curve, 30, 0.054, 8, false), M.sage));
    }
    const scriptTex = canvasTexture(256, 352, (c, w, h) => {
      c.fillStyle = "#eeeae0";
      c.fillRect(0, 0, w, h);
      print(c, "ENTRY", 24, 47, 22, "#3b403a", 650);
      print(c, "01 / Details", 24, 85, 15, "#8b8d80");
      for (let i = 0; i < 9; i++) {
        c.fillStyle = i === 4 ? "#7fd1a8" : "#aeb2a5";
        c.fillRect(24, 111 + i * 21, 190 - (i % 3) * 24, 6);
      }
      print(c, "CONFIRMED  ✓", 24, 327, 17, "#3f5248", 600);
    });
    const orderCardTex = canvasTexture(256, 352, (c) => {
      c.fillStyle = "#9fc9b3";
      c.fillRect(0, 0, 256, 352);
      print(c, "NEW", 21, 48, 24, "#1f2a24", 650);
      print(c, "ENTRY", 21, 79, 24, "#1f2a24", 650);
      c.strokeStyle = "#3f5248";
      c.lineWidth = 2;
      c.strokeRect(23, 112, 210, 139);
      print(c, "Team", 42, 190, 37, "#1f2a24", 550);
      print(c, "EVENT / 01", 23, 320, 17, "#2d3f35");
    });
    const packetTextures = [orderCardTex, scriptTex, videoTexture, postTex, receiptTex];
    const packets: Array<{
      group: THREE.Group;
      faces: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[];
      halo: THREE.Mesh;
      stage: number;
      phase: number;
    }> = [];
    for (let i = 0; i < 6; i++) {
      const g = new THREE.Group();
      g.userData.moving = true;
      machine.add(g);
      box(g, 0.47, 0.71, 0.04, 0, 0, 0, M.ivory, 0.022);
      const faces = packetTextures.map((tex) => {
        const s = screen(g, 0.43, 0.665, 0, 0, 0.024, tex);
        s.material.side = THREE.DoubleSide;
        s.visible = false;
        return s;
      });
      const halo = new THREE.Mesh(
        new THREE.RingGeometry(0.4, 0.414, 40),
        new THREE.MeshBasicMaterial({ color: 0x7fd1a8, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }),
      );
      halo.rotation.x = -Math.PI / 2;
      halo.position.y = -0.37;
      g.add(halo);
      halo.visible = false;
      packets.push({ group: g, faces, halo, stage: -1, phase: 0 });
    }
    let adminU = 0.2;
    let storeU = 0.37;
    let cashU = 0.72;
    // Find ports by arc length, so the travelling entry arrives at the actual station.
    function nearestPort(x: number, z: number) {
      let best = 0;
      let dist = Infinity;
      for (let i = 0; i < 300; i++) {
        const p = path.getPointAt(i / 300);
        const d = (p.x - x) ** 2 + (p.z - z) ** 2;
        if (d < dist) {
          dist = d;
          best = i / 300;
        }
      }
      return best;
    }
    adminU = nearestPort(-1.65, -0.7);
    storeU = nearestPort(1.5, -0.7);
    cashU = nearestPort(0.93, 2.65);

    // Merge static geometry per parent/material. Moving assemblies remain separate.
    function compact(group: THREE.Object3D) {
      for (const child of [...group.children]) if ((child as THREE.Group).isGroup) compact(child);
      const buckets = new Map<string, THREE.Mesh<THREE.BufferGeometry, THREE.Material>[]>();
      for (const object of group.children) {
        const child = object as THREE.Mesh<THREE.BufferGeometry, THREE.Material> & { isInstancedMesh?: boolean };
        if (!child.isMesh || child.isInstancedMesh || child.userData.moving || Array.isArray(child.material)) continue;
        const k = child.material.uuid;
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k)!.push(child);
      }
      for (const list of buckets.values()) {
        if (list.length < 2) continue;
        const geos = list.map((m) => {
          m.updateMatrix();
          const g = m.geometry.index ? m.geometry.toNonIndexed() : m.geometry.clone();
          return g.applyMatrix4(m.matrix);
        });
        const merged = mergeGeometries(geos, false);
        for (const geo of geos) geo.dispose();
        if (!merged) continue;
        const mesh = new THREE.Mesh(merged, list[0]!.material);
        mesh.castShadow = list.some((x) => x.castShadow);
        mesh.receiveShadow = list.some((x) => x.receiveShadow);
        for (const m of list) group.remove(m);
        group.add(mesh);
      }
    }
    // These references are animated individually and must not be merged into their parent.
    [incoming, receipt, coin, outputVideo, flyPost, printhead, ...reels].forEach((g) => (g.userData.moving = true));
    compact(machine);
    stations.forEach((s) =>
      s.group.traverse((o) => {
        o.userData.station = s.id;
      }),
    );
    const pickables = stations.map((s) => s.group);

    let mode: MachineMode = "assembled";
    let cameraMode: MachineCamera = "overview";
    let playing = !reduceMotion;
    let simTime = 0;
    let spread = 0;
    let selected: string = "engine";
    let hovered: string | null = null;

    let width = frameWidth();
    let height = frameHeight();
    let mobile = width <= MOBILE_WIDTH;
    let lastInteraction = performance.now();
    let dragging = false;
    let wasDragged = false;
    let downX = 0;
    let downY = 0;
    let cameraAnimating = true;
    let flightTime = 0;
    let lastDraw = -1;
    let visible = true;
    let contextLost = false;
    const desiredPosition = new THREE.Vector3();
    const desiredTarget = new THREE.Vector3(0, 1, 0);
    const viewDirection = new THREE.Vector3(10.5, 10.8, 17).normalize();
    let baseDistance = 25;
    let sized = false;
    let readySent = false;
    // A zero-size box used to send the camera to infinity; wait for a real size, and place the
    // camera at once on the first one, without a fly-in.
    function layoutCamera() {
      if (!frameWidth() || !frameHeight()) return;
      const first = !sized;
      sized = true;
      width = frameWidth();
      height = frameHeight();
      mobile = width <= MOBILE_WIDTH;
      renderer.setSize(width, height);
      camera.aspect = width / height;
      // A shifted frustum centres the machine in the right 58 % of a wide frame, so the host
      // page's headline sits on the left, without moving the orbit target.
      camera.setViewOffset(width, height, mobile ? 0 : -width * 0.21, 0, width, height);
      const aspect = width / height;
      const availableWidth = mobile ? 0.91 : Math.min(0.55, aspect > 2 ? 0.54 : 0.57);
      const horizontalFit = 17.3 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * aspect * availableWidth);
      const verticalFit = 11.5 / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)) * 0.85);
      baseDistance = (Math.max(horizontalFit, verticalFit) * (mobile ? 0.97 : 1)) / (mobile ? 1.15 : 1.3);
      controls.maxDistance = Math.max(55, baseDistance * 1.6);
      camera.updateProjectionMatrix();
      setCameraGoal();
      cameraAnimating = true;
      if (first) {
        camera.position.copy(desiredPosition);
        controls.target.copy(desiredTarget);
        controls.update();
        cameraAnimating = false;
      }
    }
    function setCameraGoal() {
      const expand = mode === "stations" ? 1.2 : 1;
      if (cameraMode === "station") {
        const s = stations.find((st) => st.id === selected)!;
        desiredTarget.copy(s.group.position).add(new THREE.Vector3(0, 1.25, 0));
        desiredPosition.copy(desiredTarget).addScaledVector(viewDirection, mobile ? 9 : 12);
      } else {
        desiredTarget.set(0, 1, 0);
        const distance = baseDistance * expand;
        if (cameraMode === "side") desiredPosition.set(13, 5, 20).normalize().multiplyScalar(distance).add(desiredTarget);
        else if (cameraMode === "top") desiredPosition.set(0.01, distance, 0.8).add(desiredTarget);
        else desiredPosition.copy(viewDirection).multiplyScalar(distance).add(desiredTarget);
      }
    }
    function syncButtons() {
      root.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
      root.querySelectorAll<HTMLElement>("[data-camera]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.camera === cameraMode)));
      $("journey").classList.toggle("visible", mode === "order");
    }
    const modes: readonly MachineMode[] = ["assembled", "cutaway", "stations", "order"];
    const cameras: readonly MachineCamera[] = ["overview", "side", "top", "station", "flight"];
    function setMode(name: string) {
      const next = modes.find((m) => m === name);
      if (!next) return false;
      mode = next;
      lastInteraction = performance.now();
      if (mode === "order") {
        simTime = 0;
        lastDraw = -1;
        play();
        cameraMode = "overview";
      } else if (cameraMode === "station") cameraMode = "overview";
      setCameraGoal();
      cameraAnimating = true;
      syncButtons();
      return true;
    }
    function focusStation(id: string) {
      const s = stations.find((st) => st.id === id);
      if (!s) return false;
      selected = id;
      if (mode === "order") mode = "assembled";
      cameraMode = "station";
      lastInteraction = performance.now();
      setCameraGoal();
      cameraAnimating = true;
      syncButtons();
      return true;
    }
    function setCamera(name: string) {
      const next = cameras.find((c) => c === name);
      if (!next) return false;
      cameraMode = next;
      if (mode === "order") mode = "assembled";
      lastInteraction = performance.now();
      flightTime = 0;
      setCameraGoal();
      cameraAnimating = true;
      syncButtons();
      return true;
    }
    function syncPlayback() {
      $("status").classList.toggle("paused", !playing);
      $("play").setAttribute("aria-pressed", String(!playing));
    }
    function play() {
      playing = true;
      syncPlayback();
      return true;
    }
    function pause() {
      playing = false;
      syncPlayback();
      return true;
    }
    void focusStation;
    root.querySelectorAll<HTMLElement>("[data-mode]").forEach((b) => listen(b, "click", () => setMode(b.dataset.mode ?? "")));
    root.querySelectorAll<HTMLElement>("[data-camera]").forEach((b) => listen(b, "click", () => setCamera(b.dataset.camera ?? "")));
    listen($("play"), "click", () => (playing ? pause() : play()));
    syncPlayback();
    layoutCamera();
    camera.position.copy(desiredPosition);
    controls.target.copy(desiredTarget);
    controls.update();
    cameraAnimating = false;
    listen(window, "resize", layoutCamera);
    const resizeObserver = new ResizeObserver(() => layoutCamera());
    resizeObserver.observe(root);
    cleanups.push(() => resizeObserver.disconnect());
    controls.addEventListener("start", () => {
      dragging = true;
      cameraAnimating = false;
      lastInteraction = performance.now();
    });
    controls.addEventListener("end", () => {
      dragging = false;
      lastInteraction = performance.now();
    });
    controls.addEventListener("change", () => {
      if (dragging) lastInteraction = performance.now();
    });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const tooltip = $("tooltip");
    function hitStation(x: number, y: number) {
      pointer.set((x / width) * 2 - 1, (-y / height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const hits = raycaster.intersectObjects(pickables, true);
      const first = hits[0];
      return first ? stations.find((s) => s.id === first.object.userData.station) : null;
    }
    const local = (e: PointerEvent) => {
      const rect = root.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    };
    listen(renderer.domElement, "pointermove", (e: PointerEvent) => {
      const p = local(e);
      if (Math.hypot(p.x - downX, p.y - downY) > 5) wasDragged = true;
      if (dragging) return;
      const s = hitStation(p.x, p.y);
      hovered = s ? s.id : null;
      renderer.domElement.style.cursor = s ? "pointer" : "grab";
      tooltip.classList.toggle("visible", !!s);
      if (s) {
        tooltip.querySelector("strong")!.innerHTML = `<span>${String(s.index + 1).padStart(2, "0")}</span>${s.name}`;
        tooltip.querySelector("p")!.textContent = s.desc;
        tooltip.style.left = Math.min(width - 255, Math.max(10, p.x + 16)) + "px";
        tooltip.style.top = Math.max(10, Math.min(height - 95, p.y - 65)) + "px";
      }
    });
    listen(renderer.domElement, "pointerleave", () => {
      hovered = null;
      tooltip.classList.remove("visible");
    });
    listen(renderer.domElement, "pointerdown", (e: PointerEvent) => {
      const p = local(e);
      downX = p.x;
      downY = p.y;
      wasDragged = false;
      tooltip.classList.remove("visible");
    });
    listen(renderer.domElement, "pointerup", (e: PointerEvent) => {
      if (wasDragged) return;
      const p = local(e);
      const s = hitStation(p.x, p.y);
      // In the hero a click only reports the station; the camera stays put.
      if (s) options.onStation?.(s.id);
    });
    listen(document, "visibilitychange", () => {
      visible = !document.hidden;
      lastFrame = performance.now();
    });
    const observer = new IntersectionObserver(
      (entries) => {
        visible = !!entries[0]?.isIntersecting && !document.hidden;
        lastFrame = performance.now();
      },
      { threshold: 0.01 },
    );
    observer.observe(renderer.domElement);
    cleanups.push(() => observer.disconnect());
    listen(renderer.domElement, "webglcontextlost", (e: Event) => {
      e.preventDefault();
      contextLost = true;
      options.onError?.();
    });
    listen(renderer.domElement, "webglcontextrestored", () => {
      contextLost = false;
      lastFrame = performance.now();
    });

    const scratch = new THREE.Vector3();
    const anchor = new THREE.Vector3();
    const journeySteps = [
      ["Registration", "Register · a student signs up"],
      ["QR pass issued", "QR Pass · every entry gets a pass"],
      ["Gate check-in", "Gate · volunteers scan the pass"],
      ["Live scores", "Live · results as they happen"],
      ["Certificate", "Certify · verifiable by number"],
    ] as const;
    let prevJourney = -1;
    let lastFrame = performance.now();
    let frameCount = 0;
    let measureTime = 0;
    let pixelRatio = renderer.getPixelRatio();
    let rafId = 0;
    function animate(now: number) {
      rafId = requestAnimationFrame(animate);
      const dt = Math.max(0, Math.min((now - lastFrame) / 1000, 0.045));
      lastFrame = now;
      if (!visible || contextLost) return;
      if (playing) {
        simTime += dt;
        flightTime += dt;
      }
      const t = simTime;
      const beat = (t / 4) % 1;
      const tact = (t * TAU) / 4;
      const smooth = 1 - Math.exp(-dt * 5);
      spread = THREE.MathUtils.lerp(spread, mode === "stations" ? 1 : 0, smooth);
      cutPlane.constant = THREE.MathUtils.lerp(cutPlane.constant, mode === "cutaway" ? 0.99 : 10, smooth);
      stations.forEach((s, i) => {
        s.group.position.copy(s.base);
        s.group.position.x *= 1 + spread * 0.29;
        s.group.position.z *= 1 + spread * 0.37;
        s.group.position.y += spread * (i % 2 ? 0.32 : 0.55);
        const pulse = Math.pow(Math.max(0, Math.sin(tact - i * 0.9)), 7);
        s.glowMat.emissiveIntensity = THREE.MathUtils.lerp(
          s.glowMat.emissiveIntensity,
          hovered === s.id || (cameraMode === "station" && selected === s.id) ? 3.5 : 0.55 + pulse * 0.65,
          smooth,
        );
      });
      belt.scale.set(1 + spread * 0.12, 1, 1 + spread * 0.15);
      pipes.scale.set(1 + spread * 0.25, 1, 1 + spread * 0.3);
      gears.forEach(({ g, vertical }, i) => {
        if (vertical) g.rotation.z = t * (i % 2 ? -1 : 1) * 1.1;
        else g.rotation.y = t * (i % 2 ? -1 : 1) * 1.1;
      });
      reels.forEach((r, i) => (r.rotation.z = -t * (i ? 0.65 : 0.85)));
      printhead.position.x = Math.sin(tact) * 0.42;
      printhead.position.y = 1.91 + Math.sin(tact * 2) * 0.055;
      outputVideo.position.y = beat * 0.25;
      flyPost.position.y = Math.sin(tact) * 0.04;
      scanBeam.position.z = 0.52 + Math.sin(tact * 3) * 0.12;
      (scanBeam.material as THREE.MeshBasicMaterial).opacity = 0.2 + (Math.sin(tact * 6) + 1) * 0.12;
      press.position.y = 1.5 - Math.pow(Math.max(0, Math.sin(tact * 1.5)), 6) * 0.27;
      const orderPhase = (t / 24) % 1;
      const cashBeat = mode === "order" ? THREE.MathUtils.clamp((orderPhase - 0.88) / 0.12, 0, 1) : beat;
      receipt.visible = coin.visible = mode !== "order" || orderPhase > 0.88;
      receipt.scale.y = 0.2 + Math.min(1, cashBeat * 1.5) * 0.8;
      coin.position.set(1.04, 2.7 - Math.min(1, cashBeat * 1.7) ** 2 * 2.17, 0.55);
      coin.rotation.y = t * 3.5;
      coin.scale.setScalar(cashBeat > 0.9 ? 1 - (cashBeat - 0.9) * 8 : 1);
      const incomingBeat = mode === "order" ? Math.min(1, orderPhase / 0.15) : beat;
      incoming.visible = mode !== "order" || orderPhase < 0.15;
      incoming.position.set(Math.sin(incomingBeat * Math.PI) * 0.24, 2.9 - incomingBeat * 1.9, 1.1 - incomingBeat * 0.55);
      incoming.rotation.z = Math.sin(incomingBeat * Math.PI) * -0.14;
      incoming.scale.setScalar(Math.min(1, incomingBeat * 8 + 0.15, (1 - incomingBeat) * 7 + 0.1));
      toggles.forEach((o, i) => (o.rotation.x = Math.sin(tact + i) > 0 ? -0.4 : 0.4));
      if (t - lastDraw > 1 / 18 || lastDraw < 0) {
        drawVideo(t);
        drawQueue(t);
        queue.texture.needsUpdate = true;
        updateBelt(t);
        lastDraw = t;
      }
      packets.forEach((packet, i) => {
        const phase = (t / 24 + i / 6) % 1;
        packet.phase = phase;
        let stage: number;
        if (phase < 0.15) {
          stage = 0;
          const f = phase / 0.15;
          packet.group.position.copy(stations[3]!.group.position).add(new THREE.Vector3(0, 1.6, 0.6));
          scratch.copy(stations[0]!.group.position).add(new THREE.Vector3(0, 1.3, 0.65));
          packet.group.position.lerp(scratch, f);
          packet.group.position.y += Math.sin(f * Math.PI) * 2;
          packet.group.rotation.set(0, Math.sin(f * Math.PI) * 0.28, Math.sin(f * Math.PI) * -0.1);
        } else {
          const u = ((phase - 0.15) / 0.85) * cashU;
          path.getPointAt(u, packet.group.position);
          packet.group.position.x *= 1 + spread * 0.12;
          packet.group.position.z *= 1 + spread * 0.15;
          packet.group.position.y += 0.43;
          packet.group.rotation.set(0, 0.18, 0);
          stage = u < adminU * 0.7 ? 1 : u < storeU * 0.96 ? 2 : u < cashU * 0.83 ? 3 : 4;
        }
        if (packet.stage !== stage) {
          packet.faces.forEach((f, j) => (f.visible = j === stage));
          packet.stage = stage;
        }
        packet.group.visible = mode !== "order" || i === 0;
        packet.halo.visible = mode === "order" && i === 0;
        packet.group.scale.setScalar(mode === "order" ? 1.35 : 1);
        if (phase > 0.94) packet.group.scale.multiplyScalar(Math.max(0.05, (1 - phase) / 0.06));
      });
      if (mode === "order") {
        const packet = packets[0]!;
        const step = packet.stage;
        if (step !== prevJourney) {
          const s = journeySteps[step];
          if (s) {
            $("journey-title").textContent = s[0];
            $("journey-detail").textContent = s[1];
          }
          prevJourney = step;
        }
        $("journey-progress").style.width = packet.phase * 100 + "%";
        if (!dragging && playing) {
          desiredTarget.copy(packet.group.position);
          desiredPosition.copy(desiredTarget).addScaledVector(viewDirection, mobile ? 10 : 15);
          cameraAnimating = true;
        }
      } else if (cameraMode === "flight" && playing && !dragging) {
        const a = flightTime * 0.12;
        const d = baseDistance * (mode === "stations" ? 1.2 : 1);
        desiredTarget.set(0, 1, 0);
        desiredPosition
          .set(Math.sin(a + 0.55) * d * 0.83, d * (0.5 + Math.sin(a * 0.7) * 0.09), Math.cos(a + 0.55) * d * 0.83)
          .add(desiredTarget);
        cameraAnimating = true;
      } else if (cameraMode === "station" && cameraAnimating) setCameraGoal();
      if (cameraAnimating && !dragging) {
        const speed = 1 - Math.exp(-dt * (mode === "order" ? 2.2 : 3));
        camera.position.lerp(desiredPosition, speed);
        controls.target.lerp(desiredTarget, speed);
        if (
          cameraMode !== "flight" &&
          mode !== "order" &&
          camera.position.distanceTo(desiredPosition) < 0.015 &&
          controls.target.distanceTo(desiredTarget) < 0.015
        )
          cameraAnimating = false;
      }
      controls.autoRotate =
        playing && !reduceMotion && !dragging && !cameraAnimating && mode !== "order" && cameraMode === "overview" && now - lastInteraction > 6500;
      controls.autoRotateSpeed = 0.24;
      controls.update(dt);
      // Project station callouts after the camera update (only shown in the "stations" mode).
      stations.forEach((s, i) => {
        const show = mode === "stations";
        s.label.classList.toggle("visible", show);
        if (!show) return;
        anchor.copy(s.group.position).add(s.anchor).project(camera);
        const offsets = mobile
          ? [[-30, 25], [-27, -50], [15, -65], [16, -1], [-5, 52]]
          : [[-48, -14], [-8, -64], [30, -12], [30, 20], [-12, 40]];
        const o = offsets[i]!;
        let x = (anchor.x * 0.5 + 0.5) * width - 40 + o[0]!;
        let y = (-anchor.y * 0.5 + 0.5) * height - 52 + o[1]!;
        x = THREE.MathUtils.clamp(x, mobile ? 9 : width * 0.425, width - (mobile ? 123 : 165));
        y = THREE.MathUtils.clamp(y, 130, height - 200);
        s.label.style.transform = `translate(${x}px,${y}px)`;
      });
      renderer.render(scene, camera);
      // The first real frame is ready: the host can fade the scene in over its static art.
      if (!readySent && sized) {
        readySent = true;
        options.onReady?.();
      }
      // Reduce only raster resolution on sustained slow devices; geometry and timing stay identical.
      if (playing) {
        frameCount++;
        measureTime += dt;
        if (measureTime > 4) {
          if (frameCount / measureTime < 43 && pixelRatio > 1) {
            pixelRatio = Math.max(1, pixelRatio - 0.25);
            renderer.setPixelRatio(pixelRatio);
          }
          frameCount = 0;
          measureTime = 0;
        }
      }
    }
    rafId = requestAnimationFrame(animate);
    cleanups.push(() => {
      cancelAnimationFrame(rafId);
      controls.dispose();
      // Free every GPU resource the scene created, then the context itself.
      const textures = new Set<THREE.Texture>();
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
        const list = mesh.material ? (Array.isArray(mesh.material) ? mesh.material : [mesh.material]) : [];
        for (const material of list) {
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) textures.add(value);
          material.dispose();
        }
      });
      geometries.forEach((g) => g.dispose());
      textures.forEach((tex) => tex.dispose());
      env.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    });
    renderer.compile(scene, camera);
  } catch (error) {
    console.error("Machine: failed to start", error);
    options.onError?.();
  }
  return dispose;
}

// ---------------------------------------------------------------------------
// Styles, scoped to .plansphere-machine.
// ---------------------------------------------------------------------------

const STYLES = String.raw`
.plansphere-machine { position: relative; width: 100%; height: 100%; overflow: hidden; contain: layout; color: #f4f1ea; font-size: 13px; }
.plansphere-machine, .plansphere-machine * { box-sizing: border-box; }
.plansphere-machine #scene { position: absolute; inset: 0; outline: none; }
.plansphere-machine #scene canvas { display: block; width: 100%; height: 100%; }
.plansphere-machine .debug-ui { display: none !important; }
.plansphere-machine #labels { position: absolute; inset: 0; pointer-events: none; overflow: hidden; }
.plansphere-machine .station-label { position: absolute; left: 0; top: 0; opacity: 0; transition: opacity .3s; will-change: transform; pointer-events: none; min-width: 138px; }
.plansphere-machine .station-label.visible { opacity: 1; }
.plansphere-machine .station-label .stem { height: 26px; width: 1px; background: linear-gradient(#7fd1a800, #7fd1a870); margin: 0 0 0 10px; }
.plansphere-machine .station-label .label-card { background: #14171bee; backdrop-filter: blur(10px); border: 1px solid #7fd1a840; border-radius: 6px; padding: 10px 13px; box-shadow: 0 4px 20px #0003; }
.plansphere-machine .station-label .label-title { font-weight: 550; font-size: 12px; display: flex; gap: 10px; align-items: center; white-space: nowrap; }
.plansphere-machine .station-label .label-title span { color: #7fd1a8; font: 9px ui-monospace, Menlo, monospace; }
.plansphere-machine .station-label .label-meta { font-size: 9px; color: #8e939c; margin: 6px 0 0 24px; white-space: nowrap; }
.plansphere-machine #tooltip { position: absolute; pointer-events: none; z-index: 10; opacity: 0; transition: opacity .15s; padding: 11px 14px; border: 1px solid #ffffff1a; background: #171a20ed; backdrop-filter: blur(12px); box-shadow: 0 8px 32px #0005; border-radius: 7px; max-width: 240px; }
.plansphere-machine #tooltip.visible { opacity: 1; }
.plansphere-machine #tooltip strong { font-size: 12px; font-weight: 550; }
.plansphere-machine #tooltip strong span { font-size: 10px; color: #7fd1a8; margin-right: 8px; }
.plansphere-machine #tooltip p { font-size: 11px; color: #b3b7be; margin: 6px 0 0; line-height: 1.5; }
@media (prefers-reduced-motion: reduce) { .plansphere-machine, .plansphere-machine * { transition: none !important; } }
`;
