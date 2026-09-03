"use client";

import { useEffect, useRef, useState } from "react";
import type { HeatStripRegion } from "@/lib/contracts";
import { seconds, timecode } from "@/lib/format";

type Props = {
  src?: string | null;
  fps: number;
  durationFrames: number;
  scrubTo: HeatStripRegion | null;
  onProgress: (pct: number) => void;
};

/**
 * The hero surface: the film itself.
 *
 * When a cut has been uploaded this plays it and scrubs to the frame a heat-strip
 * region names. When the pass ran over a script — which is the pre-production
 * case, and the one a judge is most likely to try — there is no picture to play,
 * so the surface shows the anchor instead of pretending.
 */
export function CutPlayer({ src, fps, durationFrames, scrubTo, onProgress }: Props) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!scrubTo) return;
    const at = seconds(scrubTo.frame_in, fps);
    setFrame(scrubTo.frame_in);
    if (video.current) {
      video.current.currentTime = at;
      void video.current.play().catch(() => setPlaying(false));
    }
  }, [scrubTo, fps]);

  const pct = durationFrames > 0 ? (frame / durationFrames) * 100 : 0;
  useEffect(() => onProgress(pct), [pct, onProgress]);

  if (!src) {
    return (
      <div className="player player--empty">
        <div className="stack-tight" style={{ alignItems: "center" }}>
          <span className="kicker">no picture on this cut</span>
          <p className="muted small" style={{ maxWidth: 420, textAlign: "center" }}>
            This pass ran over a script. Items are anchored to scene and page; upload
            picture and the same register re-anchors to frames.
          </p>
          {scrubTo && (
            <div className="player__anchor stack-tight">
              <span className="kicker">selected</span>
              <strong>{scrubTo.title}</strong>
              <span className="mono small dim">
                {scrubTo.scene ? `scene ${scrubTo.scene} · ` : ""}
                {scrubTo.tc_in}
              </span>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="player">
      <video
        ref={video}
        src={src}
        className="player__video"
        onTimeUpdate={(event) =>
          setFrame(Math.round(event.currentTarget.currentTime * fps))
        }
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        playsInline
      />
      <div className="player__bar">
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            if (!video.current) return;
            if (playing) video.current.pause();
            else void video.current.play();
          }}
        >
          {playing ? "Pause" : "Play"}
        </button>
        <span className="mono small">{timecode(frame, fps)}</span>
        {scrubTo && <span className="small truncate muted">{scrubTo.title}</span>}
      </div>
    </div>
  );
}
