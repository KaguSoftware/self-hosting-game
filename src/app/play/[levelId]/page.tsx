import { notFound } from "next/navigation";
import LevelPlayer from "@/components/play/LevelPlayer";
import { LEVELS, levelById } from "@/content";

export function generateStaticParams() {
  return LEVELS.map((l) => ({ levelId: l.id }));
}

export default async function PlayPage({ params }: { params: Promise<{ levelId: string }> }) {
  const { levelId } = await params;
  if (!levelById(levelId)) notFound();
  return <LevelPlayer levelId={levelId} />;
}
