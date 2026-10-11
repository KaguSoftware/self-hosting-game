import type { Metadata } from "next";
import TopBar from "@/components/TopBar";
import { Logo, Mark, Wordmark } from "@/components/brand/Logo";
import { BRAND, LIGHT, ROOF, ROOF_WIDTH, UNIT_BOTTOM, UNIT_TOP, VIEW } from "@/components/brand/mark";

export const metadata: Metadata = { title: "Brand", description: "The Self-Hosting mark, colors, type and voice, with files to download." };

const COLORS = [
  { hex: BRAND.bg, name: "Background", use: "Every page sits on this." },
  { hex: BRAND.panel, name: "Panel", use: "Cards, the terminal, dialogs." },
  { hex: BRAND.line, name: "Line", use: "Borders and dividers." },
  { hex: BRAND.ink, name: "Text", use: "Words and the mark." },
  { hex: BRAND.muted, name: "Quiet text", use: "Hints and labels." },
  { hex: BRAND.green, name: "Green", use: "Right, or healthy. Nothing else." },
  { hex: BRAND.red, name: "Red", use: "Wrong, or down. Nothing else." },
];

const FILES = [
  { href: "/brand/mark.svg", label: "Mark, light", kind: "SVG" },
  { href: "/brand/mark-dark-ink.svg", label: "Mark, dark", kind: "SVG" },
  { href: "/brand/mark-down.svg", label: "Mark, red light", kind: "SVG" },
  { href: "/brand/app-icon.svg", label: "App icon", kind: "SVG" },
  { href: "/brand/app-icon-1024.png", label: "App icon, 1024", kind: "PNG" },
  { href: "/brand/lockup-light-on-dark.png", label: "Logo on black", kind: "PNG" },
  { href: "/brand/lockup-dark-on-light.png", label: "Logo on white", kind: "PNG" },
  { href: "/brand/lockup-transparent.png", label: "Logo, see-through", kind: "PNG" },
  { href: "/opengraph-image", label: "Link preview", kind: "PNG" },
];

function Section({ n, title, children }: { n: string; title: string; children: React.ReactNode }) {
  return (
    <section className="mt-16">
      <div className="flex items-baseline gap-3 border-b border-line pb-2">
        <span className="font-mono text-[12px] text-faint">{n}</span>
        <h2 className="font-display text-[22px] text-ink">{title}</h2>
      </div>
      <div className="mt-5">{children}</div>
    </section>
  );
}

/** The mark drawn large over its 64 by 64 grid, with the three parts numbered. */
function Construction() {
  const grid = Array.from({ length: VIEW / 4 + 1 }, (_, i) => i * 4);
  const tag = (x: number, y: number, n: number) => (
    <g>
      <circle cx={x} cy={y} r={2.6} fill="var(--color-bg)" stroke="var(--color-muted)" strokeWidth={0.35} />
      <text x={x} y={y + 1.05} textAnchor="middle" fontSize={3} fill="var(--color-ink)" fontFamily="var(--font-mono)">
        {n}
      </text>
    </g>
  );
  return (
    <svg viewBox={`-2 -2 ${VIEW + 4} ${VIEW + 4}`} className="w-full max-w-[360px]" aria-label="How the mark is built">
      {grid.map((g) => (
        <g key={g} stroke="var(--color-line)" strokeWidth={g % 16 === 0 ? 0.25 : 0.12}>
          <line x1={g} y1={0} x2={g} y2={VIEW} />
          <line x1={0} y1={g} x2={VIEW} y2={g} />
        </g>
      ))}
      <g stroke="var(--color-faint)" strokeWidth={0.2} strokeDasharray="1 1">
        <line x1={16} y1={0} x2={16} y2={VIEW} />
        <line x1={48} y1={0} x2={48} y2={VIEW} />
        <line x1={0} y1={30} x2={VIEW} y2={30} />
      </g>
      <g className="text-ink">
        <path d={ROOF} fill="none" stroke="currentColor" strokeWidth={ROOF_WIDTH} />
        <path d={UNIT_TOP} fill="currentColor" fillRule="evenodd" />
        <path d={UNIT_BOTTOM} fill="currentColor" fillRule="evenodd" />
        <circle cx={LIGHT.cx} cy={LIGHT.cy} r={LIGHT.r} fill="var(--color-teal)" />
      </g>
      {tag(32, 4, 1)}
      {tag(8, 45, 2)}
      {tag(56, 38.5, 3)}
    </svg>
  );
}

