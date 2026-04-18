# FastAPI Ingestion Service

This service ingests:

- PubMed abstracts via NCBI E-utilities
- ClinicalTrials.gov study summaries via the v2 studies API
- optional local FAISS semantic indexing over evidence chunks

It stores raw results as JSON under `data/raw/<date>/<run_id>/`.
The semantic index is stored locally under `data/faiss/`.

## Install

```powershell
python -m pip install -r requirements-fastapi.txt
```

If `faiss-cpu` fails to install on your Python version, install the currently available wheel explicitly:

```powershell
python -m pip install faiss-cpu==1.13.2
```

If you want semantic indexing, set these environment variables before running:

```powershell
$env:FAISS_INDEX_NAME="medibot-evidence"
$env:FAISS_NAMESPACE="pubmed-ai"
$env:FAISS_STORAGE_DIR="data/faiss"
```

## Run

```powershell
python -m uvicorn ingestion_api.main:app --host 127.0.0.1 --port 8001
```

Keep the Node backend on `127.0.0.1:4000` and the FastAPI ingestion service on `127.0.0.1:8001`.
The Node backend will call FastAPI automatically through `FASTAPI_INGESTION_URL`.

## Request

`POST /ingest` or `POST /api/ingest`

```json
{
  "medical_context": {
    "disease": "malaria",
    "intent": "hydration during treatment",
    "location": "Kenya, Turkana"
  },
  "max_results": 5,
  "sources": ["pubmed", "clinicaltrials"]
}
```

## Stored Files

- `pubmed.raw.json`
- `clinicaltrials.raw.json`
- `semantic.raw.json`
- `combined.records.json`
- `manifest.json`
