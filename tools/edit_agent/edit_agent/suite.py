"""Run the test cases in a cases file: one first pass per view, then a table.

  python -m edit_agent.suite [cases/removal.json] [--only exterior-bins] [--preset 720]

Only the request and the view come from the file; every step runs untouched. Each run gets its usual
folder under data/edit_agent/runs/, and the table is saved next to them as <time>-suite.json.
"""
import argparse
import json
from datetime import datetime
from pathlib import Path

from edit_agent.config import PRESETS, RUNS
from edit_agent.graph import graph

CASES = Path(__file__).resolve().parents[1] / "cases" / "removal.json"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("cases", nargs="?", default=str(CASES))
    ap.add_argument("--only", help="run only the case with this name")
    ap.add_argument("--preset", choices=list(PRESETS), help="default: the preset named in the cases file")
    args = ap.parse_args()
    suite = json.loads(Path(args.cases).read_text(encoding="utf-8"))
    preset = args.preset or suite.get("preset")

    rows = []
    for case in suite["cases"]:
        if args.only and case["name"] != args.only:
            continue
        for view in case["views"]:
            name = f"suite-{case['name']}-p{view['pano']}"
            state = {"request": case["request"], "preset": preset, "name": name,
                     "scan": {"model": case["scan"], **view}}
            final = {}
            for mode, chunk in graph.stream(state, stream_mode=["custom", "values"]):
                if mode == "values":
                    final = chunk
            result = final["report"]
            seconds = {step: t["seconds"] for step, t in final["timings"].items()}
            rows.append({"name": name, "verdict": result["verdict"], "issues": [i["kind"] for i in result["issues"]],
                         "notes": [i["kind"] for i in result["notes"]], "total": round(sum(seconds.values()), 1),
                         "seconds": seconds, "scores": result["scores"], "run_dir": final["run_dir"]})
            row = rows[-1]
            print(f"{name:32s} {row['verdict'].upper():4s} {row['total']:5.1f} s  "
                  + " ".join(f"{step} {s}" for step, s in seconds.items())
                  + (f"  issues: {', '.join(row['issues'])}" if row["issues"] else ""), flush=True)

    out = RUNS / f"{datetime.now():%Y%m%d-%H%M%S}-suite.json"
    out.write_text(json.dumps({"cases": str(args.cases), "preset": preset, "runs": rows}, indent=2), encoding="utf-8")
    print(f"\n{len(rows)} run(s), {round(sum(r['total'] for r in rows), 1)} s in all. Table: {out}")


if __name__ == "__main__":
    main()
