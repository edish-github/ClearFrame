import { useState } from "react";
import { Copy, Send } from "lucide-react";
import type { Outreach } from "@clearframe/shared";
import { Banner, Button, Card, Pill } from "@/components/ui";
import { stamp } from "@/lib/format";
import { useAuth } from "@/hooks/useAuth";

/**
 * ClearFrame drafts inquiries and holds them behind counsel. There is no send
 * capability anywhere in the system, which is why this card offers copy rather
 * than a button that pretends to deliver mail.
 */
export function OutreachCard({ outreach, onApprove, bare }: {
  outreach: Outreach; onApprove?: () => Promise<void>; bare?: boolean;
}) {
  const { can } = useAuth();
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (outreach.state === "drafting") {
    return (
      <Card style={{ marginTop: 22 }}>
        <h3>Licence inquiry</h3>
        <div className="note" style={{ marginTop: 8 }}>Drafting from the traced chain of title.</div>
      </Card>
    );
  }

  if (outreach.state === "failed") {
    return <div style={{ marginTop: 22 }}><Banner>{outreach.error ?? "The draft could not be produced."}</Banner></div>;
  }

  const copy = async () => {
    await navigator.clipboard?.writeText(
      `To: ${outreach.addressed_to}\nSubject: ${outreach.subject}\n\n${outreach.body}`
    );
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  const approve = async () => {
    if (!onApprove) return;
    setBusy(true);
    setError(null);
    try { await onApprove(); }
    catch (err) { setError(err instanceof Error ? err.message : "The inquiry was not approved."); }
    finally { setBusy(false); }
  };

  const body = (
    <>
      <div className="between">
        <div>
          <h3>Licence inquiry</h3>
          <p className="note" style={{ marginTop: 6, maxWidth: "56ch" }}>
            {outreach.state === "approved"
              ? `Approved by ${outreach.approved_name} on ${stamp(outreach.approved_at!)}. ClearFrame does not send mail; copy it into your own outbox.`
              : "Drafted from the chain of title on record. It waits here until counsel approves it."}
          </p>
        </div>
        <Pill tone={outreach.state === "approved" ? "green" : "amber"}>
          {outreach.state === "approved" ? "Approved" : "Awaiting approval"}
        </Pill>
      </div>

      <div className="mail" style={{ marginTop: 14 }}>
        <div className="mail__head">
          <span className="mail__key">To</span><span>{outreach.addressed_to}</span>
          <span className="mail__key">Subject</span><span>{outreach.subject}</span>
        </div>
        <div className="mail__body">{outreach.body}</div>
      </div>

      {error && <div style={{ marginTop: 14 }}><Banner>{error}</Banner></div>}

      <div className="row" style={{ marginTop: 14 }}>
        {outreach.state === "draft" && onApprove && (
          <Button icon={<Send size={13} />} busy={busy} disabled={!can("counsel")} onClick={approve}>
            Approve for sending
          </Button>
        )}
        <Button variant="ghost" icon={<Copy size={13} />} onClick={copy}>{copied ? "Copied" : "Copy"}</Button>
      </div>
      {outreach.state === "draft" && !can("counsel") && (
        <div className="note" style={{ marginTop: 10 }}>Only counsel can release an outbound inquiry.</div>
      )}
    </>
  );

  return bare ? <div style={{ marginTop: 18 }}>{body}</div> : <Card style={{ marginTop: 22 }}>{body}</Card>;
}
