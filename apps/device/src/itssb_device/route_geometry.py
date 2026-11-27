"""Geometry for recorded route paths (docs/05 §6).

Maps draw straight segments between recorded points and never snap them to
roads, so the recorded points themselves must follow the road: dense on
curves, a point at every corner, and nothing invented. Thinning removes only
points that sit on a straight run (within a few metres of the line through
their neighbours); corners and gap edges are never removed.
"""

from __future__ import annotations

import itertools
import math
from collections.abc import Sequence

EARTH_RADIUS_M = 6_371_008.8


def distance_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Great-circle distance (haversine)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = p2 - p1, math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def bearing_deg(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Initial bearing from point 1 to point 2, 0-360 (0 = north)."""
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dl = math.radians(lon2 - lon1)
    y = math.sin(dl) * math.cos(p2)
    x = math.cos(p1) * math.sin(p2) - math.sin(p1) * math.cos(p2) * math.cos(dl)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def heading_change_deg(a: float, b: float) -> float:
    """Smallest absolute difference between two headings (0-180)."""
    d = abs(a - b) % 360
    return 360 - d if d > 180 else d


def simplify(
    points: Sequence[tuple[float, float]],
    tolerance_m: float,
    protected: set[int] | None = None,
    max_segment_m: float | None = None,
) -> list[int]:
    """Douglas-Peucker on (lat, lon) points. Returns the indices to keep, in
    order. First, last, and `protected` indices are always kept, and they
    split the path so no straight-run test ever spans a corner. With
    `max_segment_m`, a straight run is still split until no kept segment is
    longer than that (staff review flags long gaps between points)."""
    n = len(points)
    if n <= 2:
        return list(range(n))
    lat0 = math.radians(points[0][0])
    k = math.cos(lat0)
    # Local metric projection: accurate to well under a metre over a bus route.
    xy = [
        (math.radians(lon) * k * EARTH_RADIUS_M, math.radians(lat) * EARTH_RADIUS_M)
        for lat, lon in points
    ]
    anchors = sorted({0, n - 1} | {i for i in (protected or set()) if 0 <= i < n})
    keep = set(anchors)
    for start, end in itertools.pairwise(anchors):
        stack = [(start, end)]
        while stack:
            s, e = stack.pop()
            if e - s < 2:
                continue
            (x1, y1), (x2, y2) = xy[s], xy[e]
            dx, dy = x2 - x1, y2 - y1
            seg = math.hypot(dx, dy)
            far, far_d = -1, -1.0
            for i in range(s + 1, e):
                px, py = xy[i]
                if seg == 0:
                    d = math.hypot(px - x1, py - y1)
                else:
                    d = abs(dy * px - dx * py + x2 * y1 - y2 * x1) / seg
                if d > far_d:
                    far, far_d = i, d
            if far_d <= tolerance_m and max_segment_m is not None and seg > max_segment_m:
                far, far_d = (s + e) // 2, math.inf  # straight but too long: split it
            if far_d > tolerance_m:
                keep.add(far)
                stack.append((s, far))
                stack.append((far, e))
    return sorted(keep)
