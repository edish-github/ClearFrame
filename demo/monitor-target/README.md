# The Act IV monitor target

The fourth act shows a cleared item reopening because the world changed. The event
must be **real** — a Parallel Monitor genuinely detecting a genuine change on a
genuinely public page. What is scheduled is *when* the change happens, not whether.

## What this directory is for

A page you control, publicly reachable, whose content you change on cue. A GitHub
Pages site or a Cloud Storage static object both work. The monitor watches it the
same way it watches a trade publication.

## Setup

1. Publish `target.html` somewhere public and stable. Note the URL.
2. Add a rights holder to the demo project whose name matches the page's subject,
   so the armed watch's objective names it.
3. Arm the watches by shipping the report:
   ```bash
   curl -X POST "$URL_ORCHESTRATOR/projects/$PROJECT_ID/reports" \
        -H 'content-type: application/json' \
        -d '{"cut_id":"'"$CUT_ID"'","arm_watches":true}'
   ```
4. Confirm the watch exists and note its `watch_id`:
   ```bash
   curl "$URL_ORCHESTRATOR/projects/$PROJECT_ID/watches"
   ```

## On the day

Edit `target.html` to publish the change — a filing, an acquisition, a dispute —
and push it. The monitor picks it up on its next execution and calls the webhook
receiver, which verifies the signature and puts the event on the spine. The
Sentinel reopens the item and alerts counsel.

## Cadence, honestly

Parallel Monitor's minimum frequency is one hour, and detection is not instant.
Do not plan to film the change and the reopen in one continuous take. Make the
change well before the shoot, film the arrival, and cut. The rule from the build
plan stands: **schedule the timing, never fake the event.** A staged webhook post
would be the one dishonest frame in the film, and it is not worth it.

## Verifying without waiting

Poll the monitor's events directly — same data, no waiting for a callback:

```bash
curl "$URL_ADAPTER/monitor/$WATCH_ID/events?limit=5"
```
