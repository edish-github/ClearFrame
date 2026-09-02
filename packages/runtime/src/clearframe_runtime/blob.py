"""Blob storage — cuts, citation snapshots, rendered reports."""

from __future__ import annotations

import base64
from abc import ABC, abstractmethod
from datetime import timedelta
from pathlib import Path

from .config import settings


class BlobStore(ABC):
    @abstractmethod
    def put(self, bucket: str, path: str, data: bytes, content_type: str) -> str: ...

    @abstractmethod
    def get(self, bucket: str, path: str) -> bytes: ...

    @abstractmethod
    def signed_url(self, bucket: str, path: str, hours: int = 72) -> str: ...


class LocalBlobStore(BlobStore):
    def __init__(self, root: Path | None = None) -> None:
        self.root = Path(root or settings().local_root) / "blobs"
        self.root.mkdir(parents=True, exist_ok=True)

    def _path(self, bucket: str, path: str) -> Path:
        target = self.root / bucket / path
        target.parent.mkdir(parents=True, exist_ok=True)
        return target

    def put(self, bucket: str, path: str, data: bytes, content_type: str) -> str:
        target = self._path(bucket, path)
        target.write_bytes(data)
        return f"file://{target}"

    def get(self, bucket: str, path: str) -> bytes:
        return self._path(bucket, path).read_bytes()

    def signed_url(self, bucket: str, path: str, hours: int = 72) -> str:
        return f"file://{self._path(bucket, path)}"


class GcsBlobStore(BlobStore):
    def __init__(self) -> None:
        from google.cloud import storage

        self._client = storage.Client(project=settings().project_id)

    def put(self, bucket: str, path: str, data: bytes, content_type: str) -> str:
        blob = self._client.bucket(bucket).blob(path)
        blob.upload_from_string(data, content_type=content_type)
        return f"gs://{bucket}/{path}"

    def get(self, bucket: str, path: str) -> bytes:
        return self._client.bucket(bucket).blob(path).download_as_bytes()

    def signed_url(self, bucket: str, path: str, hours: int = 72) -> str:
        blob = self._client.bucket(bucket).blob(path)
        return blob.generate_signed_url(expiration=timedelta(hours=hours), version="v4")


_BLOBS: BlobStore | None = None


def get_blobs() -> BlobStore:
    global _BLOBS
    if _BLOBS is None:
        _BLOBS = LocalBlobStore() if settings().is_local else GcsBlobStore()
    return _BLOBS


def set_blobs(store: BlobStore | None) -> None:
    global _BLOBS
    _BLOBS = store


def snapshot_path(project_id: str, citation_id: str, ext: str = "md") -> str:
    return f"snapshots/{project_id}/{citation_id}.{ext}"


def data_uri(data: bytes, content_type: str) -> str:
    return f"data:{content_type};base64,{base64.b64encode(data).decode()}"
