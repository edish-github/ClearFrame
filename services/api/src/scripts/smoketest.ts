/**
 * Live provider smoke test. Makes one real call to each external surface so a
 * misconfigured key or a changed API shape fails here rather than mid-demo.
 *
 *   GEMINI_API_KEY=... PARALLEL_API_KEY=... npx tsx src/smoketest.ts
 */
import { env } from "../core/env.js";
import { generate } from "../providers/gemini.js";
import { search, runTask } from "../providers/parallel.js";

const line = (s: string) => console.log(s);
let failures = 0;

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now();
  try {
    const detail = await fn();
    line(`  pass  ${name}  (${Date.now() - started}ms)  ${detail}`);
  } catch (err) {
    failures++;
    line(`  FAIL  ${name}  ${(err as Error).message}`);
  }
}

line("\nClearFrame provider smoke test\n");
line(`  gemini   Vertex AI (${env.gemini.project || "project"} / ${env.gemini.location}) · ${env.gemini.pro} / ${env.gemini.flash}`);
line(`  parallel ${env.parallel.baseUrl}\n`);

await step("Gemini returns schema-valid JSON", async () => {
  const { data, usage } = await generate<{ ok: boolean; note: string }>({
    tier: "flash",
    system: "You reply with JSON and nothing else.",
    prompt: 'Set ok to true and note to the single word "reachable".',
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" }, note: { type: "string" } },
      required: ["ok", "note"],
    },
    maxOutputTokens: 256,
  });
  if (typeof data.ok !== "boolean") throw new Error("response did not match the declared schema");
  return `${usage.inputTokens}+${usage.outputTokens} tok, ${(usage.costMicros / 1e6).toFixed(6)} USD`;
});

await step("Gemini reads an inline PDF", async () => {
  // Smallest valid PDF containing the word CLEARFRAME.
  const pdf = Buffer.from(
    "JVBERi0xLjQKMSAwIG9iajw8L1R5cGUvQ2F0YWxvZy9QYWdlcyAyIDAgUj4+ZW5kb2JqCjIgMCBvYmo8" +
    "PC9UeXBlL1BhZ2VzL0tpZHNbMyAwIFJdL0NvdW50IDE+PmVuZG9iagozIDAgb2JqPDwvVHlwZS9QYWdl" +
    "L1BhcmVudCAyIDAgUi9NZWRpYUJveFswIDAgMjAwIDUwXS9SZXNvdXJjZXM8PC9Gb250PDwvRjE8PC9U" +
    "eXBlL0ZvbnQvU3VidHlwZS9UeXBlMS9CYXNlRm9udC9IZWx2ZXRpY2E+Pj4+Pj4vQ29udGVudHMgNCAw" +
    "IFI+PmVuZG9iago0IDAgb2JqPDwvTGVuZ3RoIDQ0Pj5zdHJlYW0KQlQgL0YxIDE4IFRmIDIwIDIwIFRk" +
    "IChDTEVBUkZSQU1FKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCnRyYWlsZXI8PC9Sb290IDEgMCBSPj4K",
    "base64"
  );
  const { data } = await generate<{ words: string[] }>({
    tier: "flash",
    system: "You transcribe documents. You reply with JSON and nothing else.",
    prompt: "List every word visible in this document.",
    schema: { type: "object", properties: { words: { type: "array", items: { type: "string" } } }, required: ["words"] },
    file: { mimeType: "application/pdf", base64: pdf.toString("base64") },
    maxOutputTokens: 256,
  });
  const found = (data.words ?? []).join(" ").toUpperCase();
  if (!found.includes("CLEARFRAME")) throw new Error(`did not read the document, got: ${found.slice(0, 60)}`);
  return "document text extracted";
});

await step("Parallel Search returns real URLs", async () => {
  const out = await search({
    objective:
      "Establish who currently controls the publishing rights to a well-known song catalogue, " +
      "to confirm the search API returns usable rights-research sources.",
    queries: ["music publishing catalogue acquisition", "song rights owner publisher"],
    mode: "basic",
    maxResults: 5,
  });
  if (!out.results.length) throw new Error("search returned no results");
  const bad = out.results.filter((r) => !/^https?:\/\//.test(r.url));
  if (bad.length) throw new Error(`${bad.length} result(s) had malformed urls`);
  const withText = out.results.filter((r) => r.excerpts.length).length;
  return `${out.results.length} sources, ${withText} with excerpts, ${(out.costMicros / 1e6).toFixed(4)} USD`;
});

if (process.env.SMOKE_INCLUDE_TASK === "true") {
  await step("Parallel Task returns structured output", async () => {
    const out = await runTask<{ answer: string }>({
      input: "In one short sentence, what is a music publishing catalogue acquisition?",
      outputSchema: {
        type: "object", additionalProperties: false,
        properties: { answer: { type: "string" } }, required: ["answer"],
      },
      processor: "lite",
      timeoutMs: 240_000,
    });
    if (!out.output?.answer) throw new Error("task returned no structured output");
    return `run ${out.runId}, ${out.citations.length} citations`;
  });
} else {
  line("  skip  Parallel Task (set SMOKE_INCLUDE_TASK=true; it costs more and takes minutes)");
}

line(`\n${failures === 0 ? "providers reachable" : `${failures} PROVIDER CHECK(S) FAILED`}\n`);
process.exit(failures === 0 ? 0 : 1);
