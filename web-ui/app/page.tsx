"use client";

import { useEffect, useRef, useState } from "react";
import {
  AnimatePresence,
  animate,
  motion,
  useMotionValue,
  useMotionValueEvent,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from "framer-motion";
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  Cpu,
  KeyRound,
  Moon,
  ShieldCheck,
  Sun,
  Terminal,
  type LucideIcon,
} from "lucide-react";
import { triggerExorcist, triggerPoltergeist } from "../lib/api";

type AttackPhase = "idle" | "card1" | "card2" | "card3" | "complete";
type Point = { x: number; y: number };
type ReaperState = { key: number; start: Point; target: Point; flip: boolean };
type Beam = { key: number; from: Point; to: Point };

// Scythe-tip position relative to the reaper's centre (px) and inside the image (%).
const REAPER_TIP = { x: 58, y: -102 };
const REAPER_TIP_PCT = { x: 76, y: 16 };

type CardData = {
  id: number;
  code: string;
  name: string;
  icon: LucideIcon;
  stat: string;
  detail: string;
  metrics: [string, string][];
  faultStat: string;
  faultDetail: string;
  faultMetrics: [string, string][];
};

const cards: CardData[] = [
  {
    id: 1,
    code: "01",
    name: "Neural Core",
    icon: Cpu,
    stat: "99.98%",
    detail: "Uptime",
    metrics: [["Latency", "12 ms"], ["Load", "34%"]],
    faultStat: "0.00%",
    faultDetail: "Uptime",
    faultMetrics: [["Latency", "∞"], ["Load", "NaN"]],
  },
  {
    id: 2,
    code: "02",
    name: "Edge Firewall",
    icon: ShieldCheck,
    stat: "Shielded",
    detail: "· 0 Breaches",
    metrics: [["Rules", "4,812"], ["Blocked", "1.2M/h"]],
    faultStat: "SHIELD_DOWN",
    faultDetail: "· ∞ Breaches",
    faultMetrics: [["Rules", "0x00"], ["Blocked", "ERR"]],
  },
  {
    id: 3,
    code: "03",
    name: "Vault Auth",
    icon: KeyRound,
    stat: "Encrypted",
    detail: "· 14ms",
    metrics: [["Sessions", "8,204"], ["Tokens", "Valid"]],
    faultStat: "KEY_VOID",
    faultDetail: "· ∞ ms",
    faultMetrics: [["Sessions", "NaN"], ["Tokens", "Void"]],
  },
];

const CARD_PHASES: AttackPhase[] = ["card1", "card2", "card3"];
const NAV_LINKS: [string, 0 | 1][] = [
  ["Overview", 0],
  ["Neural Core", 0],
  ["Defense Mesh", 1],
  ["Telemetry", 1],
];

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type LogLine = { id: number; text: string };
type RunMode = "local" | "backend";

// One status line per target, in attack order (Card 1 -> Card 2 -> Card 3).
const ATTACK_LOGS = [
  "[POLTERGEIST] Injecting ARC_FAULT on Neural Core...",
  "[POLTERGEIST] Breaching Edge Firewall...",
  "[POLTERGEIST] Corrupting Vault Auth...",
];

/* ------------------------------------------------------------------ */
/* Glitching text (purple / cyan RGB split, never red)                 */
/* ------------------------------------------------------------------ */
function Glitch({
  active,
  dark,
  className = "",
  children,
}: {
  active: boolean;
  dark: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const a = dark ? "#A855F7" : "#D946EF";
  const b = dark ? "#22D3EE" : "#0EA5E9";
  const w = dark ? 1.5 : 0.8;
  return (
    <motion.span
      className={`inline-block ${className}`}
      animate={
        active
          ? {
              x: [0, -1.5, 2, -1, 0],
              textShadow: [
                `${w}px 0 ${a}, -${w}px 0 ${b}`,
                `-${w * 1.3}px 0 ${a}, ${w * 1.3}px 0 ${b}`,
                `${w * 0.7}px 0 ${a}, -${w * 0.7}px 0 ${b}`,
                `${w}px 0 ${a}, -${w}px 0 ${b}`,
              ],
            }
          : { x: 0, textShadow: "0 0 0 rgba(0,0,0,0)" }
      }
      transition={active ? { duration: 0.35, repeat: Infinity } : { duration: 0.2 }}
    >
      {children}
    </motion.span>
  );
}

/* ------------------------------------------------------------------ */
/* Cracked, electrified glass overlay                                  */
/* ------------------------------------------------------------------ */
const CRACKS = [
  "M55 45 L40 30 L32 12 L20 0",
  "M55 45 L72 28 L80 10 L90 0",
  "M55 45 L85 52 L100 48",
  "M55 45 L68 70 L62 85 L70 100",
  "M55 45 L35 62 L22 70 L0 82",
  "M55 45 L47 72 L50 100",
  "M40 30 L58 24 L72 28",
  "M35 62 L47 72 L68 70",
  "M32 12 L44 16",
  "M85 52 L92 70 L100 76",
  "M22 70 L14 52 L0 46",
];

function CrackOverlay({ mirror }: { mirror: boolean }) {
  return (
    <motion.svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full"
      style={{ transform: mirror ? "scaleX(-1)" : undefined }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.5 } }}
    >
      <polygon points="55,45 40,30 72,28" fill="rgba(233,213,255,0.08)" />
      <polygon points="55,45 85,52 68,70" fill="rgba(168,85,247,0.12)" />
      <polygon points="55,45 35,62 47,72" fill="rgba(125,211,252,0.08)" />
      <motion.g
        animate={{ opacity: [1, 0.55, 1, 0.8, 1] }}
        transition={{ duration: 1.1, repeat: Infinity }}
      >
        {CRACKS.map((d, i) => (
          <g key={d}>
            <motion.path
              d={d}
              fill="none"
              stroke="#A855F7"
              strokeWidth={3.2}
              strokeOpacity={0.55}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, delay: i * 0.03 }}
            />
            <motion.path
              d={d}
              fill="none"
              stroke="#E9D5FF"
              strokeWidth={1}
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
              initial={{ pathLength: 0 }}
              animate={{ pathLength: 1 }}
              transition={{ duration: 0.35, delay: i * 0.03 }}
            />
          </g>
        ))}
      </motion.g>
    </motion.svg>
  );
}

/* Diagonal purple-cyan lightning slash shown while the scythe strikes. */
function SlashFlash() {
  const bolt = "M2 4 L38 40 L28 46 L62 70 L54 74 L98 98";
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.25 } }}
    >
      <motion.div
        className="absolute inset-0 bg-gradient-to-br from-purple-300/40 to-sky-300/30"
        initial={{ opacity: 0.9 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 0.3 }}
      />
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full"
      >
        <defs>
          <linearGradient id="slashGrad" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#38BDF8" />
            <stop offset="1" stopColor="#A855F7" />
          </linearGradient>
        </defs>
        <motion.path
          d={bolt}
          fill="none"
          stroke="url(#slashGrad)"
          strokeWidth={6}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        />
        <motion.path
          d={bolt}
          fill="none"
          stroke="#FFFFFF"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={{ duration: 0.15, ease: "easeOut" }}
        />
      </svg>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Production image assets (transparent PNGs in /public)               */
