from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from ingestion_api.services.embeddings import EMBED_DIMENSION


class FaissStore:
    def __init__(self) -> None:
        self.enabled = True
        self.index_name = os.getenv("FAISS_INDEX_NAME", "medibot-evidence")
        self.namespace = os.getenv("FAISS_NAMESPACE", "pubmed-ai")
        self.base_dir = Path(os.getenv("FAISS_STORAGE_DIR", "data/faiss"))
        self.index_path = self.base_dir / f"{self.index_name}.index"
        self.meta_path = self.base_dir / f"{self.index_name}.metadata.json"

    def is_enabled(self) -> bool:
        return self.enabled

    def _ensure_dir(self) -> None:
        self.base_dir.mkdir(parents=True, exist_ok=True)

    def _load_metadata(self) -> list[dict[str, Any]]:
        if not self.meta_path.exists():
            return []
        return json.loads(self.meta_path.read_text(encoding="utf-8"))

    def _save_metadata(self, metadata: list[dict[str, Any]]) -> None:
        self._ensure_dir()
        self.meta_path.write_text(json.dumps(metadata, indent=2), encoding="utf-8")

    def _load_index(self):
        try:
            import faiss  # type: ignore
        except Exception as error:
            raise RuntimeError(f"FAISS is not installed: {error}") from error

        self._ensure_dir()
        if self.index_path.exists():
            return faiss.read_index(str(self.index_path))
        return faiss.IndexFlatIP(EMBED_DIMENSION)

    def _save_index(self, index) -> None:
        import faiss  # type: ignore

        self._ensure_dir()
        faiss.write_index(index, str(self.index_path))

    def upsert_chunks(self, chunks: list[dict[str, Any]], embeddings) -> int:
        if not chunks:
            return 0

        index = self._load_index()
        metadata = self._load_metadata()
        existing_ids = {item["id"]: pos for pos, item in enumerate(metadata)}

        fresh_chunks = []
        fresh_vectors = []
        for chunk, embedding in zip(chunks, embeddings):
            if chunk["id"] in existing_ids:
                continue
            fresh_chunks.append(chunk)
            fresh_vectors.append(list(embedding))

        if not fresh_chunks:
            return 0

        try:
            import numpy as np  # type: ignore
        except Exception as error:
            raise RuntimeError(f"numpy is required for FAISS indexing: {error}") from error

        index.add(np.array(fresh_vectors, dtype="float32"))
        metadata.extend(
            {
                "id": chunk["id"],
                "doc_id": chunk["doc_id"],
                "source": chunk["source"],
                "title": chunk["title"],
                "study_type": chunk["study_type"],
                "year": str(chunk["year"] or ""),
                "url": chunk["url"],
                "text": chunk["text"],
            }
            for chunk in fresh_chunks
        )

        self._save_index(index)
        self._save_metadata(metadata)
        return len(fresh_chunks)

    def query(self, query_embedding, top_k: int = 8):
        index = self._load_index()
        metadata = self._load_metadata()
        if index.ntotal == 0 or not metadata:
            return {"matches": []}

        try:
            import numpy as np  # type: ignore
        except Exception as error:
            raise RuntimeError(f"numpy is required for FAISS querying: {error}") from error

        distances, indices = index.search(np.array([list(query_embedding)], dtype="float32"), top_k)
        matches = []
        for score, idx in zip(distances[0], indices[0]):
            if idx < 0 or idx >= len(metadata):
                continue
            matches.append(
                {
                    "id": metadata[idx]["id"],
                    "score": float(score),
                    "metadata": metadata[idx],
                }
            )
        return {"matches": matches}