export default function BrandPage() {
  return (
    <>
      <TopBar />
      <main className="mx-auto max-w-3xl px-4 pb-24">
        <header className="pt-14">
          <div className="text-[34px] text-ink sm:text-[44px]">
            <Logo size={56} blink />
          </div>
          <p className="mt-6 max-w-xl text-[17px] leading-relaxed text-ink/85">
            The mark is a home made of a server. Self-hosting means you run the server yourself, so the roof and the machine are the same thing.
          </p>
          <p className="mt-2 max-w-xl text-[15px] text-muted">One light on the front tells you how it is doing. Green when it is healthy, red when it is down.</p>
        </header>

        <Section n="01" title="The mark">
          <div className="grid items-center gap-8 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="rounded-2xl border border-line bg-panel p-6">
              <Construction />
            </div>
            <ol className="space-y-4 text-[15px]">
              <li>
                <span className="font-mono text-faint">1</span> <span className="font-semibold text-ink">The roof.</span>{" "}
                <span className="text-muted">Your home. You own the place your app lives.</span>
              </li>
              <li>
                <span className="font-mono text-faint">2</span> <span className="font-semibold text-ink">Two server units.</span>{" "}
                <span className="text-muted">The machine itself, drawn like the flat boxes that sit in a server rack.</span>
              </li>
              <li>
                <span className="font-mono text-faint">3</span> <span className="font-semibold text-ink">One light.</span>{" "}
                <span className="text-muted">The only color in the mark. It always tells the truth about the server.</span>
              </li>
              <li className="pt-2 text-[13px] text-faint">Drawn on a 64 by 64 grid. The roof overhangs the units by the same amount on both sides.</li>
            </ol>
          </div>
        </Section>

        <Section n="02" title="The light tells the truth">
          <div className="grid grid-cols-3 gap-3">
            {(
              [
                ["ok", "Healthy", "text-teal"],
                ["down", "Down", "text-red"],
                ["off", "Off", "text-muted"],
              ] as const
            ).map(([light, label, color]) => (
              <div key={light} className="flex flex-col items-center rounded-2xl border border-line bg-panel py-7 text-ink">
                <Mark size={72} light={light} blink={light !== "off"} />
                <span className={`mt-4 font-mono text-[13px] ${color}`}>{label}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13.5px] text-muted">
            Use the green light by default. The red light is for pages where something is broken, like a page that does not exist. Never color the roof or the units.
          </p>
        </Section>

        <Section n="03" title="Sizes">
          <div className="flex flex-wrap items-end gap-6 rounded-2xl border border-line bg-panel p-6 text-ink">
            {[16, 24, 32, 48, 64, 96].map((s) => (
              <div key={s} className="flex flex-col items-center gap-2">
                <Mark size={s} />
                <span className="font-mono text-[11px] text-faint">{s}</span>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13.5px] text-muted">The mark stays clear down to 16 pixels, the size of a browser tab icon.</p>
        </Section>

        <Section n="04" title="Logo">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex h-40 items-center justify-center rounded-2xl border border-line bg-panel text-[26px] text-ink">
              <Logo size={40} />
            </div>
            <div className="flex h-40 flex-col items-center justify-center gap-3 rounded-2xl border border-line bg-panel text-[20px] text-ink">
              <Mark size={56} />
              <Wordmark cursor={false} />
            </div>
            <div className="flex h-40 items-center justify-center rounded-2xl bg-white text-[26px] text-bg">
              <Logo size={40} />
            </div>
            <div className="flex h-40 items-center justify-center gap-6 rounded-2xl border border-line bg-panel">
              {/* The app icon exactly as a phone or browser shows it. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/app-icon.svg" width={88} height={88} alt="App icon" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/app-icon.svg" width={44} height={44} alt="" />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/brand/app-icon.svg" width={22} height={22} alt="" />
            </div>
          </div>
          <p className="mt-3 text-[13.5px] text-muted">
            The name is written the way you would type it at a prompt: all lowercase, in a code font, with a blinking cursor. In sentences it is just Self-Hosting.
          </p>
        </Section>

        <Section n="05" title="Color">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {COLORS.map((c) => (
              <div key={c.hex} className="overflow-hidden rounded-xl border border-line bg-panel">
                <div className="h-16 border-b border-line" style={{ background: c.hex }} />
                <div className="p-3">
                  <div className="text-[14px] font-semibold text-ink">{c.name}</div>
                  <div className="font-mono text-[11.5px] text-faint">{c.hex}</div>
                  <div className="mt-1 text-[12.5px] leading-snug text-muted">{c.use}</div>
                </div>
              </div>
            ))}
          </div>
          <p className="mt-3 text-[13.5px] text-muted">Black and white, with green and red only when they mean something. If a color does not mean right or wrong, it is grey.</p>
        </Section>

        <Section n="06" title="Type">
          <div className="space-y-3">
            <div className="rounded-2xl border border-line bg-panel p-5">
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">IBM Plex Mono</div>
              <div className="mt-2 font-display text-[30px] leading-tight text-ink">Headings and commands</div>
              <div className="mt-2 font-mono text-[15px] text-ink">
                <span className="text-muted">you@server:~$</span> sudo systemctl restart caddy
              </div>
            </div>
            <div className="rounded-2xl border border-line bg-panel p-5">
              <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-faint">IBM Plex Sans</div>
              <p className="mt-2 text-[17px] leading-relaxed text-ink/90">
                Everything you read. A server is a computer that stays on and answers other computers. That is all it is.
              </p>
            </div>
          </div>
        </Section>

        <Section n="07" title="Voice">
          <ul className="space-y-2 text-[15px] text-ink/90">
            <li>Plain words and short sentences. Write like you are sitting next to a friend.</li>
            <li>Explain every word, flag and symbol before using it. Never ask about something not yet taught.</li>
            <li>No dashes between sentences. Use a full stop instead.</li>
            <li>No made-up product names. Call things what they are.</li>
          </ul>
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-tealdim bg-panel p-4">
              <div className="font-mono text-[12px] text-teal">say this</div>
              <p className="mt-1 text-[14.5px] text-ink">Caddy is a web server. It answers visitors and puts the lock on your site for you.</p>
            </div>
            <div className="rounded-xl border border-reddim bg-panel p-4">
              <div className="font-mono text-[12px] text-red">not this</div>
              <p className="mt-1 text-[14.5px] text-muted">Leverage Caddy&apos;s automatic TLS provisioning for zero-config HTTPS.</p>
            </div>
          </div>
        </Section>

        <Section n="08" title="Link preview">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/opengraph-image" alt="The picture shown when the game's link is shared" className="w-full rounded-2xl border border-line" />
          <p className="mt-3 text-[13.5px] text-muted">This picture shows up when someone shares the game&apos;s link in a chat or a post.</p>
        </Section>

        <Section n="09" title="Files">
          <ul className="grid gap-2 sm:grid-cols-2">
            {FILES.map((f) => (
              <li key={f.href}>
                <a href={f.href} download className="flex items-center gap-3 rounded-xl border border-line bg-panel px-4 py-3 text-[14px] text-ink hover:border-line2">
                  {f.label}
                  <span className="ml-auto font-mono text-[11px] text-faint">{f.kind}</span>
                  <span aria-hidden className="text-muted">↓</span>
                </a>
              </li>
            ))}
          </ul>
        </Section>
      </main>
    </>
  );
}