/* ------------------------------------------------------------------ */
const ASSETS = {
  skull: "/skull.png", // unlit skull (dark sockets, closed mouth)
  skullLit: "/skull-lit.png", // same skull with violet/cyan fire eyes and jaw
  hand: "/hand.png", // open U-shaped cradle
  reaper: "/reaper.png",
  crypt: "/graveyard-keyed.webp", // graveyard surface + underground crypt, sky made transparent (from Haunted.png)
};

function Img({ src, alt, className = "" }: { src: string; alt: string; className?: string }) {
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={src} alt={alt} draggable={false} decoding="async" className={`pointer-events-none ${className}`} />
  );
}

/* ------------------------------------------------------------------ */
/* Poltergeist reaper (image). It stays upright and only floats; the   */
/* attack is a charge flash at the scythe tip and a plasma ray.        */
/* ------------------------------------------------------------------ */
function Reaper({ charging, firing }: { charging: boolean; firing: boolean }) {
  return (
    <motion.div
      className="relative h-[300px] w-[224px]"
      style={{ transformOrigin: "50% 85%" }}
      animate={{ rotate: firing ? [0, -10, 0] : 0 }}
      transition={{ duration: 0.3, ease: "easeOut" }}
    >
      <Img src={ASSETS.reaper} alt="Poltergeist Reaper" className="h-full w-full select-none object-contain" />
      <AnimatePresence>
        {charging && (
          <motion.div
            key="charge"
            aria-hidden
            className="absolute h-16 w-16 -translate-x-1/2 -translate-y-1/2 rounded-full will-change-transform"
            style={{
              left: `${REAPER_TIP_PCT.x}%`,
              top: `${REAPER_TIP_PCT.y}%`,
              background:
                "radial-gradient(circle, #FFFFFF 0%, rgba(233,213,255,0.95) 26%, rgba(168,85,247,0.6) 54%, transparent 72%)",
            }}
            initial={{ scale: 0.2, opacity: 0 }}
            animate={{ scale: [0.2, 1.3, 1.1], opacity: [0, 1, 0.9] }}
            exit={{ scale: 1.8, opacity: 0, transition: { duration: 0.18 } }}
            transition={{ duration: 0.25 }}
          />
        )}
      </AnimatePresence>
    </motion.div>
  );
}

/* Jagged, deterministic lightning polyline between two page-space points. */
function jaggedPath(a: Point, b: Point, seed: number) {
  const segments = 12;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  let state = seed * 9301 + 49297;
  const rnd = () => {
    state = (state * 9301 + 49297) % 233280;
    return state / 233280 - 0.5;
  };
  let d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)}`;
  for (let i = 1; i < segments; i++) {
    const t = i / segments;
    const off = rnd() * 36 * Math.sin(Math.PI * t);
    d += ` L${(a.x + dx * t + nx * off).toFixed(1)} ${(a.y + dy * t + ny * off).toFixed(1)}`;
  }
  return `${d} L${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
}

/* Electrified purple plasma ray from the scythe tip to the target card. */
function PlasmaBeam({ from, to, seed }: { from: Point; to: Point; seed: number }) {
  const main = jaggedPath(from, to, seed);
  const fork = jaggedPath(from, to, seed + 7);
  const layers = [
    { d: main, w: 12, c: "#A855F7", o: 0.28 },
    { d: main, w: 5, c: "#C084FC", o: 0.85 },
    { d: fork, w: 2, c: "#E9D5FF", o: 0.7 },
    { d: main, w: 2, c: "#FFFFFF", o: 1 },
  ];
  return (
    <motion.svg
      aria-hidden
      className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
      initial={{ opacity: 1 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0, transition: { duration: 0.2 } }}
    >
      <motion.g
        animate={{ opacity: [1, 0.6, 1, 0.75, 1] }}
        transition={{ duration: 0.3, repeat: Infinity }}
      >
        {layers.map((l, i) => (
          <motion.path
            key={i}
            d={l.d}
            fill="none"
            stroke={l.c}
            strokeWidth={l.w}
            strokeOpacity={l.o}
            strokeLinecap="round"
            strokeLinejoin="round"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.12, ease: "easeOut" }}
          />
        ))}
      </motion.g>
    </motion.svg>
  );
}

/* ------------------------------------------------------------------ */
/* Bat silhouette (editorial accent)                                   */
/* ------------------------------------------------------------------ */
function BatIcon({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 40" aria-hidden className={className} fill="currentColor">
      <path d="M32 10 L35 4 L37 11 C42 9 48 6 56 8 C54 12 56 17 60 20 C54 19 50 20 47 24 C45 21 41 20 38 22 L36 30 L32 26 L28 30 L26 22 C23 20 19 21 17 24 C14 20 10 19 4 20 C8 17 10 12 8 8 C16 6 22 9 27 11 L29 4 Z" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Section 1 depth layers (each is its own z-layer in the page):       */
/*   z-10 half-moon, z-15 drifting clouds, z-20 graveyard + crypt.     */
/* Only CSS gradients and the crypt image, no blur filters.            */
/* ------------------------------------------------------------------ */
const crater = (x: number, y: number, r: number, rgb: string, a: number) =>
  `radial-gradient(ellipse ${r}% ${r}% at ${x}% ${y}%, rgba(${rgb},${a}) 0%, rgba(${rgb},${(a * 0.6).toFixed(2)}) 65%, transparent 100%)`;

/* Translucent silver-violet lunar glass with a faint cratered texture. */
function moonBackground(dark: boolean) {
  const rgb = dark ? "86,76,140" : "110,90,170";
  const base = dark
    ? "radial-gradient(circle at 38% 30%, rgba(246,244,255,0.95) 0%, rgba(206,198,242,0.85) 38%, rgba(150,138,205,0.75) 72%, rgba(104,92,168,0.65) 100%)"
    : "radial-gradient(circle at 38% 30%, rgba(255,255,255,0.95) 0%, rgba(226,218,250,0.85) 40%, rgba(180,164,232,0.75) 74%, rgba(140,122,208,0.65) 100%)";
  return [
    crater(34, 24, 5, rgb, 0.22),
    crater(62, 18, 7, rgb, 0.18),
    crater(48, 38, 4, rgb, 0.18),
    crater(22, 40, 6, rgb, 0.2),
    crater(76, 36, 5, rgb, 0.16),
    crater(52, 10, 3, rgb, 0.18),
    `radial-gradient(ellipse 20% 12% at 36% 17%, rgba(${rgb},0.2) 0%, transparent 100%)`,
    `radial-gradient(ellipse 14% 10% at 64% 30%, rgba(${rgb},0.18) 0%, transparent 100%)`,
    `radial-gradient(ellipse 12% 16% at 26% 33%, rgba(${rgb},0.16) 0%, transparent 100%)`,
    base,
  ].join(",");
}

/* z-10: translucent liquid-glass half-moon, so the wordmark behind it stays legible. */
function MoonLayer({ dark, moonShift }: { dark: boolean; moonShift: MotionValue<number> }) {
  const halo = dark
    ? "radial-gradient(circle, rgba(167,139,250,0.34) 0%, rgba(103,232,249,0.1) 36%, transparent 62%)"
    : "radial-gradient(circle, rgba(139,92,246,0.3) 0%, rgba(56,189,248,0.12) 36%, transparent 62%)";
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-10 h-screen overflow-hidden">
      <motion.div style={{ x: moonShift }} className="absolute bottom-[16vh] left-1/2 h-0 w-0 will-change-transform">
        <div
          className="absolute left-0 top-0 aspect-square w-[min(170vw,1800px)] -translate-x-1/2 -translate-y-1/2"
          style={{ background: halo }}
        />
        {/* glass body */}
        <div
          className="absolute left-0 top-0 aspect-square w-[min(78vw,880px)] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: moonBackground(dark),
            opacity: 0.5,
            boxShadow: "inset -30px -24px 80px rgba(60,40,120,0.25), 0 0 70px rgba(167,139,250,0.35)",
          }}
        />
        {/* luminous rim */}
        <div
          className="absolute left-0 top-0 aspect-square w-[min(78vw,880px)] -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            opacity: 0.8,
            boxShadow:
              "inset 0 0 0 1px rgba(255,255,255,0.4), inset 0 0 40px rgba(224,214,255,0.5), inset 16px 16px 50px rgba(255,255,255,0.18)",
          }}
        />
      </motion.div>
    </div>
  );
}

