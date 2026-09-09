import { useRef, useState } from "react";
import { FileText, Upload } from "lucide-react";

const ACCEPT = ".pdf,.txt,.fountain,.md";
const MAX_BYTES = 25 * 1024 * 1024;

/** Returns the reason a file is unusable, or null when it is fine. */
export function rejectReason(file: File | null | undefined): string | null {
  if (!file) return "No file was chosen.";
  if (!/\.(pdf|txt|fountain|md)$/i.test(file.name)) {
    return "That file type cannot be read. Use a PDF, .txt or .fountain screenplay.";
  }
  if (file.size > MAX_BYTES) return "That file is over 25 MB. Upload a smaller export of the script.";
  return null;
}

export function Dropzone({ file, onFile, onReject, tight, prompt = "Drop the screenplay here" }: {
  file: File | null;
  onFile: (f: File) => void;
  onReject: (reason: string) => void;
  tight?: boolean;
  prompt?: string;
}) {
  const [hot, setHot] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  const take = (candidate: File | null | undefined) => {
    const reason = rejectReason(candidate);
    if (reason) { onReject(reason); return; }
    onFile(candidate as File);
  };

  return (
    <>
      <div
        className={["dropzone", tight && "dropzone--tight", hot && "is-hot"].filter(Boolean).join(" ")}
        role="button"
        tabIndex={0}
        onClick={() => input.current?.click()}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") input.current?.click(); }}
        onDragOver={(e) => { e.preventDefault(); setHot(true); }}
        onDragLeave={() => setHot(false)}
        onDrop={(e) => { e.preventDefault(); setHot(false); take(e.dataTransfer.files?.[0]); }}
      >
        {file ? (
          <>
            <FileText size={18} style={{ marginBottom: 8, color: "var(--signal)" }} />
            <div className="dropzone__title mono">{file.name}</div>
            <div className="dropzone__hint">
              {(file.size / 1024 / 1024).toFixed(2)} MB · click to choose a different file
            </div>
          </>
        ) : (
          <>
            <Upload size={18} style={{ marginBottom: 8, color: "var(--ink-3)" }} />
            <div className="dropzone__title">{prompt}</div>
            <div className="dropzone__hint">PDF, .txt or .fountain</div>
          </>
        )}
      </div>
      <input
        ref={input} type="file" accept={ACCEPT} style={{ display: "none" }}
        onChange={(e) => take(e.target.files?.[0])}
      />
    </>
  );
}
