#!/usr/bin/env python3
"""
Regroup OSM trail relations into consolidated trail groups.

Reads trail relations and member segments from an SQLite database,
groups related relations by proximity, and produces consolidated
output with computed statistics (lat/lon, route_type, sac_scale).

Usage:
    python trails/regroup.py [trails.db]
"""

import sqlite3
import sys
from collections import defaultdict
from typing import Any, Dict, List, Optional, Set, Tuple


# ---------------------------------------------------------------------------
# Coordinate helpers
# ---------------------------------------------------------------------------

def compute_lat_lon_from_members(
    members: List[Dict[str, Any]],
) -> Tuple[Optional[float], Optional[float]]:
    """Compute centroid lat/lon from member segments.

    Returns (lat, lon) or (None, None) if no valid coordinates found.
    """
    lats: List[float] = []
    lons: List[float] = []
    for m in members:
        mlat = m.get("lat")
        mlon = m.get("lon")
        if mlat is not None and mlon is not None:
            try:
                lats.append(float(mlat))
                lons.append(float(mlon))
            except (TypeError, ValueError):
                continue
    if lats and lons:
        return sum(lats) / len(lats), sum(lons) / len(lons)
    return None, None


# ---------------------------------------------------------------------------
# SAC scale helpers
# ---------------------------------------------------------------------------

# SAC scale hierarchy from easiest to hardest
SAC_HIERARCHY: Dict[str, int] = {
    "hiking": 0,
    "mountain_hiking": 1,
    "demanding_mountain_hiking": 2,
    "alpine_hiking": 3,
    "demanding_alpine_hiking": 4,
    "difficult_alpine_hiking": 5,
}


def compute_sac_scale_from_segments(
    segments: List[Dict[str, Any]],
) -> Optional[str]:
    """Derive the highest sac_scale difficulty from member segments."""
    scales = [
        s.get("sac_scale")
        for s in segments
        if s.get("sac_scale") and s.get("sac_scale") in SAC_HIERARCHY
    ]
    if not scales:
        return None
    # Pick the hardest (highest) scale found across segments
    return max(scales, key=lambda s: SAC_HIERARCHY[s])


# ---------------------------------------------------------------------------
# Group building
# ---------------------------------------------------------------------------

def make_group(
    segments: List[Dict[str, Any]],
    route_type: Optional[str] = None,
    lat: Optional[float] = None,
    lon: Optional[float] = None,
    sac_scale: Optional[str] = None,
) -> Dict[str, Any]:
    """Create a consolidated trail group from member segments.

    - route_type: curated OSM relation type (takes priority over
      member-derived trail_type).
    - lat/lon: relation coordinates (takes priority over
      member-computed centroid).
    - sac_scale: if not provided, derived from member segments so
      clustered groups don't silently lose this field.
    """
    # Count trail types from segments to derive a fallback type
    type_counts: Dict[str, int] = defaultdict(int)
    for s in segments:
        tt = s.get("trail_type")
        if tt:
            type_counts[tt] += 1

    # Most common member trail_type (fallback only)
    derived_type: Optional[str] = None
    if type_counts:
        derived_type = max(type_counts, key=type_counts.get)

    # Curated route_type takes priority over member-derived trail_type
    final_type = route_type or derived_type

    # Derive sac_scale from segments when not explicitly provided
    final_sac = sac_scale if sac_scale else compute_sac_scale_from_segments(segments)

    # Use relation coords when available, fall back to member centroid
    final_lat, final_lon = lat, lon
    if final_lat is None or final_lon is None:
        final_lat, final_lon = compute_lat_lon_from_members(segments)

    return {
        "segments": segments,
        "route_type": final_type,
        "lat": final_lat,
        "lon": final_lon,
        "sac_scale": final_sac,
        "segment_count": len(segments),
    }


# ---------------------------------------------------------------------------
# Database helpers
# ---------------------------------------------------------------------------

