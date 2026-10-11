"use client";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Mark, Wordmark } from "./Logo";
import { BOOT_KEY } from "./boot";

const LINES = ["checking power", "checking disk", "checking network"];
// Survives moving between pages, so going back to the map does not boot again.
let played = false;

/** A short power-on screen over the map, once per browser session. Any click or key skips it. */
export default function BootSplash() {
  const [on, setOn] = useState(() => !played);

  useEffect(() => {
    if (played || document.documentElement.dataset.booted || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setOn(false);
      return;
    }
    played = true;
    try {
      sessionStorage.setItem(BOOT_KEY, "1");
    } catch {}
    const skip = () => setOn(false);
    const t = setTimeout(skip, 1900);
    addEventListener("keydown", skip);
    return () => {
      clearTimeout(t);
      removeEventListener("keydown", skip);
    };
  }, []);

  return (
    <AnimatePresence>
      {on && (
        <motion.div
          key="boot"
          exit={{ opacity: 0 }}
          transition={{ duration: 0.3 }}
          onClick={() => setOn(false)}
          className="boot fixed inset-0 z-[100] flex flex-col items-center justify-center bg-bg text-ink"
          aria-hidden
        >
          <Mark size={88} />
          <div className="mt-6 w-56 font-mono text-[12.5px] leading-6 text-muted">
            {LINES.map((l, i) => (
              <div key={l} className="boot-line flex" style={{ animationDelay: `${0.7 + i * 0.18}s` }}>
                {l}
                <span className="ml-auto text-teal">ok</span>
              </div>
            ))}
          </div>
          <div className="boot-line mt-5 text-[22px] text-ink" style={{ animationDelay: "1.3s" }}>
            <Wordmark />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

