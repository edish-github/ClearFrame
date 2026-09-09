import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { Banner, Button, Dropzone, Field, Select, TextArea, TextInput } from "@/components/ui";
import { api } from "@/api/client";
import { useSlate } from "@/hooks/useSlate";

const FORMATS = ["Feature film", "Documentary", "Series episode", "Short film"];

export function NewPass() {
  const navigate = useNavigate();
  const { refreshSlate } = useSlate();
  const [title, setTitle] = useState("");
  const [format, setFormat] = useState(FORMATS[0]!);
  const [budgetUsd, setBudgetUsd] = useState("25");
  const [file, setFile] = useState<File | null>(null);
  const [scriptText, setScriptText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const start = async () => {
    if (!title.trim()) { setError("Give the production a title."); return; }
    if (!file && scriptText.trim().length < 400) {
      setError("Attach a screenplay file, or paste at least a few pages of script."); return;
    }
    const budget = Number(budgetUsd);
    if (!budget || budget <= 0) { setError("Set a research budget above zero."); return; }

    setBusy(true);
    setError(null);
    try {
      const out = await api.createProduction({
        title: title.trim(), format, budgetUsd: budget,
        file: file ?? undefined, scriptText: file ? undefined : scriptText,
      });
      await refreshSlate();
      navigate(`/productions/${out.production.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "The pass could not be started.");
      setBusy(false);
    }
  };

  return (
    <div style={{ maxWidth: 620 }}>
      <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate("/productions")}>
        Productions
      </Button>

      <h1 style={{ marginTop: 22 }}>Start a clearance pass</h1>
      <p className="lede">The script is read once, then every item found in it is researched against live sources.</p>

      <div style={{ marginTop: 30 }}>
        <Field label="Production title">
          <TextInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="As it appears on the slate" />
        </Field>

        <Field label="Format">
          <Select value={format} onChange={(e) => setFormat(e.target.value)}>
            {FORMATS.map((f) => <option key={f}>{f}</option>)}
          </Select>
        </Field>

        <div className="field">
          <span className="field__label">Screenplay</span>
          <Dropzone file={file} onFile={setFile} onReject={setError} />
          {!file && (
            <div style={{ marginTop: 10 }}>
              <TextArea
                value={scriptText}
                onChange={(e) => setScriptText(e.target.value)}
                placeholder="Or paste the script here."
              />
            </div>
          )}
        </div>

        <Field
          label="Research budget"
          hint="Research stops when live spend reaches this cap. Anything not yet investigated is held rather than guessed."
        >
          <TextInput type="number" step="0.5" min="1" value={budgetUsd} onChange={(e) => setBudgetUsd(e.target.value)} />
        </Field>

        {error && <div style={{ marginBottom: 18 }}><Banner>{error}</Banner></div>}

        <Button icon={<Check size={14} />} busy={busy} onClick={start}>Start the pass</Button>
      </div>
    </div>
  );
}