def fetch_relations(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Return all trail relations with id, lat, lon, route_type, and tags."""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, lat, lon, route_type, tags FROM relations"
    ).fetchall()
    return [dict(r) for r in rows]


def fetch_segments(conn: sqlite3.Connection) -> List[Dict[str, Any]]:
    """Return all member segments with their relation_id."""
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT relation_id, id, lat, lon, trail_type, sac_scale "
        "FROM segments"
    ).fetchall()
    return [dict(r) for r in rows]


def total_segment_count(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT COUNT(*) FROM segments").fetchone()
    return row[0] if row else 0


# ---------------------------------------------------------------------------
# Phase 1 – proximity-based relation grouping
# ---------------------------------------------------------------------------

def group_relations_by_proximity(
    relations: List[Dict[str, Any]],
    proximity_deg: float = 0.005,
) -> Tuple[List[List[Dict[str, Any]]], Set[int]]:
    """Group relations that are within ~proximity_deg of each other.

    Returns (groups, claimed_ids) where claimed_ids contains every
    relation id that was assigned to a group.
    """
    groups: List[List[Dict[str, Any]]] = []
    claimed_ids: Set[int] = set()

    for rel in relations:
        if rel["id"] in claimed_ids:
            continue

        group = [rel]
        claimed_ids.add(rel["id"])

        rel_lat = rel.get("lat")
        rel_lon = rel.get("lon")

        for other in relations:
            if other["id"] in claimed_ids:
                continue
            other_lat = other.get("lat")
            other_lon = other.get("lon")
            if (
                rel_lat is not None
                and rel_lon is not None
                and other_lat is not None
                and other_lon is not None
            ):
                dlat = abs(rel_lat - other_lat)
                dlon = abs(rel_lon - other_lon)
                if dlat < proximity_deg and dlon < proximity_deg:
                    group.append(other)
                    claimed_ids.add(other["id"])

        groups.append(group)

    return groups, claimed_ids


# ---------------------------------------------------------------------------
# Phase 2 – build consolidated groups
# ---------------------------------------------------------------------------

def build_consolidated_groups(
    phase1_groups: List[List[Dict[str, Any]]],
    rel_segments: Dict[int, List[Dict[str, Any]]],
) -> List[Dict[str, Any]]:
    """Build final trail groups from Phase 1 relation clusters.

    For each cluster of relations, gathers all member segments and
    determines best route_type, lat/lon, and sac_scale following
    the priority rules (curated > derived).
    """
    groups: List[Dict[str, Any]] = []

    for rel_group in phase1_groups:
        all_segments: List[Dict[str, Any]] = []
        best_route_type: Optional[str] = None
        best_lat: Optional[float] = None
        best_lon: Optional[float] = None
        best_sac: Optional[str] = None

        for rel in rel_group:
            segs = rel_segments.get(rel["id"], [])
            all_segments.extend(segs)

            # Use the first relation's lat/lon as the authoritative position
            if best_lat is None and rel.get("lat") is not None:
                best_lat = float(rel["lat"])
                best_lon = float(rel["lon"]) if rel.get("lon") is not None else None

            # Curated route_type from the first relation that has one
            if best_route_type is None and rel.get("route_type"):
                best_route_type = rel["route_type"]

            # Curated sac_scale from the first relation that has one
            if best_sac is None and rel.get("sac_scale"):
                best_sac = rel["sac_scale"]

        if all_segments:
            group = make_group(
                all_segments,
                route_type=best_route_type,
                lat=best_lat,
                lon=best_lon,
                sac_scale=best_sac,
            )
            groups.append(group)

    return groups


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main() -> None:
    db_path = sys.argv[1] if len(sys.argv) > 1 else "trails.db"

    conn: Optional[sqlite3.Connection] = None
    try:
        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row

        # ------------------------------------------------------------------
        # Load data
        # ------------------------------------------------------------------

        relations = fetch_relations(conn)
        segments = fetch_segments(conn)

        if not relations:
            print("No trail relations found in database.")
            return

        # Build lookup: relation_id → list of member segments
        rel_segments: Dict[int, List[Dict[str, Any]]] = defaultdict(list)
        for s in segments:
            rid = s.get("relation_id")
            if rid is not None:
                rel_segments[rid].append(s)

        # ------------------------------------------------------------------
        # Phase 1 – proximity-based grouping of relations
        # ------------------------------------------------------------------

        phase1_groups, claimed_ids = group_relations_by_proximity(relations)
        phase1_group_count = len(phase1_groups)

        # ------------------------------------------------------------------
        # Phase 2 – build consolidated trail groups
        # ------------------------------------------------------------------

        groups = build_consolidated_groups(phase1_groups, rel_segments)
        phase2_group_count = len(groups)

        # ------------------------------------------------------------------
        # Identify unnamed segments (not attached to any relation)
        # ------------------------------------------------------------------

        all_seg_ids: Set[int] = {s["id"] for s in segments}
        grouped_seg_ids: Set[int] = set()
        for g in groups:
            for s in g["segments"]:
                sid = s.get("id")
                if sid is not None:
                    grouped_seg_ids.add(sid)
        unnamed_ids = all_seg_ids - grouped_seg_ids

        # ------------------------------------------------------------------
        # Summary
        # ------------------------------------------------------------------

        total_segs = total_segment_count(conn)

        # Relations that were NOT claimed in Phase 1 (skipped / empty)
        unclaimed_relation_count = len(relations) - len(claimed_ids)

        # Clustered segments = total minus unnamed minus segments from
        # unclaimed relations (whose segments are effectively orphaned)
        orphaned_seg_count: int = 0
        for rel in relations:
            if rel["id"] not in claimed_ids:
                orphaned_seg_count += len(rel_segments.get(rel["id"], []))

        clustered = total_segs - len(unnamed_ids) - orphaned_seg_count

        print(f"OSM relations:            {len(relations)}")
        print(f"  Unclaimed (skipped):    {unclaimed_relation_count}")
        print(f"Phase 1 groups:           {phase1_group_count}")
        print(f"Phase 2 groups:           {phase2_group_count}")
        print(f"Clustered segments:       {clustered}")
        print(f"Unnamed segments:         {len(unnamed_ids)}")
        print(f"Total segments:           {total_segs}")
        print(f"Segments with sac_scale:  "
              f"{sum(1 for g in groups if g.get('sac_scale'))} "
              f"/ {phase2_group_count} groups")

    except sqlite3.OperationalError as e:
        print(f"Database error: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        if conn is not None:
            conn.close()


if __name__ == "__main__":
    main()
