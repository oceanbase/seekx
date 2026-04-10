from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from bench.prepare_scifact import (
    filter_qrels,
    filter_topics,
    materialize_docs,
    read_qrels,
    read_queries,
)


class PrepareSciFactTest(unittest.TestCase):
    def test_read_queries_parses_beir_jsonl(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "queries.jsonl"
            path.write_text(
                "\n".join(
                    [
                        json.dumps({"_id": "q1", "text": "claim one"}),
                        json.dumps({"_id": "q2", "text": "claim two"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            topics = read_queries(path)
            self.assertEqual([topic.query_id for topic in topics], ["q1", "q2"])
            self.assertEqual([topic.query for topic in topics], ["claim one", "claim two"])

    def test_read_qrels_parses_tsv_with_header(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            path = Path(tmpdir) / "qrels.tsv"
            path.write_text(
                "query-id\tcorpus-id\tscore\nq1\td1\t1\nq2\td2\t2\n",
                encoding="utf-8",
            )
            qrels = read_qrels(path)
            self.assertEqual(len(qrels), 2)
            self.assertEqual(qrels[0].query_id, "q1")
            self.assertEqual(qrels[1].doc_id, "d2")
            self.assertEqual(qrels[1].relevance, 2)

    def test_filter_topics_and_qrels(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            queries_path = Path(tmpdir) / "queries.jsonl"
            qrels_path = Path(tmpdir) / "qrels.tsv"
            queries_path.write_text(
                "\n".join(
                    [
                        json.dumps({"_id": "q1", "text": "one"}),
                        json.dumps({"_id": "q2", "text": "two"}),
                        json.dumps({"_id": "q3", "text": "three"}),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )
            qrels_path.write_text(
                "query-id\tcorpus-id\tscore\nq2\td2\t1\nq3\td3\t1\n",
                encoding="utf-8",
            )
            topics = filter_topics(read_queries(queries_path), read_qrels(qrels_path), max_queries=1)
            qrels = filter_qrels(read_qrels(qrels_path), topics)
            self.assertEqual([topic.query_id for topic in topics], ["q2"])
            self.assertEqual([(q.query_id, q.doc_id) for q in qrels], [("q2", "d2")])

    def test_materialize_docs_honors_max_docs(self) -> None:
        corpus = [
            {"_id": "d1", "title": "Doc 1", "text": "Alpha"},
            {"_id": "d2", "title": "Doc 2", "text": "Beta"},
        ]
        with tempfile.TemporaryDirectory() as tmpdir:
            stats = materialize_docs(corpus, Path(tmpdir) / "docs", max_docs=1)
            self.assertEqual(stats["processed"], 1)
            self.assertEqual(stats["written"], 1)


if __name__ == "__main__":
    unittest.main()
