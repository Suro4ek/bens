import { useEffect, useRef } from "react";
import { basicSetup } from "codemirror";
import { Compartment, EditorState } from "@codemirror/state";
import { indentUnit } from "@codemirror/language";
import { EditorView, keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { yaml } from "@codemirror/lang-yaml";
import { oneDark } from "@codemirror/theme-one-dark";
import { AppPrefs, isDark, MONO_FONT, useAppPrefs } from "../prefs";

interface Props {
  value: string;
  onChange?: (value: string) => void;
  onSave?: () => void;
  readOnly?: boolean;
}

/** Editor look that follows Preferences (theme, font size, tabs, wrapping). */
const looks = (p: AppPrefs) => [
  ...(isDark() ? [oneDark] : []),
  EditorView.theme({
    "&": { height: "100%", fontSize: `${p.editorFontSize}px`, backgroundColor: "var(--bg)" },
    ".cm-scroller": { fontFamily: MONO_FONT, lineHeight: "1.5" },
    ".cm-gutters": { backgroundColor: "var(--bg)", borderRight: "1px solid var(--border)" },
  }),
  EditorState.tabSize.of(p.editorTabSize),
  indentUnit.of(" ".repeat(p.editorTabSize)),
  ...(p.editorLineWrap ? [EditorView.lineWrapping] : []),
];

/** YAML editor (CodeMirror 6): highlighting, folding, search (⌘F), ⌘S to save. */
export function CodeEditor({ value, onChange, onSave, readOnly }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView>(null);
  const look = useRef(new Compartment());
  const prefs = useAppPrefs();
  // Keep the latest callbacks without recreating the editor.
  const cbs = useRef({ onChange, onSave });
  cbs.current = { onChange, onSave };

  useEffect(() => {
    const v = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          yaml(),
          look.current.of(looks(prefs)),
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              preventDefault: true,
              run: () => {
                cbs.current.onSave?.();
                return true;
              },
            },
          ]),
          EditorState.readOnly.of(!!readOnly),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) cbs.current.onChange?.(u.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly]);

  useEffect(() => {
    view.current?.dispatch({ effects: look.current.reconfigure(looks(prefs)) });
  }, [prefs]);

  // Replace the document when the value changes from outside (reload/save).
  useEffect(() => {
    const v = view.current;
    if (v && v.state.doc.toString() !== value) {
      v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: value } });
    }
  }, [value]);

  return <div className="code-editor" ref={host} />;
}
