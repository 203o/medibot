from __future__ import annotations

import hashlib
from functools import lru_cache
from typing import Iterable

EMBED_DIMENSION = 384


@lru_cache(maxsize=1)
def _load_model():
    try:
        from sentence_transformers import SentenceTransformer
    except Exception:
        return None
    return SentenceTransformer("all-MiniLM-L6-v2")


def _normalize(vector: list[float]) -> list[float]:
    norm = sum(value * value for value in vector) ** 0.5
    if not norm:
        return vector
    return [value / norm for value in vector]


def _hash_embed(text: str, dim: int = EMBED_DIMENSION) -> list[float]:
    vector = [0.0] * dim
    for token in text.lower().split():
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        for i in range(min(len(digest), dim)):
            vector[i] += digest[i] / 255.0
    return _normalize(vector)


def embed_texts(texts: Iterable[str]):
    text_list = [text or "" for text in texts]
    model = _load_model()
    if model is None:
        return [_hash_embed(text) for text in text_list]

    embeddings = model.encode(text_list, normalize_embeddings=True)
    return [list(map(float, embedding)) for embedding in embeddings]
