import { useState } from "react";
import { Banner, Button, Field, TextInput } from "@/components/ui";
import { useAuth } from "@/hooks/useAuth";

export function SignIn() {
  const { signIn, register } = useAuth();
  const [mode, setMode] = useState<"in" | "up">("in");
  const [form, setForm] = useState({ orgName: "", name: "", email: "", password: "" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "in") await signIn(form.email, form.password);
      else await register(form);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not reach the server.");
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <form className="signin__form" onSubmit={submit}>
        <div style={{ maxWidth: 380 }}>
          <div className="mono note">CLEARFRAME</div>
          <h1 style={{ marginTop: 10 }}>{mode === "in" ? "Sign in" : "Create a workspace"}</h1>
          <p className="lede" style={{ marginBottom: 30 }}>
            {mode === "in"
              ? "Clearance research, evidence and decisions for your slate."
              : "Start a slate. You can invite counsel once you are in."}
          </p>

          {mode === "up" && (
            <>
              <Field label="Production company">
                <TextInput value={form.orgName} onChange={set("orgName")} placeholder="Nightjar Films" required />
              </Field>
              <Field label="Your name">
                <TextInput value={form.name} onChange={set("name")} placeholder="Ada Reyes" required />
              </Field>
            </>
          )}

          <Field label="Email">
            <TextInput type="email" value={form.email} onChange={set("email")} autoComplete="email" required />
          </Field>
          <Field label="Password" hint={mode === "up" ? "At least 10 characters." : undefined}>
            <TextInput
              type="password" value={form.password} onChange={set("password")}
              autoComplete={mode === "in" ? "current-password" : "new-password"} required
            />
          </Field>

          {error && <div style={{ marginBottom: 18 }}><Banner>{error}</Banner></div>}

          <Button type="submit" busy={busy}>{mode === "in" ? "Sign in" : "Create workspace"}</Button>

          <p className="note" style={{ marginTop: 18 }}>
            {mode === "in" ? "No workspace yet? " : "Already have one? "}
            <button
              type="button"
              onClick={() => { setMode(mode === "in" ? "up" : "in"); setError(null); }}
              style={{ background: "none", border: 0, padding: 0, font: "inherit", color: "var(--signal)", cursor: "pointer" }}
            >
              {mode === "in" ? "Create one" : "Sign in"}
            </button>
          </p>
        </div>
      </form>
      <div className="signin__art" aria-hidden />
    </div>
  );
}
