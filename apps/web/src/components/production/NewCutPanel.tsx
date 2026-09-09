import { useState } from "react";
import { Check } from "lucide-react";
import { Banner, Button, Card, Dropzone } from "@/components/ui";

/**
 * Delta re-clearance. Only new and changed items are researched again; anything
 * untouched keeps its evidence, its risk and its decision.
 */
export function NewCutPanel({ onSubmit, onCancel }: {
  onSubmit: (file: File) => Promise<void>; onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const go = async () => {
    if (!file) { setError("Choose the revised screenplay."); return; }
    setBusy(true);
    setError(null);
    try { await onSubmit(file); }
    catch (err) { setError(err instanceof Error ? err.message : "The cut could not be uploaded."); setBusy(false); }
  };

  return (
    <Card style={{ marginTop: 22 }}>
      <div className="between">
        <div>
          <h3>Re-clear a revised cut</h3>
          <p className="note" style={{ marginTop: 6, maxWidth: "56ch" }}>
            Only items that are new or changed are researched again. Everything unchanged keeps its evidence,
            its risk and its decision.
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>

      <div style={{ marginTop: 14 }}>
        <Dropzone file={file} tight prompt="Drop the revised screenplay" onFile={setFile} onReject={setError} />
      </div>

      {error && <div style={{ marginTop: 14 }}><Banner>{error}</Banner></div>}

      <Button style={{ marginTop: 16 }} icon={<Check size={14} />} busy={busy} onClick={go}>
        Run the delta pass
      </Button>
    </Card>
  );
}