/* z-15: three soft cloud layers rolling left to right across the moon and the lettering. */
function CloudLayer({ dark }: { dark: boolean }) {
  const tile = (rgb: string, a: number) =>
    [
      `radial-gradient(ellipse 14% 34% at 10% 55%, rgba(${rgb},${a}) 0%, transparent 100%)`,
      `radial-gradient(ellipse 20% 42% at 28% 45%, rgba(${rgb},${a}) 0%, transparent 100%)`,
      `radial-gradient(ellipse 12% 30% at 46% 62%, rgba(${rgb},${a}) 0%, transparent 100%)`,
      `radial-gradient(ellipse 22% 46% at 66% 42%, rgba(${rgb},${a}) 0%, transparent 100%)`,
      `radial-gradient(ellipse 16% 34% at 88% 56%, rgba(${rgb},${a}) 0%, transparent 100%)`,
    ].join(",");
  const cool = dark ? "196,181,253" : "139,92,246";
  const icy = dark ? "147,197,253" : "99,102,241";
  const clouds = [
    { top: "6vh", height: "28vh", opacity: 0.35, anim: "animate-[cloudDrift_140s_linear_infinite]", image: tile(cool, 0.9) },
    { top: "24vh", height: "28vh", opacity: 0.4, anim: "animate-[cloudDrift_100s_linear_infinite]", image: tile(icy, 0.9) },
    { top: "42vh", height: "26vh", opacity: 0.45, anim: "animate-[cloudDrift_70s_linear_infinite]", image: tile(cool, 0.9) },
  ];
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[15] h-screen overflow-hidden">
      {clouds.map((c) => (
        <div
          key={c.top}
          className={`absolute left-0 w-[200%] will-change-transform ${c.anim}`}
          style={{
            top: c.top,
            height: c.height,
            opacity: c.opacity,
            backgroundImage: c.image,
            backgroundSize: "50% 100%",
            backgroundRepeat: "repeat-x",
          }}
        />
      ))}
    </div>
  );
}

/* z-20: one image spanning the whole 200vh page. Its graveyard horizon (tombstones, crosses,
   violet ground fog) lands at about 56-100vh, framing the bottom of the moon in section 1; the
   soil, coffins and skeleton crypt below it fill section 2. The sky of the art is transparent so
   the moon and clouds show through, and the top edge fades in with a mask. */
const CRYPT_FADE = "linear-gradient(to bottom, transparent 0%, black 18%, black 100%)";

