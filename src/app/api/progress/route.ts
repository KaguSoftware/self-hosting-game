// Cloud save. One JSON blob per player name in Upstash Redis.
// Not secure on purpose: anyone who knows a name can read or overwrite it.
import { Redis } from "@upstash/redis";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function client(): Redis | null {
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

function cleanName(raw: string | null): string | null {
  const name = (raw ?? "").trim().toLowerCase();
  return /^[a-z0-9_-]{2,32}$/.test(name) ? name : null;
}

export async function GET(req: Request) {
  const redis = client();
  if (!redis) return NextResponse.json({ error: "cloud save is not set up" }, { status: 503 });
  const name = cleanName(new URL(req.url).searchParams.get("player"));
  if (!name) return NextResponse.json({ error: "bad player name" }, { status: 400 });
  const data = await redis.get(`progress:${name}`);
  return NextResponse.json({ progress: data ?? null });
}

export async function PUT(req: Request) {
  const redis = client();
  if (!redis) return NextResponse.json({ error: "cloud save is not set up" }, { status: 503 });
  const name = cleanName(new URL(req.url).searchParams.get("player"));
  if (!name) return NextResponse.json({ error: "bad player name" }, { status: 400 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof body.xp !== "number") {
    return NextResponse.json({ error: "bad body" }, { status: 400 });
  }
  const text = JSON.stringify(body);
  if (text.length > 200_000) return NextResponse.json({ error: "too big" }, { status: 413 });
  await redis.set(`progress:${name}`, body);
  await redis.sadd("players", name);
  return NextResponse.json({ ok: true });
}
