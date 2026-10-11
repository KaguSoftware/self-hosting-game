import { LIGHT, ROOF, ROOF_WIDTH, UNIT_BOTTOM, UNIT_TOP, VIEW, type Light } from "./mark";

const LIGHT_FILL: Record<Light, string> = { ok: "var(--color-teal)", down: "var(--color-red)", off: "var(--color-line2)" };

/** The mark: a home made of a server. Draws in currentColor; only the status light has color. */
export function Mark({ size = 24, light = "ok", blink = false, className = "", title }: { size?: number; light?: Light; blink?: boolean; className?: string; title?: string }) {
  return (
    <svg
      viewBox={`0 0 ${VIEW} ${VIEW}`}
      width={size}
      height={size}
      className={`mark shrink-0 ${className}`}
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <path className="mark-roof" d={ROOF} fill="none" stroke="currentColor" strokeWidth={ROOF_WIDTH} strokeLinejoin="miter" />
      <path className="mark-unit mark-unit-top" d={UNIT_TOP} fill="currentColor" fillRule="evenodd" />
      <path className="mark-unit mark-unit-bottom" d={UNIT_BOTTOM} fill="currentColor" fillRule="evenodd" />
      <circle className={`mark-light ${blink ? `mark-light-${light}` : ""}`} cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r} fill={LIGHT_FILL[light]} />
    </svg>
  );
}

/** The name, as it is typed at a prompt: lowercase, with a cursor. */
export function Wordmark({ className = "", cursor = true }: { className?: string; cursor?: boolean }) {
  return (
    <span className={`font-display whitespace-nowrap ${className}`}>
      self-hosting
      {cursor && <span className="caret text-faint">_</span>}
    </span>
  );
}

/** Mark and name side by side. Sizes scale from the mark. */
export function Logo({ size = 22, light = "ok", blink = false, className = "" }: { size?: number; light?: Light; blink?: boolean; className?: string }) {
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: size * 0.3 }}>
      <Mark size={size} light={light} blink={blink} />
      <Wordmark className="leading-none" />
    </span>
  );
}
