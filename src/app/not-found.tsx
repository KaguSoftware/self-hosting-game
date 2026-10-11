import Link from "next/link";
import TopBar from "@/components/TopBar";
import { Mark } from "@/components/brand/Logo";

export const metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <>
      <TopBar />
      <main className="mx-auto flex min-h-[80dvh] max-w-md flex-col items-center justify-center px-4 text-center">
        <Mark size={96} light="down" blink title="Server with a red light" />
        <div className="mt-6 font-display text-[64px] leading-none text-ink">404</div>
        <p className="mt-3 text-[18px] font-semibold text-ink">Nothing is hosted at this address.</p>
        <p className="mt-1 text-[14.5px] text-muted">The server answered, but it has no page here. 404 is the number a server sends back when that happens.</p>
        <div className="mt-6 w-full rounded-xl border border-line bg-panel p-4 text-left font-mono text-[13px] leading-6">
          <div>
            <span className="text-muted">you@laptop:~$</span> curl -I /this-page
          </div>
          <div className="text-red">HTTP/1.1 404 Not Found</div>
        </div>
        <Link href="/" className="mt-6 rounded-lg bg-ink px-5 py-2.5 text-[14px] font-semibold text-bg hover:bg-white">
          Back to the map
        </Link>
      </main>
    </>
  );
}
