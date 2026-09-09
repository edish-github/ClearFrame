/**
 * Every reasoning call declares its output shape here. Gemini is constrained to
 * these schemas, so a stage either produces a valid row or fails loudly.
 */

import { CATEGORIES, type Category } from "@clearframe/shared";
export { CATEGORIES };
export type { Category };

export const breakdownSchema = {
  type: "object",
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string", description: "The element as it is named in the script" },
          category: { type: "string", enum: [...CATEGORIES] },
          scene: { type: "string", description: "Scene number or short slugline" },
          page: { type: "string", description: "Page number if inferable, else empty" },
          context: { type: "string", description: "One sentence, 22 words maximum, on how it appears" },
        },
        required: ["item", "category", "scene", "context"],
      },
    },
  },
  required: ["items"],
} as const;

export const BREAKDOWN_SYSTEM = `You are the breakdown pass in a film production clearance system.
You read screenplays and identify third-party elements that must be cleared before a title can be distributed:
songs and music cues, visible brands and trademarks, artworks, murals and posters, archival or news footage,
and real people depicted or named.
You locate and describe items. You never draw rights conclusions and you never guess at ownership.
Prefer specific, named, researchable elements over generic set dressing.`;

export const synthesisSchema = {
  type: "object",
  properties: {
    summary: { type: "string", description: "The current rights position, 3 sentences maximum" },
    evidence: {
      type: "array",
      items: {
        type: "object",
        properties: {
          url: { type: "string", description: "Must be copied exactly from the supplied sources" },
          stance: { type: "string", enum: ["supports", "conflicts", "context"] },
          note: { type: "string", description: "What this source establishes, 16 words maximum" },
        },
        required: ["url", "stance", "note"],
      },
    },
    searchGaps: {
      type: "array",
      description: "Questions the supplied sources did not answer",
      items: { type: "string" },
    },
  },
  required: ["summary", "evidence"],
} as const;

export const SYNTHESIS_SYSTEM = `You are a rights-clearance researcher for a film production.
You are given web sources that were just retrieved for one element. You state the current rights position
using only those sources: who controls it now, any catalogue acquisition or transfer, any dispute or litigation,
and whether the position is contested.
You cite by copying a url exactly from the supplied sources. You never invent, complete, guess or adjust a url.
If the sources do not establish ownership, you say so plainly and record the gap.
Music is two separate properties with separate owners: the underlying composition and the master recording.`;

export const verifySchema = {
  type: "object",
  properties: {
    sufficient: { type: "boolean" },
    reason: { type: "string", description: "24 words maximum" },
    followUpObjective: { type: "string", description: "A specific research objective if insufficient, else empty" },
    followUpQueries: { type: "array", items: { type: "string" } },
  },
  required: ["sufficient", "reason"],
} as const;

export const VERIFY_SYSTEM = `You are the verification pass in a clearance system.
You do not establish truth. You judge one thing: whether the recorded evidence adequately supports the stated
rights position. You check source authority, internal conflict between sources, staleness, and gaps.
You may only object on cited grounds. You never reject a position because it feels uncertain.
When you object, you say exactly what further research would settle it.`;

export const chainSchema = {
  type: "object",
  properties: {
    chains: {
      type: "array",
      items: {
        type: "object",
        properties: {
          right: {
            type: "string",
            description: "Name of the right, e.g. Composition, Master recording, Trademark, Artwork copyright, Publicity rights, Archive licence",
          },
          holder: { type: "string", description: "Who the evidence says controls it now, or empty if not established" },
          status: { type: "string", enum: ["clear", "contested", "unresolved"] },
          note: { type: "string", description: "12 words maximum on what stands in the way, or empty" },
        },
        required: ["right", "status"],
      },
    },
  },
  required: ["chains"],
} as const;

export const CHAIN_SYSTEM = `You trace chains of title for a film clearance team.
A chain is one line of ownership that must resolve before an element can be used.
Music always has exactly two chains: the underlying composition and the master recording. Licensing one
clears nothing. Other elements usually have one chain.
You state only what the recorded evidence supports. Where the evidence does not reach an owner, you mark the
chain unresolved rather than naming a likely candidate.`;

export const assessSchema = {
  type: "object",
  properties: {
    risk: { type: "string", enum: ["LOW", "MEDIUM", "HIGH"] },
    confidence: { type: "number", description: "0 to 1" },
    assessment: { type: "string", description: "2 sentences maximum" },
    recommendation: { type: "string", description: "One imperative sentence" },
    requiresReview: { type: "boolean" },
  },
  required: ["risk", "confidence", "assessment", "recommendation", "requiresReview"],
} as const;

export const ASSESS_SYSTEM = `You are the clearance assessment pass.
Given verified research about a third-party element appearing in a film, you assign a risk level, state what the
evidence shows, and recommend the production's next step.
An unresolved or contested chain of title is elevated risk regardless of how confident the research sounds.
Your output is research for human review. It is not legal advice and you never write as though it were.`;

export const outreachSchema = {
  type: "object",
  properties: {
    addressedTo: { type: "string", description: "The rights holder or licensing desk being addressed" },
    subject: { type: "string" },
    body: { type: "string", description: "120 words maximum, signed off as the clearance office" },
  },
  required: ["addressedTo", "subject", "body"],
} as const;

export const OUTREACH_SYSTEM = `You draft licence inquiries for a film production's clearance office.
You write short, plain, professional emails that ask for licensing terms and confirm who controls the right.
You never assert a rights position as settled, never quote or offer a fee, never threaten, and never claim
anything has been cleared. You ask; you do not negotiate.`;

/** Deep-research output schema handed to the Parallel Task API on escalation. */
export const dossierSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    current_controller: { type: "string", description: "Who controls the right today, or 'not established'" },
    composition_owner: { type: "string", description: "For music only, else empty" },
    master_owner: { type: "string", description: "For music only, else empty" },
    transfers: { type: "string", description: "Catalogue acquisitions or assignments with dates, or 'none found'" },
    disputes: { type: "string", description: "Litigation, estate disputes or oppositions, or 'none found'" },
    position: { type: "string", description: "The rights position in 3 sentences maximum" },
  },
  required: ["current_controller", "transfers", "disputes", "position"],
} as const;
