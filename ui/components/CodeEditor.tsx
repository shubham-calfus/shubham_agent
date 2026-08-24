"use client";

import CodeMirror, { EditorView } from "@uiw/react-codemirror";
import { python } from "@codemirror/lang-python";
import { json as jsonLang } from "@codemirror/lang-json";
import { oneDark } from "@codemirror/theme-one-dark";
import { useThemeMode } from "@/lib/useThemeMode";

// Same editor sombrero uses (agent-trigger EditScriptDrawer / EditParamsDrawer):
// @uiw/react-codemirror with the python() / json() language extensions and the
// oneDark theme. We additionally follow the app's light/dark toggle so it never
// shows a white box on the dark UI.
export function CodeEditor({
  value,
  onChange,
  language = "python",
  readOnly = false,
  height = 360,
  wrap = false,
}: {
  value: string;
  onChange?: (v: string) => void;
  language?: "python" | "json";
  readOnly?: boolean;
  height?: number | string;
  wrap?: boolean;
}) {
  const mode = useThemeMode();
  const h = typeof height === "number" ? `${height}px` : height;
  const lang = language === "json" ? jsonLang() : python();

  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <CodeMirror
        value={value}
        extensions={wrap ? [lang, EditorView.lineWrapping] : [lang]}
        theme={mode === "dark" ? oneDark : "light"}
        height={h}
        readOnly={readOnly}
        editable={!readOnly}
        basicSetup={{ lineNumbers: true, foldGutter: true, highlightActiveLine: !readOnly }}
        style={{ fontSize: 12.5 }}
        onChange={(v) => onChange?.(v)}
      />
    </div>
  );
}
