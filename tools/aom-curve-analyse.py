#!/usr/bin/env python3
"""Read an aom-curve.sh TSV and answer the only question it was run to answer:
how many bytes does each encoder need for the same quality?

Comparing rows at equal CRF proves nothing -- libaom's and SVT-AV1's CRF scales
are unrelated. The comparison has to be made at matched quality, which means
interpolating each arm's own curve and reading bytes off it.

Two metrics, deliberately:

  mean  -- what a tier targets, and what every previous AOM claim was based on
  5pct  -- the 5th percentile frame, which is what a QUALITY-FIRST tier is
           actually buying. An encoder that averages well and collapses on hard
           frames looks fine on the mean and bad here, and that difference is
           the entire question for a top tier.

Usage:  aom-curve-analyse.py curve.tsv [--baseline svt_p4]
"""
import argparse
import math
from collections import defaultdict


def load(path):
    rows = []
    with open(path) as fh:
        for i, line in enumerate(fh):
            f = line.rstrip("\n").split("\t")
            if i == 0 or len(f) < 11 or f[8] in ("NA", ""):
                continue
            try:
                rows.append(dict(clip=f[0], arm=f[1], crf=int(f[2]),
                                 bytes=int(f[6]), offset=f[7],
                                 mean=float(f[8]), p5=float(f[9]), mn=float(f[10])))
            except ValueError:
                continue
    return rows


def bytes_at(points, metric, q):
    """Bytes needed for quality q on one arm's curve.

    Interpolates linearly in log(bytes) against quality: rate-quality curves are
    close to straight in that space, so this is far more accurate near the ends
    than interpolating raw bytes. Returns (bytes, is_interpolated) -- an
    extrapolated value is a hint, not evidence, and callers must mark it.
    """
    pts = sorted(points, key=lambda r: r[metric])
    if len(pts) < 2:
        return None, False
    lo = hi = None
    for a, b in zip(pts, pts[1:]):
        if a[metric] <= q <= b[metric]:
            lo, hi = a, b
            break
    inside = lo is not None
    if not inside:
        lo, hi = (pts[-2], pts[-1]) if q > pts[-1][metric] else (pts[0], pts[1])
    dq = hi[metric] - lo[metric]
    if dq == 0:
        return lo["bytes"], inside
    la, lb = math.log(lo["bytes"]), math.log(hi["bytes"])
    return math.exp(la + (lb - la) * (q - lo[metric]) / dq), inside


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("tsv")
    ap.add_argument("--baseline", default="svt_p4",
                    help="arm everything is expressed as a percentage of")
    args = ap.parse_args()

    rows = load(args.tsv)
    if not rows:
        raise SystemExit("no usable rows -- check for UNALIGNED/ENCODE_FAILED")

    by = defaultdict(list)
    for r in rows:
        by[(r["clip"], r["arm"])].append(r)

    clips = sorted({r["clip"] for r in rows})
    arms = sorted({r["arm"] for r in rows})

    for clip in clips:
        base_pts = by.get((clip, args.baseline))
        if not base_pts:
            print(f"\n{clip}: no baseline arm {args.baseline}, skipping")
            continue
        print(f"\n{'=' * 74}\n{clip}   (bytes at matched quality, "
              f"% of {args.baseline})\n{'=' * 74}")

        for metric, label in (("mean", "MEAN"), ("p5", "5th PERCENTILE")):
            lo = max(min(p[metric] for p in pts) for pts in
                     (by[(clip, a)] for a in arms if (clip, a) in by))
            hi = min(max(p[metric] for p in pts) for pts in
                     (by[(clip, a)] for a in arms if (clip, a) in by))
            targets = [q for q in range(60, 96, 2) if lo <= q <= hi]
            if not targets:
                print(f"\n  {label}: arms do not overlap in quality, cannot compare")
                continue
            print(f"\n  {label} SSIMULACRA2   (overlap {lo:.1f}-{hi:.1f})")
            width = max(len(a) for a in arms)
            header = "    target  " + "  ".join(f"{a:>{width + 9}}" for a in arms)
            print(header)
            for q in targets:
                b_base, _ = bytes_at(base_pts, metric, q)
                cells = []
                for a in arms:
                    pts = by.get((clip, a))
                    if not pts:
                        cells.append(f"{'-':>{width + 9}}")
                        continue
                    b, inside = bytes_at(pts, metric, q)
                    mark = "" if inside else "*"
                    cells.append(f"{b / 1e6:6.2f}MB{mark:1s}{b / b_base * 100:6.1f}%"
                                 .rjust(width + 9))
                print(f"    {q:>6}  " + "  ".join(cells))

    print("\n* extrapolated beyond that arm's measured points -- indicative only")

    print(f"\n{'=' * 74}\nCONSISTENCY  (mean minus worst frame; smaller is better)\n{'=' * 74}")
    for clip in clips:
        for arm in arms:
            pts = sorted(by.get((clip, arm), []), key=lambda r: r["crf"])
            if not pts:
                continue
            spreads = " ".join(f"crf{p['crf']}:{p['mean'] - p['mn']:5.2f}" for p in pts)
            print(f"  {clip:9s} {arm:14s} {spreads}")

    print(f"\n{'=' * 74}\nRAW\n{'=' * 74}")
    for r in sorted(rows, key=lambda r: (r["clip"], r["arm"], r["crf"])):
        print(f"  {r['clip']:9s} {r['arm']:14s} crf{r['crf']:<3d} "
              f"{r['bytes'] / 1e6:7.2f}MB  mean {r['mean']:6.2f}  "
              f"5pct {r['p5']:6.2f}  min {r['mn']:6.2f}  off {r['offset']}")


if __name__ == "__main__":
    main()
