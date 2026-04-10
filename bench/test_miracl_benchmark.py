from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

try:
    from miracl_benchmark import (
        aggregate_hits_by_docid,
        decode_docid,
        doc_path_for_docid,
        encode_docid,
        evaluate_trec_run,
        format_trec_run_line,
        load_trec_qrels,
        load_trec_run,
        parse_qrels_tsv,
        parse_topics_tsv,
    )
except ImportError:
    from bench.miracl_benchmark import (
        aggregate_hits_by_docid,
        decode_docid,
        doc_path_for_docid,
        encode_docid,
        evaluate_trec_run,
        format_trec_run_line,
        load_trec_qrels,
        load_trec_run,
        parse_qrels_tsv,
        parse_topics_tsv,
    )


class MiraclBenchmarkHelpersTest(unittest.TestCase):
    def test_docid_codec_is_reversible(self) -> None:
        docid = "12345#67"
        encoded = encode_docid(docid)
        self.assertNotIn("#", encoded)
        self.assertEqual(decode_docid(encoded), docid)
        self.assertEqual(doc_path_for_docid(docid).suffix, ".txt")

    def test_parse_topics_tsv(self) -> None:
        topics = parse_topics_tsv("1\tfirst query\n2\tsecond query\n")
        self.assertEqual([topic.query_id for topic in topics], ["1", "2"])
        self.assertEqual([topic.query for topic in topics], ["first query", "second query"])

    def test_parse_qrels_tsv(self) -> None:
        qrels = parse_qrels_tsv("1 Q0 docA 2\n1 Q0 docB 0\n")
        self.assertEqual(len(qrels), 2)
        self.assertEqual(qrels[0].doc_id, "docA")
        self.assertEqual(qrels[0].relevance, 2)

    def test_aggregate_hits_by_docid_keeps_best_chunk_per_doc(self) -> None:
        doc1_path = str(doc_path_for_docid("doc#1"))
        doc2_path = str(doc_path_for_docid("doc#2"))
        hits = [
            {"file": doc1_path, "score": 0.3, "chunk_id": 11},
            {"file": doc1_path, "score": 0.8, "chunk_id": 12},
            {"file": doc2_path, "score": 0.7, "chunk_id": 21},
        ]
        aggregated = aggregate_hits_by_docid(hits, limit=10)
        self.assertEqual([row["doc_id"] for row in aggregated], ["doc#1", "doc#2"])
        self.assertEqual(aggregated[0]["chunk_id"], 12)
        self.assertEqual(aggregated[0]["rank"], 1)
        self.assertEqual(aggregated[1]["rank"], 2)

    def test_format_trec_run_line(self) -> None:
        line = format_trec_run_line("q1", "doc#1", 3, 0.75, "seekx-hybrid")
        self.assertEqual(line, "q1 Q0 doc#1 3 0.7500000000 seekx-hybrid")

    def test_load_trec_files_and_evaluate(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            qrels_path = root / "qrels.tsv"
            run_path = root / "run.trec"
            qrels_path.write_text("q1 Q0 doc#1 2\nq1 Q0 doc#2 0\nq2 Q0 doc#3 1\n", encoding="utf-8")
            run_path.write_text(
                "\n".join(
                    [
                        format_trec_run_line("q1", "doc#1", 1, 1.0, "sys"),
                        format_trec_run_line("q2", "doc#X", 1, 0.9, "sys"),
                        format_trec_run_line("q2", "doc#3", 2, 0.8, "sys"),
                    ]
                )
                + "\n",
                encoding="utf-8",
            )

            qrels = load_trec_qrels(qrels_path)
            run = load_trec_run(run_path)
            metrics = evaluate_trec_run(run, qrels, ndcg_k=10, recall_k=100)

            self.assertEqual(sorted(run.keys()), ["q1", "q2"])
            self.assertIn("ndcg_cut_10", metrics)
            self.assertIn("recall_100", metrics)
            self.assertGreater(metrics["ndcg_cut_10"], 0.5)
            self.assertEqual(metrics["num_queries"], 2.0)

    def test_load_trec_qrels_accepts_beir_three_column_format(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            root = Path(tmpdir)
            qrels_path = root / "qrels.tsv"
            qrels_path.write_text("query-id\tcorpus-id\tscore\nq1\td1\t1\n", encoding="utf-8")
            qrels = load_trec_qrels(qrels_path)
            self.assertEqual(qrels, {"q1": {"d1": 1}})


if __name__ == "__main__":
    unittest.main()
