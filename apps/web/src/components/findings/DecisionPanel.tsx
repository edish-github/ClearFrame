import { useState } from "react";
import { Check } from "lucide-react";
import { DECISION_ACTIONS, DECISION_LABEL, type DecisionAction } from "@clearframe/shared";
import { Banner, Button, Card, Chips, Field, TextArea } from "@/components/ui";
import { useAuth } from "@/hooks/useAuth";

/**
 * The human gate. The server refuses a decision from anyone but counsel; this
 * only explains why the controls are inert so nobody hunts for a bug.
 */
export function DecisionPanel({ onRecord }: {
  onRecord: (action: DecisionAction, rationale: string) => Promise<void>;
}) {
  const { can } = useAuth();
  const counsel = can("counsel");
  const [action, setAction] = useState<DecisionAction | null>(null);
  const [rationale, setRationale] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (!action) return;
    setBusy(true);
    setError(null);
    try {
      await onRecord(action, rationale.trim());
      setAction(null);
      setRationale("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "The decision was not recorded.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ marginTop: 20 }}>
      <h3>Record a decision</h3>
      <p className="note" style={{ margin: "6px 0 14px" }}>
        {counsel
          ? "Written to this production's ledger and carried into the report. Pursuing a licence also drafts the inquiry."
          : "Only counsel can resolve a finding. Ask a counsel seat to review this one."}
      </p>

      <div style={{ marginBottom: 14 }}>
        <Chips
          value={action}
          disabled={!counsel}
          onChange={(v) => setAction(v)}
          options={DECISION_ACTIONS.map((a) => ({ value: a, label: DECISION_LABEL[a] }))}
        />
      </div>

      <Field label="Rationale">
        <TextArea
          value={rationale}
          disabled={!counsel}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why this resolves the finding."
        />
      </Field>

      {error && <div style={{ marginBottom: 14 }}><Banner>{error}</Banner></div>}

      <Button icon={<Check size={14} />} busy={busy} disabled={!action || !counsel} onClick={submit}>
        Record decision
      </Button>
    </Card>
  );
}
