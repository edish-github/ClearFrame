"""Cut ingestion — turning an upload into something the Breakdown agent can read.

Scripts become text; picture becomes keyframes on a fixed cadence, each labelled
with the frame number it came from so extracted items land on real timecodes.
Anything unreadable fails loudly with a message a producer can act on, because a
judge's odd upload must end cleanly rather than crash a pass.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path

from clearframe_runtime import get_logger, log_event

from .models import MediaPart

log = get_logger("clearframe.ingest")

SCRIPT_TEXT_SUFFIXES = {".txt", ".md", ".fountain", ".fdx"}
VIDEO_SUFFIXES = {".mp4", ".mov", ".mkv", ".m4v", ".webm", ".avi"}

#: One keyframe every N seconds. Dense enough to catch a poster on a wall,
#: sparse enough that a 4-minute short is a handful of images.
KEYFRAME_INTERVAL_S = 5.0
MAX_KEYFRAMES = 40


class IngestError(RuntimeError):
    """The upload could not be read. Always carries a producer-readable reason."""


@dataclass
class IngestedCut:
    kind: str  # "script" | "cut"
    text: str = ""
    media: list[MediaPart] = None  # type: ignore[assignment]
    duration_frames: int = 0
    fps: float = 24.0
    pages: int = 0

    def __post_init__(self) -> None:
        if self.media is None:
            self.media = []


def _pdf_text(path: Path) -> tuple[str, int]:
    try:
        from pypdf import PdfReader
    except ImportError as exc:  # pragma: no cover - dependency is declared
        raise IngestError("pypdf is not installed; cannot read PDF scripts") from exc

    try:
        reader = PdfReader(str(path))
    except Exception as exc:  # noqa: BLE001
        raise IngestError(f"this PDF could not be opened: {exc}") from exc

    pages = []
    for index, page in enumerate(reader.pages, start=1):
        try:
            body = page.extract_text() or ""
        except Exception:  # noqa: BLE001 — one bad page must not lose the script
            body = ""
        pages.append(f"\n\n--- page {index} ---\n{body}")
    text = "".join(pages).strip()
    if not text:
        raise IngestError(
            "no text could be extracted from this PDF — it is probably a scan. "
            "Run OCR on it, or upload the text script."
        )
    return text, len(reader.pages)


def _ffprobe(path: Path) -> tuple[float, float]:
    """Return (duration_seconds, fps) for a picture file."""
    if not shutil.which("ffprobe"):
        raise IngestError("ffprobe is not installed; cannot read picture files")
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=r_frame_rate,duration",
            "-show_entries",
            "format=duration",
            "-of",
            "json",
            str(path),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise IngestError(f"this file is not readable as video: {result.stderr[:200]}")

    probe = json.loads(result.stdout or "{}")
    stream = (probe.get("streams") or [{}])[0]
    rate = stream.get("r_frame_rate", "24/1")
    try:
        num, _, den = rate.partition("/")
        fps = float(num) / float(den or 1)
    except (TypeError, ValueError):
        fps = 24.0
    duration = float(stream.get("duration") or probe.get("format", {}).get("duration") or 0)
    if duration <= 0:
        raise IngestError("could not determine the duration of this file")
    return duration, fps or 24.0


def _keyframes(path: Path, duration_s: float, fps: float, workdir: Path) -> list[MediaPart]:
    interval = max(KEYFRAME_INTERVAL_S, duration_s / MAX_KEYFRAMES)
    workdir.mkdir(parents=True, exist_ok=True)
    pattern = str(workdir / "frame-%04d.jpg")
    result = subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-vf",
            f"fps=1/{interval:.4f},scale=768:-2",
            "-q:v",
            "4",
            pattern,
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    if result.returncode != 0:
        raise IngestError(f"keyframe extraction failed: {result.stderr[:200]}")

    parts: list[MediaPart] = []
    for index, frame in enumerate(sorted(workdir.glob("frame-*.jpg"))):
        timestamp = index * interval
        parts.append(
            MediaPart(
                mime_type="image/jpeg",
                data=frame.read_bytes(),
                label=f"t={timestamp:.1f}s frame={int(timestamp * fps)}",
            )
        )
    if not parts:
        raise IngestError("no frames could be extracted from this file")
    return parts[:MAX_KEYFRAMES]


async def ingest(path: str | Path, workdir: Path | None = None) -> IngestedCut:
    """Read an upload. Runs the blocking tools off the event loop."""
    source = Path(path)
    if not source.exists():
        raise IngestError(f"{source} does not exist")
    if source.stat().st_size == 0:
        raise IngestError(f"{source.name} is empty")

    suffix = source.suffix.lower()
    loop = asyncio.get_running_loop()

    if suffix in SCRIPT_TEXT_SUFFIXES:
        text = source.read_text(errors="replace").strip()
        if not text:
            raise IngestError(f"{source.name} contains no text")
        return IngestedCut(kind="script", text=text, pages=max(1, text.count("\f") + 1))

    if suffix == ".pdf":
        text, pages = await loop.run_in_executor(None, _pdf_text, source)
        return IngestedCut(kind="script", text=text, pages=pages)

    if suffix in VIDEO_SUFFIXES:
        duration_s, fps = await loop.run_in_executor(None, _ffprobe, source)
        frames_dir = (workdir or source.parent / ".frames") / source.stem
        media = await loop.run_in_executor(None, _keyframes, source, duration_s, fps, frames_dir)
        log_event(
            log,
            "cut ingested",
            file=source.name,
            keyframes=len(media),
            duration_s=round(duration_s, 1),
            fps=round(fps, 3),
        )
        return IngestedCut(
            kind="cut",
            media=media,
            fps=fps,
            duration_frames=int(duration_s * fps),
            text=(
                f"Picture: {source.name}. Duration {duration_s:.1f}s at {fps:.2f} fps "
                f"({int(duration_s * fps)} frames). {len(media)} keyframes follow, "
                "each labelled with its timestamp and frame number."
            ),
        )

    raise IngestError(
        f"unsupported file type '{suffix or 'none'}'. Upload a script "
        "(.pdf, .txt, .md, .fountain) or picture (.mp4, .mov, .mkv)."
    )
