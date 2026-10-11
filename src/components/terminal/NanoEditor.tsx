"use client";
import { useEffect, useRef, useState } from "react";
import { usePlay } from "@/store/play";
import { sfx } from "@/lib/sfx";

export default function NanoEditor() {
  const editor = usePlay((s) => s.editor);
  const [text, setText] = useState(editor?.req.content ?? "");
  const [dirty, setDirty] = useState(false);
  const [confirmExit, setConfirmExit] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  if (!editor) return null;
  const { req, error } = editor;

  function save() {
    if (usePlay.getState().saveEditor(text)) {
      setDirty(false);
      sfx.tap();
    }
  }

  function exit() {
    if (dirty && !confirmExit) {
      setConfirmExit(true);
      return;
    }
    usePlay.getState().closeEditor();
  }

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-[#070707]">
      <div className="flex items-center justify-between bg-ink/90 px-3 py-0.5 font-mono text-[12px] text-bg">
        <span>GNU nano 7.2</span>
        <span className="truncate">
          {req.path}
          {dirty ? " *" : ""}
        </span>
        <span>{req.isNew ? "New File" : req.canWrite ? "" : "View only"}</span>
      </div>
      <textarea
        ref={ref}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setDirty(true);
          setConfirmExit(false);
        }}
        onKeyDown={(e) => {
          if (e.ctrlKey && (e.key === "s" || e.key === "o")) {
            e.preventDefault();
            save();
          } else if ((e.ctrlKey && e.key === "x") || e.key === "Escape") {
            e.preventDefault();
            exit();
          } else if (e.key === "Tab") {
            e.preventDefault();
            const el = e.currentTarget;
            const s = el.selectionStart;
            setText(text.slice(0, s) + "\t" + text.slice(el.selectionEnd));
            setDirty(true);
            requestAnimationFrame(() => el.setSelectionRange(s + 1, s + 1));
          } else if (e.key.length === 1) sfx.key();
        }}
        spellCheck={false}
        className="flex-1 resize-none bg-transparent px-3 py-2 font-mono text-[12.5px] leading-[1.45] text-ink outline-none scroll-thin"
      />
      <div className="min-h-5 px-3 text-center font-mono text-[12px]">
        {error ? (
          <span className="bg-red/20 text-red">{error}</span>
        ) : confirmExit ? (
          <span className="text-yellow">Save modified buffer? Press Save, or Exit again to discard.</span>
        ) : !req.canWrite ? (
          <span className="text-yellow">You can read this but not save it as {req.asUser}. Exit and open it with sudo nano.</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-line px-3 py-1.5 font-mono text-[11px]">
        <button type="button" onClick={save} className="rounded bg-ink/90 px-1.5 text-bg">
          ^S
        </button>
        <span className="text-muted">Save</span>
        <button type="button" onClick={exit} className="ml-3 rounded bg-ink/90 px-1.5 text-bg">
          ^X
        </button>
        <span className="text-muted">Exit</span>
      </div>
    </div>
  );
}
