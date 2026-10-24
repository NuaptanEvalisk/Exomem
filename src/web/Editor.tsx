import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import { Crepe } from "@milkdown/crepe";
import { Alert, Spin } from "antd";
import "@milkdown/crepe/theme/common/style.css";
import "@milkdown/crepe/theme/frame.css";

export interface EditorHandle {
  getMarkdown: () => string;
}
const Editor = forwardRef<
  EditorHandle,
  {
    initial: string;
    onChange?: (value: string) => void;
    onReady?: (ready: boolean) => void;
    readonly?: boolean;
  }
>(function Editor({ initial, onChange, onReady, readonly = false }, ref) {
  const root = useRef<HTMLDivElement>(null);
  const instance = useRef<Crepe | null>(null);
  useImperativeHandle(
    ref,
    () => ({ getMarkdown: () => instance.current?.getMarkdown() ?? initial }),
    [initial],
  );
  const change = useRef(onChange),
    ready = useRef(onReady);
  change.current = onChange;
  ready.current = onReady;
  const [loading, setLoading] = useState(true),
    [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const editor = new Crepe({
      root: root.current!,
      defaultValue: initial,
      features: { [Crepe.Feature.AI]: false },
      featureConfigs: {
        [Crepe.Feature.Placeholder]: {
          text: "Write here. Select text to format it…",
        },
      },
    });
    editor.setReadonly(readonly);
    instance.current = editor;
    editor.on((listener) =>
      listener.markdownUpdated((_ctx, markdown) => {
        if (!disposed) change.current?.(markdown);
      }),
    );
    ready.current?.(false);
    const created = editor
      .create()
      .then(() => {
        if (!disposed) {
          setLoading(false);
          ready.current?.(true);
        }
      })
      .catch((e) => {
        if (!disposed) {
          setLoading(false);
          setError(String(e));
        }
      });
    return () => {
      disposed = true;
      instance.current = null;
      ready.current?.(false);
      void created.then(() => editor.destroy());
    };
  }, [initial, readonly]);
  return (
    <div className={`memory-editor ${readonly ? "read-only" : ""}`}>
      {loading && (
        <div className="editor-loading">
          <Spin tip="Loading editor" />
        </div>
      )}
      {error && (
        <Alert type="error" title="Editor could not load" description={error} />
      )}
      <div ref={root} />
    </div>
  );
});
export default Editor;