function GraveyardLayer({ dark }: { dark: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 overflow-hidden"
      style={{ WebkitMaskImage: CRYPT_FADE, maskImage: CRYPT_FADE, opacity: dark ? 1 : 0.85 }}
    >
      <Img
        src={ASSETS.crypt}
        alt=""
        className="absolute left-1/2 top-0 h-full w-auto max-w-none -translate-x-1/2 select-none"
      />
      {/* Light Mode: a subtle violet tint over the opaque soil (no white wash) */}
      {!dark && <div className="absolute inset-x-0 bottom-0 top-[100vh] bg-purple-950/20" />}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Healing pulse: a brief ice-cyan / emerald restorative flash on a card   */
/* ------------------------------------------------------------------ */
function HealPulse() {
  return (
    <motion.div
      aria-hidden
      className="pointer-events-none absolute inset-0 rounded-2xl"
      style={{
        background:
          "radial-gradient(circle at 50% 45%, rgba(110,231,183,0.6) 0%, rgba(34,211,238,0.38) 45%, transparent 78%)",
      }}
      initial={{ opacity: 0.95 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 0.95, ease: "easeOut" }}
    />
  );
}

/* ------------------------------------------------------------------ */
/* Agent log pill: compact frosted terminal bar, bottom-centre.        */
/* Collapsed it shows only the latest event; click to see the history. */
/* ------------------------------------------------------------------ */
function AgentLogPill({ lines, mode, dark }: { lines: LogLine[]; mode: RunMode; dark: boolean }) {
  const [open, setOpen] = useState(false);
  const latest = lines[lines.length - 1];

  const tagColor = (tag: string) =>
    tag === "POLTERGEIST"
      ? dark
        ? "text-fuchsia-300"
        : "text-fuchsia-700"
      : tag === "EXORCIST"
        ? dark
          ? "text-emerald-300"
          : "text-emerald-700"
        : dark
          ? "text-purple-200/70"
          : "text-[#3B2A63]";

  const renderLine = (l: LogLine) => {
    const m = /^\[([A-Z]+)\]\s*(.*)$/.exec(l.text);
    return (
      <div key={l.id} className="truncate font-mono text-xs leading-5">
        {m ? (
          <>
            <span className={`font-bold ${tagColor(m[1])}`}>[{m[1]}]</span> {m[2]}
          </>
        ) : (
          l.text
        )}
      </div>
    );
  };

  const placeholder = (
    <div className="truncate font-mono text-xs leading-5 opacity-60">
      [SYSTEM] Agents idle. Summon the Poltergeist to begin.
    </div>
  );

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[44] flex justify-center px-4">
      <div
        className={`pointer-events-auto w-full max-w-xl overflow-hidden rounded-2xl border backdrop-blur-md ${
          dark
            ? "border-purple-400/25 bg-[#120B24]/60 text-purple-50 shadow-[0_8px_32px_rgba(56,189,248,0.12)]"
            : "border-purple-500/40 bg-white/65 text-[#1A0B2E] shadow-[0_8px_32px_rgba(109,40,217,0.18)]"
        }`}
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? "Collapse agent log" : "Expand agent log"}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          <Terminal className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="min-w-0 flex-1" aria-live="polite">
            {open ? (
              <span className="text-[10px] uppercase tracking-[0.25em] opacity-70">Agent log</span>
            ) : latest ? (
              <motion.span
                key={latest.id}
                className="block"
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25 }}
              >
                {renderLine(latest)}
              </motion.span>
            ) : (
              placeholder
            )}
          </span>
          <span
            className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wider ${
              mode === "backend"
                ? dark
                  ? "border-emerald-400/40 text-emerald-300"
                  : "border-emerald-600/50 text-emerald-700"
                : dark
                  ? "border-purple-300/30 text-purple-200/70"
                  : "border-purple-600/40 text-[#3B2A63]"
            }`}
          >
            {mode === "backend" ? "Live" : "Local sim"}
          </span>
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronUp className="h-4 w-4 shrink-0" />}
        </button>

        <AnimatePresence initial={false}>
          {open && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.2 }}
              className="overflow-hidden"
            >
              <div className="space-y-0.5 px-3 pb-2.5" role="log">
                {lines.length === 0 ? placeholder : lines.slice(-6).map(renderLine)}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Target card                                                         */
/* ------------------------------------------------------------------ */
function TargetCard({
  data,
  dark,
  damaged,
  healing,
  slash,
  cardRef,
  mirror,
}: {
  data: CardData;
  dark: boolean;
  damaged: boolean;
  healing: boolean;
  slash: boolean;
  cardRef: (el: HTMLDivElement | null) => void;
  mirror: boolean;
}) {
  const Icon = data.icon;
  const ink = dark ? "text-purple-50" : "text-[#1A0B2E]";
  const muted = dark ? "text-purple-200/60" : "text-[#3B2A63]";
  // Breached text: bright lilac on dark, deep violet / fuchsia on light.
  const hotTitle = dark ? "text-purple-200" : "text-purple-900";
  const hotAccent = dark ? "text-cyan-200" : "text-fuchsia-700";

  const base = dark
    ? "bg-[#120B24]/45 border-purple-400/25 shadow-[0_8px_32px_rgba(56,189,248,0.12)]"
    : "bg-white/65 border-purple-500/40 shadow-[0_8px_32px_rgba(109,40,217,0.18)]";
  const hit = dark
    ? "bg-[#120B24]/60 border-purple-400/90 shadow-[0_0_30px_rgba(168,85,247,0.5)]"
    : "bg-white/65 border-purple-400/90 shadow-[0_0_30px_rgba(168,85,247,0.5)]";

  // Healing: the card is already restored (nominal metrics, cracks gone) and flashes ice-cyan / emerald.
  const heal = dark
    ? "bg-[#120B24]/60 border-emerald-300/80 shadow-[0_0_30px_rgba(52,211,153,0.45)]"
    : "bg-white/65 border-emerald-500/80 shadow-[0_0_30px_rgba(16,185,129,0.4)]";

  const stat = damaged ? data.faultStat : data.stat;
  const detail = damaged ? data.faultDetail : data.detail;
  const metrics = damaged ? data.faultMetrics : data.metrics;

  return (
    <motion.div
      ref={cardRef}
      animate={
        damaged
          ? { x: [0, -1.5, 1.5, -1, 1, 0], y: [0, 1, -1, 1.5, -1, 0] }
          : { x: 0, y: 0 }
      }
      transition={
        damaged
          ? { duration: 0.28, repeat: Infinity }
          : { type: "spring", stiffness: 200, damping: 20 }
      }
      className={`relative w-[min(18rem,calc(100vw-3rem))] overflow-hidden will-change-transform rounded-2xl border p-5 transition-[background-color,border-color,box-shadow] duration-500 ${
        dark ? "backdrop-blur-md" : "backdrop-blur-xl"
      } ${damaged ? hit : healing ? heal : base}`}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 rounded-2xl bg-gradient-to-br from-white/15 via-transparent to-transparent shadow-[inset_0_1px_0_rgba(255,255,255,0.25)]"
      />

      <div className="relative">
        <div className="flex items-center justify-between">
          <span className={`text-xs tracking-[0.3em] ${muted}`}>{data.code}</span>
          <Icon className={`h-4 w-4 ${damaged ? hotAccent : dark ? "text-sky-300/80" : "text-purple-700"}`} />
        </div>

        <h3 className="mb-3 mt-1 font-[family-name:var(--font-cinzel)] text-xl font-bold tracking-wide">
          <Glitch active={damaged} dark={dark} className={damaged ? hotTitle : ink}>
            {data.name}
          </Glitch>
        </h3>

        {/* Status badge: its own block row in normal flow (never absolutely positioned), so it
            cannot overlap the stat or metric rows below, even when the text wraps. */}
        <div className="mb-3 block">
          {damaged ? (
            <div className="flex items-start gap-2 text-xs">
              <motion.span
                className="mt-1 h-2 w-2 shrink-0 rounded-full bg-fuchsia-400 shadow-[0_0_10px_#C084FC]"
                animate={{ opacity: [1, 0.2, 1] }}
                transition={{ duration: 0.5, repeat: Infinity }}
              />
              <Glitch
                active
                dark={dark}
                className={`min-w-0 break-words font-mono font-bold leading-snug tracking-wider ${
                  dark ? "text-purple-200" : "text-fuchsia-700"
                }`}
              >
                BREACHED // ARC_FAULT
              </Glitch>
            </div>
          ) : healing ? (
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_10px_rgba(52,211,153,0.9)]" />
              <span className={`font-mono font-bold tracking-wider ${dark ? "text-emerald-300" : "text-emerald-700"}`}>
                PATCHED // VERIFIED
              </span>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-xs">
              <span className="h-2 w-2 shrink-0 rounded-full bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.8)]" />
              <span className={muted}>NOMINAL</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 leading-tight">
          <Glitch
            active={damaged}
            dark={dark}
            className={damaged ? `font-mono text-2xl font-bold ${hotTitle}` : `text-3xl font-light ${ink}`}
          >
            {stat}
          </Glitch>
          <span className={`text-xs ${damaged ? `font-mono font-bold ${hotAccent}` : muted}`}>{detail}</span>
        </div>

        <dl className="mt-4 space-y-1.5 text-sm">
          {metrics.map(([label, value]) => (
            <div
              key={label}
              className={`flex justify-between border-b pb-1 ${
                dark ? "border-purple-400/10" : "border-purple-500/15"
              }`}
            >
              <dt className={muted}>{label}</dt>
              <dd className={damaged ? `font-mono font-bold ${hotTitle}` : ink}>{value}</dd>
            </div>
          ))}
        </dl>
      </div>

      <AnimatePresence>{damaged && <CrackOverlay key="cracks" mirror={mirror} />}</AnimatePresence>
      <AnimatePresence>{slash && <SlashFlash key="slash" />}</AnimatePresence>
      <AnimatePresence>{healing && <HealPulse key="heal" />}</AnimatePresence>
    </motion.div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */
export default function Home() {
  const [isDarkMode, setIsDarkMode] = useState(true);
  const [healingCards, setHealingCards] = useState<number[]>([]);
  const [isHealing, setIsHealing] = useState(false);
  const [pending, setPending] = useState(false); // waiting on the backend call or running the attack
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [mode, setMode] = useState<RunMode>("local");
  const logId = useRef(0);
  const pushLog = (text: string) => {
    const id = ++logId.current;
    setLogs((l) => [...l.slice(-11), { id, text }]);
  };
  const [attackPhase, setAttackPhase] = useState<AttackPhase>("idle");
  const [damagedCards, setDamagedCards] = useState<number[]>([]);
  const [reaper, setReaper] = useState<ReaperState | null>(null);
  const [charging, setCharging] = useState(false);
  const [beam, setBeam] = useState<Beam | null>(null);
  const [slashId, setSlashId] = useState<number | null>(null);

  const runRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const summonRef = useRef<HTMLButtonElement>(null);
  const skullRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);

  /* --- cursor parallax --- */
  const mx = useMotionValue(0);
  const my = useMotionValue(0);
  const smx = useSpring(mx, { stiffness: 60, damping: 20, mass: 0.6 });
  const smy = useSpring(my, { stiffness: 60, damping: 20, mass: 0.6 });
  const moonShift = useTransform(smx, (v) => v * -24);
  const wordX = useTransform(smx, (v) => v * 32);
  const wordY = useTransform(smy, (v) => v * 16);

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      mx.set(e.clientX / window.innerWidth - 0.5);
      my.set(e.clientY / window.innerHeight - 0.5);
    };
    window.addEventListener("mousemove", onMove);
    return () => window.removeEventListener("mousemove", onMove);
  }, [mx, my]);

  /* --- scroll-driven skull --- */
  const { scrollYProgress } = useScroll();
  // Skull fire: /skull.png is the unlit base and /skull-lit.png is stacked on it at opacity 0.
  // The lit layer ignites only while the skull is hovered, or as the skull settles into the
  // hand (scroll progress 0.35 -> 0.85). While it is visible, a flicker animation runs on it.
  const [isSkullHovered, setIsSkullHovered] = useState(false);
  const [fireOn, setFireOn] = useState(false);
  const hover = useMotionValue(0);
  const hoverSpring = useSpring(hover, { stiffness: 140, damping: 22 });
  useEffect(() => {
    hover.set(isSkullHovered ? 1 : 0);
  }, [isSkullHovered, hover]);
  const scrollLit = useTransform(scrollYProgress, [0.35, 0.85], [0, 1]);
  const lit = useTransform([hoverSpring, scrollLit], ([h, sc]: number[]) => Math.max(h, sc));
  useMotionValueEvent(lit, "change", (v) => setFireOn(v > 0.01));
  // Skull, lit skull and hand share one wrapper, so they also share this slow zoom.
  const groupScale = useTransform(scrollYProgress, [0, 1], [1, 1.06]);
  // The skull starts resting on the ground (restY below centre) and levitates to the centre.
  const restY = useMotionValue(0);
  const skullY = useTransform([scrollYProgress, restY], ([p, r]: number[]) => {
    const t = Math.min(1, Math.max(0, p / 0.7));
    return r * (1 - t * t * (3 - 2 * t));
  });
  // The hand starts below the bottom edge of the screen and rises to y = 0 to catch the skull.
  const handStart = useMotionValue(420);
  const handY = useTransform([scrollYProgress, handStart], ([p, h]: number[]) => {
    const t = Math.min(1, Math.max(0, (p - 0.4) / 0.45));
    return h * (1 - t * t * (3 - 2 * t));
  });

  // Floating. One 4 s oscillator drives both floats so the hand-over is seamless:
  //  - scroll 0 -> 0.4: the skull bobs on its own (hand is off-screen below)
  //  - scroll 0.4 -> 0.6: the independent bob fades out as the hand takes hold
  //  - scroll 0.6 -> 1: skull and hand float together as one object (shared wrapper, y: 0 -> -8 -> 0)
  const phase = useMotionValue(0);
  useEffect(() => {
    const controls = animate(phase, 1, { duration: 4, ease: "linear", repeat: Infinity, repeatType: "loop" });
    return () => controls.stop();
  }, [phase]);
  const caught = useTransform(scrollYProgress, [0.4, 0.6], [0, 1]);
  const wave = (ph: number) => 0.5 * (1 - Math.cos(ph * Math.PI * 2)); // 0 -> 1 -> 0 each cycle
  const skullBob = useTransform([phase, caught], ([ph, c]: number[]) => -14 * wave(ph) * (1 - c));
  const sharedFloat = useTransform([phase, caught], ([ph, c]: number[]) => -8 * wave(ph) * c);
  const skullYTotal = useTransform([skullY, skullBob], ([a, b]: number[]) => a + b);
  // Soft dark contact shadow between the chin and the palm, present once the hand has caught the skull.
  const contactShadow = useTransform(scrollYProgress, [0.55, 0.85], [0, 0.75]);

  useEffect(() => {
    const place = () => {
      const size = skullRef.current?.offsetHeight ?? 400;
      // The skull image is square; its chin sits 0.42 * size below centre. Rest it on the horizon (~92vh).
      restY.set(0.42 * (window.innerHeight - size));
      // Park the hand fully below the viewport: its highest fingertip sits ~0.18 * size above the skull centre (more with the zoom).
      handStart.set(Math.max(420, window.innerHeight / 2 + 0.25 * size + 24));
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [restY, handStart]);
  const section2Opacity = useTransform(scrollYProgress, [0.2, 0.6], [0, 1]);

  /* --- SPECTEROPS wordmark: zooms, drifts up and fades as you scroll --- */
  const wordScale = useTransform(scrollYProgress, [0, 0.55], [1, 1.35]);
  const wordRise = useTransform(scrollYProgress, [0, 0.55], [0, -120]);
  const wordOpacity = useTransform(scrollYProgress, [0, 0.55], [0.45, 0]);
  // Shrinks the word if the loaded font is wide enough to clip at the viewport edges.
  const wordFit = useMotionValue(1);
  const wordRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const measure = () => {
      const el = wordRef.current;
      if (!el || el.offsetWidth === 0) return;
      const available = document.documentElement.clientWidth * 0.92 - 32;
      wordFit.set(Math.min(1, available / el.offsetWidth));
    };
    measure();
    window.addEventListener("resize", measure);
    document.fonts?.ready.then(measure);
    return () => window.removeEventListener("resize", measure);
  }, [wordFit]);

  useEffect(() => {
    return () => {
      runRef.current += 1; // cancel any in-flight attack on unmount
    };
  }, []);

  const complete = attackPhase === "complete";
  const busy = pending || isHealing || (reaper !== null && !complete);

  /* --- attack sequence (positions are in page coordinates) --- */
  const playAttack = async () => {
    const btn = summonRef.current;
    const cont = containerRef.current;
    if (!btn || !cont) return;
    const id = ++runRef.current;
    const alive = () => runRef.current === id;

    const toPage = (el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      const c = cont.getBoundingClientRect();
      return {
        left: r.left - c.left,
        right: r.right - c.left,
        top: r.top - c.top,
        width: r.width,
        height: r.height,
      };
    };

    setDamagedCards([]);
    setHealingCards([]);
    setCharging(false);
    setBeam(null);
    setSlashId(null);
    setAttackPhase("idle");

    // Card 1 lives in the hero, so return to the top before spawning the reaper.
    if (window.scrollY > 50) {
      window.scrollTo({ top: 0, behavior: "smooth" });
      await sleep(600);
      if (!alive()) return;
    }

    const b = toPage(btn);
    const start: Point = { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    setReaper({ key: id, start, target: start, flip: false });
    await sleep(700); // spawn: scale 0 -> 1

    for (let i = 0; i < cards.length; i++) {
      if (!alive()) return;
      const el = cardRefs.current[i];
      if (!el) return;
      const r = toPage(el);
      // Card 2 sits on the left, so the reaper stands to its right and faces left.
      const flip = i === 1;
      const target: Point = {
        x: flip ? r.right + 80 : r.left - 80,
        y: r.top + r.height * 0.45,
      };

      setAttackPhase(CARD_PHASES[i]);
      pushLog(ATTACK_LOGS[i]);
      setReaper((prev) => (prev ? { ...prev, target, flip } : prev));
      await sleep(1300); // glide

      if (!alive()) return;
      // Charge flash at the scythe tip, then fire a plasma ray into the card centre.
      setCharging(true);
      await sleep(250);
      if (!alive()) return;
      setCharging(false);
      const from: Point = {
        x: target.x + (flip ? -REAPER_TIP.x : REAPER_TIP.x),
        y: target.y + REAPER_TIP.y,
      };
      const to: Point = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      setBeam({ key: id * 10 + i, from, to });
      await sleep(250); // beam strike
      if (!alive()) return;
      setSlashId(cards[i].id);
      setDamagedCards((d) => (d.includes(cards[i].id) ? d : [...d, cards[i].id]));
      await sleep(450);
      if (!alive()) return;
      setBeam(null);
      setSlashId(null);

      if (i === 0) {
        // Hold at the top for 1000ms in total so Card 1 visibly shatters, then follow to section 2.
        await sleep(550);
        if (!alive()) return;
        window.scrollTo({ top: window.innerHeight, behavior: "smooth" });
        await sleep(650);
      } else if (i === 1) {
        await sleep(300); // 750ms after the Card 2 hit, then on to Card 3
      }
    }

    if (!alive()) return;
    const skullEl = skullRef.current;
    if (skullEl) {
      const s = toPage(skullEl);
      const target: Point = { x: s.left - 100, y: s.top + s.height / 2 };
      setReaper((prev) => (prev ? { ...prev, target, flip: false } : prev));
    }
    await sleep(1000);
    if (!alive()) return;
    setAttackPhase("complete");
  };

  // Summon: ask the backend first (3 s timeout). If it is not configured or fails, silently run the
  // local frontend simulation so the demo never breaks.
  const runAttack = async () => {
    setPending(true);
    const res = await triggerPoltergeist();
    setMode(res.ok ? "backend" : "local");
    await playAttack();
    setPending(false);
  };

  // Banish & Heal: the Exorcist sweeps Card 1 -> Card 2 -> Card 3, 500 ms apart.
  const banish = async () => {
    const id = ++runRef.current;
    const alive = () => runRef.current === id;
    setIsHealing(true);
    setCharging(false);
    setBeam(null);
    setSlashId(null);
    setReaper(null); // the poltergeist fades away

    const res = await triggerExorcist();
    if (!alive()) return;
    setMode(res.ok ? "backend" : "local");

    pushLog("[EXORCIST] Anomaly detected → Isolating fault...");
    await sleep(600);

    for (let i = 0; i < cards.length; i++) {
      if (!alive()) return;
      const c = cards[i];
      pushLog(`[EXORCIST] Rolling back state on ${c.name}...`);
      // Cracks and fault text clear, nominal metrics return, and the card flashes PATCHED // VERIFIED.
      setDamagedCards((d) => d.filter((x) => x !== c.id));
      setHealingCards((h) => (h.includes(c.id) ? h : [...h, c.id]));
      window.setTimeout(() => setHealingCards((h) => h.filter((x) => x !== c.id)), 1200);
      if (i < cards.length - 1) await sleep(500);
    }

    await sleep(1200);
    if (!alive()) return;
    pushLog("[EXORCIST] All nodes verified nominal.");
    setAttackPhase("idle");
    setIsHealing(false);
  };

  const dark = isDarkMode;
  const glass = dark
    ? "border-purple-400/25 bg-[#120B24]/45 shadow-[0_8px_32px_rgba(56,189,248,0.12)]"
    : "border-purple-400/35 bg-purple-500/10 shadow-[0_8px_32px_rgba(147,51,234,0.12)]";
  const display = "font-[family-name:var(--font-cinzel)]";
  const onArtGradient = "from-purple-300 to-sky-300";

  return (
    <div
      className={`relative w-full overflow-x-clip font-[family-name:var(--font-sans)] font-light tracking-wide transition-colors duration-700 ${
        dark ? "bg-[#050714] text-purple-50" : "bg-[#D8C8F2] text-[#1A0B2E]"
      }`}
    >
      <style>{`
        @keyframes cloudDrift {
          from { transform: translate3d(-50%, 0, 0); }
          to { transform: translate3d(0, 0, 0); }
        }
      `}</style>

      {/* Fixed backdrop: plain radial gradients (no blur filters), cross-faded per mode */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div
          className="absolute inset-0 transition-opacity duration-700"
          style={{
            opacity: dark ? 1 : 0,
            background:
              "radial-gradient(circle at 12% 12%, rgba(126,34,206,0.38) 0%, transparent 38%), radial-gradient(circle at 92% 92%, rgba(14,165,233,0.26) 0%, transparent 36%), radial-gradient(ellipse at 50% 35%, #1B1040 0%, #050714 70%)",
          }}
        />
        <div
          className="absolute inset-0 bg-gradient-to-b from-[#EAE2F8] via-[#D8C8F2] to-[#C4B0E8] transition-opacity duration-700"
          style={{
            opacity: dark ? 0 : 1,
          }}
        />
      </div>

      {/* Fixed floating pill navbar */}
      <motion.nav
        initial={{ y: -30, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.8, ease: "easeOut" }}
        className="fixed inset-x-0 top-4 z-[45] flex flex-wrap items-center justify-center gap-2 px-4"
      >
        <div className="hidden items-center gap-2 md:flex">
          {NAV_LINKS.map(([label, section]) => (
            <button
              key={label}
              type="button"
              onClick={() => window.scrollTo({ top: section * window.innerHeight, behavior: "smooth" })}
              className={`rounded-full border px-4 py-2 text-sm backdrop-blur-md transition-colors ${glass} ${
                dark ? "hover:bg-purple-500/25" : "hover:bg-purple-500/20"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => setIsDarkMode((v) => !v)}
          aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
          className={`flex h-10 w-10 items-center justify-center rounded-full border backdrop-blur-md transition-colors ${glass} ${
            dark ? "hover:bg-purple-500/25" : "hover:bg-purple-500/20"
          }`}
        >
          {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
        </button>

        <button
          ref={summonRef}
          type="button"
          disabled={busy}
          onClick={complete ? banish : runAttack}
          className="rounded-full bg-gradient-to-r from-purple-600 via-fuchsia-600 to-sky-500 px-5 py-2.5 text-sm tracking-wide text-white shadow-[0_0_24px_rgba(168,85,247,0.65)] transition-all duration-300 hover:scale-105 hover:shadow-[0_0_36px_rgba(56,189,248,0.7)] active:scale-95 disabled:cursor-wait disabled:opacity-70 disabled:hover:scale-100"
        >
          {isHealing ? "Healing…" : complete ? "Banish & Heal" : busy ? "Summoning…" : "Summon Poltergeist"}
        </button>
      </motion.nav>

      {/* Live agent log (bottom-centre) */}
      <AgentLogPill lines={logs} mode={mode} dark={dark} />

      {/* 200vh scroll stage */}
      <div ref={containerRef} className="relative h-[200vh]">
        {/* z-0: giant wordmark (sticky), strictly behind the moon */}
        <div className="pointer-events-none absolute inset-0 z-0">
          <div className="sticky top-0 h-screen overflow-hidden">
            <div className="absolute inset-x-0 top-[13vh] flex items-start justify-center">
              <motion.div style={{ scale: wordScale, y: wordRise, opacity: wordOpacity }} className="will-change-transform">
                <motion.span
                  ref={wordRef}
                  style={{ x: wordX, y: wordY, scale: wordFit }}
                  className={`inline-block select-none whitespace-nowrap bg-gradient-to-b bg-clip-text font-[family-name:var(--font-anton)] text-[17vw] font-normal uppercase leading-none tracking-[0.02em] text-transparent will-change-transform ${
                    dark ? "from-white to-purple-400" : "from-purple-700 to-sky-500"
                  }`}
                >
                  SPECTEROPS
                </motion.span>
              </motion.div>
            </div>
          </div>
        </div>

        {/* z-10 moon, z-15 clouds, z-20 graveyard + crypt */}
        <MoonLayer dark={dark} moonShift={moonShift} />
        <CloudLayer dark={dark} />
        <GraveyardLayer dark={dark} />
        {/* Dark Mode edge vignette: obsidian corners over the backdrop, moon and graveyard, but under the
            skull, cards and text, so the fire and the glass cards pop. */}
        <div
          aria-hidden
          className="pointer-events-none fixed inset-0 z-[25] transition-opacity duration-700"
          style={{
            opacity: dark ? 1 : 0,
            background: "radial-gradient(circle at 50% 45%, transparent 38%, rgba(4, 3, 10, 0.78) 100%)",
          }}
        />

        {/* z-30: sticky skull and rising hand */}
        <div className="pointer-events-none absolute inset-0 z-30">
          <div className="sticky top-0 h-screen overflow-hidden">
            <div className="absolute inset-0 flex items-center justify-center">
              <div ref={skullRef} className="relative aspect-square w-[min(62vw,400px)]">
                {/* One shared wrapper: hand, skull and lit skull live in the same coordinate space
                    (everything is a percentage of the skull box), so they share scale and float and
                    cannot drift apart at any screen size. */}
                <motion.div
                  className="absolute inset-0 will-change-transform"
                  style={{ y: sharedFloat, scale: groupScale }}
                >
                  {/* Hand: scaled to 0.72 so the fingers stop at the temples instead of towering over the
                      forehead. The palm cups the chin, the thumb hugs the lower left jaw and the fingers curl
                      up the right cheek. It rises from below the screen edge as you scroll into section 2;
                      the forearm fades out at its end for tall screens. */}
                  <div className="absolute -top-[4%] left-1/2 aspect-square w-[200%] -translate-x-1/2">
                    <motion.div className="relative h-full w-full will-change-transform" style={{ y: handY }}>
                      <Img
                        src={ASSETS.hand}
                        alt="Skeletal Hand"
                        className={`h-full w-full origin-[50%_46%] translate-x-[5.5%] scale-[0.72] select-none object-contain transition-[filter] duration-700 [-webkit-mask-image:linear-gradient(to_bottom,black_78%,transparent_100%)] [mask-image:linear-gradient(to_bottom,black_78%,transparent_100%)] ${
                          fireOn ? "drop-shadow-[0_0_22px_rgba(168,85,247,0.45)]" : ""
                        }`}
                      />
                      {/* Contact shadow: sits between the chin and the palm, so the skull has weight */}
                      <motion.div
                        aria-hidden
                        style={{
                          opacity: contactShadow,
                          background:
                            "radial-gradient(ellipse at center, rgba(4,2,12,1) 0%, rgba(4,2,12,0.6) 42%, transparent 72%)",
                        }}
                        className="pointer-events-none absolute left-1/2 top-[48.5%] h-[8%] w-[22%] -translate-x-1/2 -translate-y-1/2"
                      />
                    </motion.div>
                  </div>

                  {/* Skull: unlit base + lit overlay cross-fade (hover in section 1, scroll into section 2) */}
                  <motion.div
                    className="pointer-events-auto absolute inset-0 will-change-transform"
                    style={{ y: skullYTotal }}
                    onPointerEnter={() => setIsSkullHovered(true)}
                    onPointerLeave={() => setIsSkullHovered(false)}
                  >
                    <motion.div aria-hidden style={{ opacity: lit }} className="pointer-events-none absolute inset-0">
                      <motion.div
                        className="absolute left-1/2 top-[44%] h-[130%] w-[130%] -translate-x-1/2 -translate-y-1/2 will-change-transform"
                        style={{
                          background:
                            "radial-gradient(circle, rgba(168,85,247,0.4) 0%, rgba(56,189,248,0.16) 34%, transparent 62%)",
                        }}
                        animate={{ scale: [1, 1.08, 1], opacity: [0.7, 1, 0.7] }}
                        transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
                      />
                    </motion.div>

                    <div className="absolute inset-0">
                      <Img src={ASSETS.skull} alt="Cursed Skull" className="absolute inset-0 h-full w-full select-none object-contain" />
                      {/* Lit skull: same size and position as the base, opacity 0 until hovered or cradled */}
                      <motion.div
                        aria-hidden
                        style={{ opacity: lit }}
                        className="pointer-events-none absolute inset-0 will-change-[opacity]"
                      >
                        <motion.img
                          src={ASSETS.skullLit}
                          alt=""
                          aria-hidden
                          draggable={false}
                          decoding="async"
                          className="absolute inset-0 h-full w-full select-none object-contain"
                          animate={
                            fireOn
                              ? {
                                  opacity: [0.82, 1, 0.88, 1],
                                  scale: [1, 1.018, 0.995, 1.012, 1],
                                  filter: ["brightness(0.95)", "brightness(1.2)", "brightness(1.02)", "brightness(1.18)"],
                                }
                              : { opacity: 0.82, scale: 1, filter: "brightness(0.95)" }
                          }
                          transition={
                            fireOn
                              ? { duration: 1.8, repeat: Infinity, repeatType: "mirror", ease: "easeInOut" }
                              : { duration: 0.2 }
                          }
                        />
                      </motion.div>
                    </div>
                  </motion.div>
                </motion.div>
              </div>
            </div>
          </div>
        </div>

        {/* Section 1 (top 100vh) */}
        <section className="pointer-events-none absolute inset-x-0 top-0 z-40 h-screen">
          <div className="absolute bottom-[8vh] left-6 md:left-12">
            <h1
              className={`${display} text-[clamp(1.5rem,3.6vw,3.75rem)] font-extrabold uppercase leading-[0.95] tracking-tight text-white`}
            >
              <span className="[text-shadow:0_2px_14px_rgba(12,4,28,0.55)]">Autonomous</span>
              <br />
              <span
                className={`bg-gradient-to-r bg-clip-text text-transparent ${
                  onArtGradient
                }`}
              >
                Chaos Defense
              </span>
            </h1>
            <div className="mt-4 flex max-w-sm items-start gap-3">
              <BatIcon className="mt-0.5 h-6 w-10 shrink-0 text-purple-300/80" />
              <p className="text-sm leading-relaxed text-purple-100/90 [text-shadow:0_1px_10px_rgba(12,4,28,0.6)]">
                Failures are injected, diagnosed and repaired by agents.
                <br />
                Recovery is reported only after it is verified.
              </p>
            </div>

            <button
              type="button"
              onClick={() => window.scrollTo({ top: window.innerHeight, behavior: "smooth" })}
              className={`pointer-events-auto mt-5 inline-flex items-center gap-2 rounded-full border px-5 py-2.5 text-sm tracking-wide backdrop-blur-md transition-all duration-300 hover:scale-105 active:scale-95 border-purple-400/50 bg-purple-500/20 text-purple-50 shadow-[0_0_24px_rgba(168,85,247,0.45)] hover:shadow-[0_0_34px_rgba(56,189,248,0.55)]`}
            >
              Enter Defense Mesh
              <ArrowDown className="h-4 w-4" />
            </button>
          </div>

          <motion.div
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, delay: 0.3 }}
            className="absolute bottom-[8vh] right-6 md:right-12"
          >
            <TargetCard
              data={cards[0]}
              dark={dark}
              damaged={damagedCards.includes(1)}
              slash={slashId === 1}
              healing={healingCards.includes(1)}
              cardRef={(el) => {
                cardRefs.current[0] = el;
              }}
              mirror={false}
            />
          </motion.div>
        </section>

        {/* Section 2 (bottom 100vh), revealed on scroll. Content sits in a padded, max-width column so
            nothing touches the browser edges, and the middle stays open for the skull-in-hand. */}
        <section className="pointer-events-none absolute inset-x-0 top-[100vh] z-40 h-screen">
          <div className="mx-auto flex h-full w-full max-w-[1440px] flex-col justify-between px-8 pb-8 pt-24 md:px-14 md:pb-12">
            <div className="flex flex-wrap items-start justify-between gap-6">
              <motion.div style={{ opacity: section2Opacity }}>
                <TargetCard
                  data={cards[1]}
                  dark={dark}
                  damaged={damagedCards.includes(2)}
                  slash={slashId === 2}
                  healing={healingCards.includes(2)}
                  cardRef={(el) => {
                    cardRefs.current[1] = el;
                  }}
                  mirror
                />
              </motion.div>

              <motion.div style={{ opacity: section2Opacity }}>
                <TargetCard
                  data={cards[2]}
                  dark={dark}
                  damaged={damagedCards.includes(3)}
                  slash={slashId === 3}
                  healing={healingCards.includes(3)}
                  cardRef={(el) => {
                    cardRefs.current[2] = el;
                  }}
                  mirror={false}
                />
              </motion.div>
            </div>

            <div className="flex items-end justify-between gap-6">
              <motion.h2
                style={{ opacity: section2Opacity }}
                className={`${display} text-[clamp(1.5rem,4.4vw,4.5rem)] font-extrabold uppercase leading-[0.95] tracking-tight text-white [text-shadow:0_2px_16px_rgba(12,4,28,0.6)]`}
              >
                Zero
                <br />
                Downtime
              </motion.h2>
              <motion.h2
                style={{ opacity: section2Opacity }}
                className={`${display} bg-gradient-to-r bg-clip-text text-right text-[clamp(1.5rem,4.4vw,4.5rem)] font-extrabold uppercase leading-[0.95] tracking-tight text-transparent ${onArtGradient}`}
              >
                Self
                <br />
                Healing
              </motion.h2>
            </div>
          </div>
        </section>

        {/* Reaper layer (page coordinates, scrolls with content) */}
        <div className="pointer-events-none absolute inset-0 z-50">
          <AnimatePresence>
            {beam && <PlasmaBeam key={beam.key} from={beam.from} to={beam.to} seed={beam.key} />}
          </AnimatePresence>
          <AnimatePresence>
            {reaper && (
              <motion.div
                key={reaper.key}
                className="absolute left-0 top-0 -ml-[112px] -mt-[150px]"
                initial={{ x: reaper.start.x, y: reaper.start.y, scale: 0, opacity: 0 }}
                animate={{ x: reaper.target.x, y: reaper.target.y, scale: 1, opacity: 1 }}
                exit={{ opacity: 0, scale: 0.5, transition: { duration: 0.6 } }}
                transition={{
                  x: { type: "spring", stiffness: 60, damping: 16 },
                  y: { type: "spring", stiffness: 60, damping: 16 },
                  scale: { type: "spring", stiffness: 120, damping: 14 },
                  opacity: { duration: 0.4 },
                }}
              >
                {/* calm spectral float only */}
                <motion.div
                  animate={{ y: [0, -6, 0] }}
                  transition={{ duration: 2.6, repeat: Infinity, ease: "easeInOut" }}
                >
                  <div
                    style={{
                      transform: reaper.flip ? "scaleX(-1)" : "scaleX(1)",
                      transition: "transform 0.5s",
                    }}
                  >
                    <Reaper charging={charging} firing={beam !== null} />
                  </div>
                </motion.div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </div>
  );
}
