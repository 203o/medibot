from __future__ import annotations

from typing import Any
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import xml.etree.ElementTree as ET
import json

from ingestion_api.services.evidence_extraction import extract_evidence_sentences


BASE_URL = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils"


def _get_json(url: str) -> dict[str, Any]:
    request = Request(url, headers={"User-Agent": "medibot-fastapi-ingestion"})
    with urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def _get_xml(url: str) -> ET.Element:
    request = Request(url, headers={"User-Agent": "medibot-fastapi-ingestion"})
    with urlopen(request, timeout=30) as response:
        return ET.fromstring(response.read())


def _build_url(path: str, params: dict[str, str]) -> str:
    return f"{BASE_URL}/{path}?{urlencode(params)}"


def _text_list(parent: ET.Element, path: str) -> list[str]:
    return [node.text.strip() for node in parent.findall(path) if node.text and node.text.strip()]


def search_pubmed(queries: list[str], keywords: list[str], max_results: int, tool: str, email: str) -> dict[str, Any]:
    attempted_queries: list[dict[str, Any]] = []
    search_payload: dict[str, Any] = {}
    id_list: list[str] = []
    selected_query = ""

    for query in queries:
        if not query.strip():
            continue
        search_url = _build_url(
            "esearch.fcgi",
            {
                "db": "pubmed",
                "term": query,
                "retmode": "json",
                "retmax": str(max_results),
                "sort": "relevance",
                "tool": tool,
                "email": email,
            },
        )
        search_payload = _get_json(search_url)
        id_list = search_payload.get("esearchresult", {}).get("idlist", [])
        attempted_queries.append({"query": query, "count": len(id_list)})
        if id_list:
            selected_query = query
            break

    if not id_list:
        return {
            "query": queries[0] if queries else "",
            "selected_query": selected_query,
            "attempted_queries": attempted_queries,
            "id_list": [],
            "records": [],
            "search_payload": search_payload,
        }

    fetch_url = _build_url(
        "efetch.fcgi",
        {
            "db": "pubmed",
            "id": ",".join(id_list),
            "retmode": "xml",
            "tool": tool,
            "email": email,
        },
    )
    root = _get_xml(fetch_url)
    records: list[dict[str, Any]] = []

    for article in root.findall(".//PubmedArticle"):
        medline = article.find("MedlineCitation")
        if medline is None:
            continue

        pmid = medline.findtext("PMID", default="").strip()
        article_node = medline.find("Article")
        if article_node is None:
            continue

        title = "".join(article_node.findtext("ArticleTitle", default="")).strip()
        journal = article_node.findtext("Journal/Title", default="").strip()
        abstract_sections = _text_list(article_node, "Abstract/AbstractText")
        authors = []
        for author in article_node.findall("AuthorList/Author"):
            last_name = author.findtext("LastName", default="").strip()
            fore_name = author.findtext("ForeName", default="").strip()
            collective = author.findtext("CollectiveName", default="").strip()
            full_name = collective or " ".join(part for part in [fore_name, last_name] if part)
            if full_name:
                authors.append(full_name)

        pub_year = (
            article_node.findtext("Journal/JournalIssue/PubDate/Year")
            or article_node.findtext("Journal/JournalIssue/PubDate/MedlineDate", default="")[:4]
        )
        publication_types = _text_list(article_node, "PublicationTypeList/PublicationType")
        joined_abstract = "\n\n".join(abstract_sections)

        records.append(
            {
                "pmid": pmid,
                "title": title,
                "journal": journal,
                "abstract_sections": abstract_sections,
                "abstract": joined_abstract,
                "evidence_sentences": extract_evidence_sentences(joined_abstract, keywords),
                "publication_types": publication_types,
                "query_keywords": keywords,
                "authors": authors,
                "year": pub_year,
                "source_url": f"https://pubmed.ncbi.nlm.nih.gov/{pmid}/" if pmid else "",
            }
        )

    return {
        "query": queries[0] if queries else "",
        "selected_query": selected_query,
        "attempted_queries": attempted_queries,
        "id_list": id_list,
        "records": records,
        "search_payload": search_payload,
    }
