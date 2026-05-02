#!/usr/bin/env python3
"""
Enrich cycling segments with elevation data from SRTM 1-arcsecond DEM.

Reads segments from cycling.db, samples elevation along actual geometry
paths, and computes cumulative gain, loss, min, max, average elevation,
and sample count.  Designed for ~82K segments; uses in-memory SRTM tile
caching, WAL-mode SQLite, and batched commits for throughput.

geometry_json is expected as a JSON array of [lon, lat] pairs, e.g.:
    [[-105.27, 40.01], [-105.28, 40.02], ...]

SRTM .hgt files should live in ./srtm/ (override with --srtm-dir).

Usage:
    python enrich-elevation.py [--dry-run] [--limit N] [--offset N]
"""

from __future__ import annotations

import argparse
import json
import logging
import math
import os
import re
import sqlite3
import struct
import sys
import time
from pathlib import Path
from typing import Dict, List, NamedTuple, Optional, Sequence, Tuple

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DB_DEFAULT = Path(os.environ.get("CYCLING_DB", "cycling.db"))
SRTM_DIR_DEFAULT = Path(os.environ.get("SRTM_DIR", "srtm"))

SAMPLING_INTERVAL_M = float(os.environ.get("SAMPLING_INTERVAL_M", 15.0))
BATCH_SIZE = int(os.environ.get("BATCH_SIZE", 500))
COMMIT_EVERY = int(os.environ.get("COMMIT_EVERY", 2000))

EARTH_RADIUS_M = 6_371_000.0  # WGS-84 mean radius
SRTM_SIZE = 3601              # 1-arcsecond tile dimension
SRTM_NODATA = -32768          # sea / no-coverage sentinel
MAX_TILE_CACHE = 16           # ~26 MB per tile → ~400 MB worst case

# --- Tunables ---------------------------------------------------------------

# Half a tile degree (0.5°) padding added to bounding boxes when preloading
# so that edge-crossing geometries don't miss a neighbouring tile.
TILE_PAD = 0.5

# Fraction of missing elevation samples above which we refuse to write
# partial metrics (the result would be misleading).
MAX_MISSING_FRACTION = 0.5

# Regex for SRTM filenames:  N30W100  S05E120  etc.
TILE_NAME_RE = re.compile(r"^([NS])(\d{2})([EW])(\d{3})$", re.IGNORECASE)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)-7s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("enrich-elevation")


# ===================================================================
# 1.  Geometry parsing & sampling
# ===================================================================

def _parse_point(item) -> Optional[Tuple[float, float]]:
    """Try to extract a (lon, lat) pair from a single geometry item.

    Accepts:
      - [lon, lat]        (list or tuple of 2+ numbers)
      - [lon, lat, z]     (3D — Z coordinate is silently discarded)
      - {"lon": x, "lat": y}  or  {"lng"/"longitude", "lat"/"latitude"}

    Returns (lon, lat) or None.
    """
    if isinstance(item, (list, tuple)) and len(item) >= 2:
        # Nested structure (e.g. MultiLineString ring) — not a flat point.
        # Recurse into the first element to see if it's a coordinate.
        if isinstance(item[0], (list, tuple)):
            return _parse_point(item[0])
        try:
            # Only the first two elements are used; 3D/4D coords (Z, M)
            # are deliberately ignored as SRTM provides our Z values.
            return (float(item[0]), float(item[1]))
        except (TypeError, ValueError):
            return None

    if isinstance(item, dict):
        lon = item.get("lon")
        if lon is None:
            lon = item.get("lng")
        if lon is None:
            lon = item.get("longitude")
        lat = item.get("lat")
        if lat is None:
            lat = item.get("latitude")
        if lon is not None and lat is not None:
            try:
                return (float(lon), float(lat))
            except (TypeError, ValueError):
                pass
    return None


def parse_geometry(raw: Optional[str]) -> Optional[List[Tuple[float, float]]]:
    """Parse ``geometry_json`` column into a list of (lon, lat) pairs.

    Handles:
      - Simple linestring:          [[lon,lat], [lon,lat], ...]
      - MultiLineString / Polygon:  [[[lon,lat],...], [[lon,lat],...]]

    For genuine MultiLineString geometries each ring is a separate path
    segment; for Polygon geometries only the outer ring is used (inner
    rings are holes and are not sampled as navigable paths).

    Returns *None* for any input that can't produce a valid 2+ point path.
    """
    if not raw or not raw.strip():
        return None

    # Fast bail-out: obvious non-JSON (SQL NULLs stored as literal "null")
    stripped = raw.strip()
    if stripped in ("null", "NULL", "None", ""):
        return None
    if not stripped.startswith(("[", "{")):
        return None

    try:
        geom = json.loads(stripped)
    except json.JSONDecodeError:
        log.debug("JSON decode failed for: %.120s", stripped)
        return None

    if not isinstance(geom, list):
        return None

    # Normalise nested GeoJSON geometries (MultiLineString / Polygon)
    # into a flat list of coordinate arrays.
    rings: List[List] = []
    if geom and isinstance(geom[0], list) and geom[0] and isinstance(geom[0][0], (list, tuple)):
        # MultiLineString: [[[lon,lat],...], [[lon,lat],...]]
        # Polygon:         [[[lon,lat],...], [[lon,lat],...]]  (ring(s))
        # MultiPolygon:     [[[[lon,lat],...]], ...]           (rare; skip)
        rings = geom
    else:
        rings = [geom]

    # For cycling segments the first ring is always the desired path.
    # MultiLineString geometries are NOT used by the cycling pipeline,
    # but if one appears the outer ring is the primary path — inner
    # rings of a Polygon are holes and must not be sampled as routes.
    ring = rings[0] if rings else []
    if not ring:
        return None

    points: List[Tuple[float, float]] = []
    for item in ring:
        pt = _parse_point(item)
        if pt is None:
            continue
        # Drop obviously invalid coordinates
        lon, lat = pt
        if not (-180.0 <= lon <= 180.0 and -90.0 <= lat <= 90.0):
            continue
        # Drop consecutive duplicates (common in OSM extracts)
        if points and points[-1] == pt:
            continue
        points.append(pt)

    return points if len(points) >= 2 else None


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Haversine distance in metres between two WGS-84 points."""
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (math.sin(dlat / 2) ** 2
         + math.cos(math.radians(lat1))
         * math.cos(math.radians(lat2))
         * math.sin(dlon / 2) ** 2)
    return 2.0 * EARTH_RADIUS_M * math.asin(math.sqrt(min(a, 1.0)))


def _fast_haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Approximate Haversine for sub-km distances (~0.01% error).

    Normalises the longitude delta to [-π, π] so that paths crossing
    the antimeridian (e.g. 179.9° → -179.9°) produce correct distances
    instead of wrapping the long way around the globe.
    """
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    # Wrap to [-π, π] for antimeridian safety.
    dlon = (dlon + math.pi) % (2.0 * math.pi) - math.pi
    mlat = math.radians((lat1 + lat2) / 2)
    # Equirectangular approximation scaled by cos(lat) for longitude
    dx = dlon * math.cos(mlat)
    dy = dlat
    return EARTH_RADIUS_M * math.sqrt(dx * dx + dy * dy)


def sample_path(
    geometry: List[Tuple[float, float]],
    interval_m: float,
) -> List[Tuple[float, float]]:
    """Walk *geometry* (list of (lon,lat)) and return regularly-spaced
    sample points at *interval_m* along the path.

    The first and last vertex of every sub-segment are always included
    so that the true path envelope is captured.  Consecutive duplicate
    points (from adjacent short segments meeting at a vertex) are
    collapsed.
    """
    if not geometry:
        return []

    sampled: List[Tuple[float, float]] = [(geometry[0][1], geometry[0][0])]

    for i in range(len(geometry) - 1):
        lon0, lat0 = geometry[i]
        lon1, lat1 = geometry[i + 1]

        seg_dist = _fast_haversine_m(lat0, lon0, lat1, lon1)
        if seg_dist < 0.001:          # < 1 mm → skip
            continue

        # Number of sub-intervals (at least 1, so we always reach p1)
        n = max(1, round(seg_dist / interval_m))

        for j in range(1, n + 1):
            t = j / n
            lat = lat0 + t * (lat1 - lat0)
            # Linear interpolation in geographic space is fine for the
            # short (< 100 m) segments 15 m sampling produces.
            lon = lon0 + t * (lon1 - lon0)
            pt = (lat, lon)
            # When two consecutive segments are shorter than the
            # sampling interval, both contribute j=1,t=1 which is the
            # shared vertex.  Skip the duplicate.
            if sampled[-1] != pt:
                sampled.append(pt)

    return sampled


# ===================================================================
# 2.  SRTM tile cache
# ===================================================================

class SrtmTile:
    """A single in-memory SRTM tile with bilinear interpolation."""

    def __init__(self, path: Path) -> None:
        m = TILE_NAME_RE.match(path.stem)
        if not m:
            raise ValueError(f"Unrecognised SRTM filename: {path.name}")

        lat_sign = 1 if m.group(1).upper() == "N" else -1
        lon_sign = 1 if m.group(3).upper() == "E" else -1
        lat_base = int(m.group(2))
        lon_base = int(m.group(4))

        self.lat_min = float(lat_base if lat_sign == 1 else -lat_base)
        self.lat_max = self.lat_min + 1.0
        self.lon_min = float(lon_base if lon_sign == 1 else -lon_base)
        self.lon_max = self.lon_min + 1.0
        self.path = path
        self._data: List[List[int]] = []

    # -- load ----------------------------------------------------------------

    def load(self) -> None:
        raw = self.path.read_bytes()
        size = len(raw)

        if size == SRTM_SIZE * SRTM_SIZE * 2:
            self._load_1arc(raw)
        elif size == 1201 * 1201 * 2:
            log.warning("%s is 3-arcsecond — upsampling", self.path.name)
            self._load_3arc(raw)
        else:
            raise ValueError(
                f"Unexpected file size {size} for {self.path} "
                f"(expected {SRTM_SIZE * SRTM_SIZE * 2} or {1201 * 1201 * 2})"
            )

    def _load_1arc(self, raw: bytes) -> None:
        fmt = f">{SRTM_SIZE}h"
        self._data = [
            list(struct.unpack_from(fmt, raw, r * SRTM_SIZE * 2))
            for r in range(SRTM_SIZE)
        ]

    def _load_3arc(self, raw: bytes) -> None:
        """Nearest-neighbour upsample 1201 → 3601 (factor of 3)."""
        S = 1201
        fmt = f">{S}h"
        src = [
            list(struct.unpack_from(fmt, raw, r * S * 2))
            for r in range(S)
        ]
        self._data = []
        for r in range(SRTM_SIZE):
            sr = min(r // 3, S - 1)
            src_row = src[sr]
            self._data.append([src_row[min(c // 3, S - 1)] for c in range(SRTM_SIZE)])

    # -- lookup --------------------------------------------------------------

    def contains(self, lat: float, lon: float) -> bool:
        return (self.lat_min <= lat < self.lat_max and
                self.lon_min <= lon < self.lon_max)

    def get_elevation(self, lat: float, lon: float) -> Optional[float]:
        """Bilinear interpolation.  Returns *None* for nodata / ocean."""
        if not self._data:
            raise RuntimeError(f"Tile {self.path.name} not loaded")
        if not self.contains(lat, lon):
            return None

        frac_lat = self.lat_max - lat          # 0 at top, 1 at bottom
        frac_lon = lon - self.lon_min          # 0 at left, 1 at right

        row_f = frac_lat * (SRTM_SIZE - 1)
        col_f = frac_lon * (SRTM_SIZE - 1)

        r0 = int(row_f)
        c0 = int(col_f)
        r1 = min(r0 + 1, SRTM_SIZE - 1)
        c1 = min(c0 + 1, SRTM_SIZE - 1)

        dr = row_f - r0
        dc = col_f - c0

        # Gather four corners (None = nodata)
        corners = [
            (self._pixel(r0, c0), (1 - dr) * (1 - dc)),
            (self._pixel(r0, c1), (1 - dr) * dc),
            (self._pixel(r1, c0), dr * (1 - dc)),
            (self._pixel(r1, c1), dr * dc),
        ]

        valid = [(v, w) for v, w in corners if v is not None]
        if not valid:
            return None

        total_w = sum(w for _, w in valid)
        # total_w can only be zero if all corners are nodata (handled
        # above), but we keep this guard as belt-and-suspenders defense
        # against edge cases like a tile with zero-area extent.
        return sum(v * w for v, w in valid) / total_w if total_w > 0 else None

    def _pixel(self, row: int, col: int) -> Optional[float]:
        """Return the elevation value at (row, col) or None for nodata.

        Although ``_data`` stores raw ``int`` values from the HGT file,
        callers receive ``float`` so that elevation is always a uniform
        numeric type.
        """
        v = self._data[row][col]
        return None if v == SRTM_NODATA else float(v)


class SrtmCache:
    """LRU cache of SRTM tiles keyed by canonical filename stem.

    Uses ``collections.OrderedDict`` semantics (Python 3.7+ dict
    insertion order) to implement LRU eviction: on hit the key is
    moved to the MRU end; on eviction the first key (LRU) is dropped.
    """

    def __init__(self, srtm_dir: Path, max_tiles: int = MAX_TILE_CACHE) -> None:
        self._dir = srtm_dir
        self._max = max_tiles
        self._tiles: Dict[str, SrtmTile] = {}

    # -- public API ---------------------------------------------------------

    def get_elevation(self, lat: float, lon: float) -> Optional[float]:
        key = _tile_key(lat, lon)
        tile = self._tiles.get(key)
        if tile is None:
            tile = self._load_tile(key)
            if tile is None:
                return None
        self._touch(key)
        return tile.get_elevation(lat, lon)

    def preload_region(self, lat_min: float, lat_max: float,
                       lon_min: float, lon_max: float) -> None:
        """Eagerly load all tiles that intersect the bounding box.

        A pad of ``TILE_PAD`` degrees is added on each side so that
        geometries straddling tile boundaries always have their
        neighbouring tile available.
        """
        lat_min -= TILE_PAD
        lat_max += TILE_PAD
        lon_min -= TILE_PAD
        lon_max += TILE_PAD
        for lat in range(int(math.floor(lat_min)), int(math.ceil(lat_max))):
            for lon in range(int(math.floor(lon_min)), int(math.ceil(lon_max))):
                self.get_elevation(lat + 0.5, lon + 0.5)

    @property
    def tile_count(self) -> int:
        return len(self._tiles)

    # -- internals ----------------------------------------------------------

    def _touch(self, key: str) -> None:
        """Move *key* to the end (most-recently-used position).

        Pops and re-inserts the key, relying on Python 3.7+ guaranteed
        dict insertion order to maintain LRU ordering.  This is
        equivalent to ``OrderedDict.move_to_end(key)`` but avoids an
        extra import.
        """
        if key in self._tiles:
            tile = self._tiles.pop(key)
            self._tiles[key] = tile

    def _evict_one(self) -> None:
        if not self._tiles:
            return
        # First key in insertion-ordered dict is the LRU entry.
        old = next(iter(self._tiles))
        del self._tiles[old]
        log.debug("Evicted SRTM tile %s", old)

    def _load_tile(self, key: str) -> Optional[SrtmTile]:
        for ext in (".hgt", ".HGT"):
            path = self._dir / f"{key}{ext}"
            if path.is_file():
                try:
                    tile = SrtmTile(path)
                    tile.load()
                except Exception:
                    log.exception("Failed to load %s", path)
                    return None
                if len(self._tiles) >= self._max:
                    self._evict_one()
                self._tiles[key] = tile
                return tile
        return None


def _tile_key(lat: float, lon: float) -> str:
    """Canonical tile stem for (lat, lon):  N30W100  S05E120  etc.

    Uses ``int(math.floor(x))`` rather than ``int(x)`` because the two
    behave differently for negative numbers: ``int(-0.5)`` is ``0``,
    but ``int(math.floor(-0.5))`` is ``-1``.  The floor variant
    correctly maps coordinates to the SRTM tile grid.
    """
    lat_i = int(math.floor(lat))
    lon_i = int(math.floor(lon))

    lat_dir = "S" if lat_i < 0 else "N"
    lon_dir = "W" if lon_i < 0 else "E"

    return f"{lat_dir}{abs(lat_i):02d}{lon_dir}{abs(lon_i):03d}"


# ===================================================================
# 3.  Elevation metrics
# ===================================================================

# Return type for ``compute_metrics`` and ``process_one``.
class ElevationResult(NamedTuple):
    gain_m: float
    loss_m: float
    min_m: float
    max_m: float
    avg_m: float
    sample_count: int


def compute_metrics(
    elevations: Sequence[float],
) -> ElevationResult:
    """Return (gain_m, loss_m, min_m, max_m, avg_m, sample_count).

    *Gain* is the sum of all positive steps between consecutive
    samples; *loss* is the sum of all negative steps (reported as
    a positive number).
    """
    n = len(elevations)
    if n == 0:
        return ElevationResult(0.0, 0.0, 0.0, 0.0, 0.0, 0)

    gain = 0.0
    loss = 0.0
    emin = elevations[0]
    emax = elevations[0]
    esum = elevations[0]
    prev = elevations[0]
    for i in range(1, n):
        e = elevations[i]
        esum += e
        if e < emin:
            emin = e
        if e > emax:
            emax = e
        delta = e - prev
        if delta > 0:
            gain += delta
        elif delta < 0:
            loss -= delta       # loss is positive
        prev = e

    return ElevationResult(gain, loss, emin, emax, esum / n, n)


# ===================================================================
# 4.  Database helpers
# ===================================================================

def ensure_schema(conn: sqlite3.Connection) -> None:
    """Add elevation columns and indexes if they don't exist (idempotent)."""
    wanted = [
        ("elevation_gain_m",        "REAL"),
        ("elevation_loss_m",        "REAL"),
        ("elevation_min_m",         "REAL"),
        ("elevation_max_m",         "REAL"),
        ("elevation_avg_m",         "REAL"),
        ("elevation_sample_count",  "INTEGER"),
        ("elevation_error",         "TEXT"),
    ]
    existing = {r[1] for r in conn.execute("PRAGMA table_info(segments)")}
    for col, typ in wanted:
        if col not in existing:
            log.info("Adding column %s %s", col, typ)
            conn.execute(f"ALTER TABLE segments ADD COLUMN {col} {typ}")

    # Partial index to accelerate the fetch_pending() query — without
    # this, the WHERE elevation_gain_m IS NULL filter degrades to a
    # full table scan as more rows are enriched.
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_segments_elev_null "
        "ON segments(elevation_gain_m) WHERE elevation_gain_m IS NULL"
    )

    conn.commit()


def fetch_pending(
    conn: sqlite3.Connection,
    limit: int,
    offset: int,
) -> List[Tuple[int, str]]:
    """Return (id, geometry_json) rows not yet enriched."""
    return conn.execute(
        """
        SELECT id, geometry_json
        FROM segments
        WHERE geometry_json IS NOT NULL
          AND trim(geometry_json) NOT IN ('', 'null', 'NULL', 'None')
          AND elevation_gain_m IS NULL
        ORDER BY id
        LIMIT ? OFFSET ?
        """,
        (limit, offset),
    ).fetchall()


def count_pending(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """
        SELECT COUNT(*)
        FROM segments
        WHERE geometry_json IS NOT NULL
          AND trim(geometry_json) NOT IN ('', 'null', 'NULL', 'None')
          AND elevation_gain_m IS NULL
        """
    ).fetchone()
    return row[0] if row else 0


# ---------------------------------------------------------------------------
# Batch update – many rows in one call for speed
# ---------------------------------------------------------------------------

def batch_update(conn: sqlite3.Connection, rows: List[Tuple]) -> None:
    """Write a batch of elevation results to the database."""
    conn.executemany(
        """
        UPDATE segments
        SET elevation_gain_m        = ?,
            elevation_loss_m        = ?,
            elevation_min_m         = ?,
            elevation_max_m         = ?,
            elevation_avg_m         = ?,
            elevation_sample_count  = ?,
            elevation_error         = ?
        WHERE id = ?
        """,
        rows,
    )


# ===================================================================
# 5.  Single-segment processing
# ===================================================================

def process_one(
    seg_id: int,
    geom_raw: str,
    cache: SrtmCache,
    interval_m: float,
) -> Tuple[int, float, float, float, float, float, int, Optional[str]]:
    """Process one segment → (id, gain, loss, min, max, avg, n, err)."""
    try:
        geom = parse_geometry(geom_raw)
        if geom is None:
            return (seg_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0,
                    "Invalid or empty geometry")

        sampled = sample_path(geom, interval_m)
        if len(sampled) < 2:
            return (seg_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0,
                    "Too few sample points")

        elevations: List[float] = []
        missing = 0
        for lat, lon in sampled:
            e = cache.get_elevation(lat, lon)
            if e is not None:
                elevations.append(e)
            else:
                missing += 1

        if not elevations:
            return (seg_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0,
                    "No elevation data available for path")

        if missing > len(sampled) * MAX_MISSING_FRACTION:
            # More than MAX_MISSING_FRACTION of the points are over
            # water / no coverage.  Don't write partial metrics — they
            # would be misleading.
            return (seg_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0,
                    f"Majority of points ({missing}/{len(sampled)}) "
                    "lack elevation")

        err = None

        result = compute_metrics(elevations)

        return (seg_id,
                round(result.gain_m, 1), round(result.loss_m, 1),
                round(result.min_m, 1), round(result.max_m, 1),
                round(result.avg_m, 1), result.sample_count, err)

    except Exception as exc:
        log.debug("Segment %d failed", seg_id, exc_info=True)
        msg = str(exc)[:200]
        return (seg_id, 0.0, 0.0, 0.0, 0.0, 0.0, 0, msg)


# ===================================================================
# 6.  Main
# ===================================================================

def main() -> None:
    p = argparse.ArgumentParser(
        description="Enrich cycling segments with SRTM elevation data"
    )
    p.add_argument("--dry-run", action="store_true",
                   help="Process but do not write to database")
    p.add_argument("--limit", type=int, default=0,
                   help="Max segments to process (0 = unlimited)")
    p.add_argument("--offset", type=int, default=0,
                   help="Skip first N pending segments")
    p.add_argument("--db", type=str, default=str(DB_DEFAULT),
                   help="Path to cycling.db")
    p.add_argument("--srtm-dir", type=str, default=str(SRTM_DIR_DEFAULT),
                   help="Directory containing .hgt files")
    p.add_argument("--interval", type=float, default=SAMPLING_INTERVAL_M,
                   help="Path sampling interval in metres (default 15)")
    p.add_argument("--preload", action="store_true",
                   help="Preload all SRTM tiles covering segment bbox")
    p.add_argument("-v", "--verbose", action="store_true")
    args = p.parse_args()

    if args.verbose:
        logging.getLogger().setLevel(logging.DEBUG)

    db_path = Path(args.db)
    srtm_dir = Path(args.srtm_dir)

    if not db_path.is_file():
        log.error("Database not found: %s", db_path)
        sys.exit(1)
    if not srtm_dir.is_dir():
        log.error("SRTM directory not found: %s", srtm_dir)
        log.error("Download 1-arcsecond tiles from e.g. "
                  "https://dwtkns.com/srtm/ or https://step.esa.int")
        sys.exit(1)

    # ------------------------------------------------------------------
    # DB setup
    # ------------------------------------------------------------------

    conn = sqlite3.connect(str(db_path))
    # Performance pragmas for bulk writes
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA cache_size=-64000")   # 64 MB page cache
    conn.execute("PRAGMA busy_timeout=5000")

    try:
        ensure_schema(conn)
        total = count_pending(conn)
        if args.limit and args.limit < total:
            total = args.limit
        if total == 0:
            log.info("All segments already have elevation data. Nothing to do.")
            return

        log.info("Segments pending: %d", total)

        # ------------------------------------------------------------------
        # SRTM cache
        # ------------------------------------------------------------------

        cache = SrtmCache(srtm_dir)

        if args.preload:
            log.info("Preloading SRTM tiles covering segment bounding box …")
            # Compute the true bounding box by parsing every pending
            # geometry.  For 80K+ segments this takes a few seconds but
            # avoids missing tiles for dispersed trails.
            lat_min = float("inf")
            lat_max = float("-inf")
            lon_min = float("inf")
            lon_max = float("-inf")
            offset2 = args.offset
            already_fetched = 0
            while True:
                # Respect --limit so we don't over-fetch geometries
                # beyond the requested window.
                fetch_limit = BATCH_SIZE
                if args.limit:
                    remaining = args.limit - already_fetched
                    fetch_limit = min(BATCH_SIZE, remaining)
                    if remaining <= 0:
                        break
                batch = fetch_pending(conn, fetch_limit, offset2)
                if not batch:
                    break
                for _seg_id, geom_raw in batch:
                    geom = parse_geometry(geom_raw)
                    if geom is None:
                        continue
                    for lon, lat in geom:
                        if lon < lon_min:
                            lon_min = lon
                        if lon > lon_max:
                            lon_max = lon
                        if lat < lat_min:
                            lat_min = lat
                        if lat > lat_max:
                            lat_max = lat
                offset2 += fetch_limit
                already_fetched += len(batch)
                if args.limit and already_fetched >= args.limit:
                    break
            if math.isfinite(lat_min):
                cache.preload_region(
                    lat_min, lat_max,
                    lon_min, lon_max,
                )
            log.info("Preload done — %d tile(s) in cache", cache.tile_count)

        # ------------------------------------------------------------------
        # Process loop
        # ------------------------------------------------------------------

        offset = args.offset
        processed = 0
        last_commit = 0
        updated = 0
        errors = 0
        t_start = time.monotonic()
        batch_rows: List[Tuple] = []

        while True:
            segments = fetch_pending(conn, BATCH_SIZE, offset)
            if not segments:
                break

            for seg_id, geom_raw in segments:
                result = process_one(seg_id, geom_raw, cache, args.interval)
                sid, gain, loss, emin, emax, eavg, n, err = result

                if not args.dry_run:
                    batch_rows.append(
                        (gain, loss, emin, emax, eavg, n, err, sid)
                    )

                if err:
                    errors += 1
                else:
                    updated += 1
                processed += 1

            # Flush batch
            if batch_rows and not args.dry_run:
                batch_update(conn, batch_rows)
                batch_rows.clear()

            # Commit after every COMMIT_EVERY rows, but skip the
            # spurious commit at processed=0 (before any work is done).
            if processed > 0 and processed - last_commit >= COMMIT_EVERY:
                conn.commit()
                last_commit = processed
                elapsed = time.monotonic() - t_start
                rate = processed / elapsed if elapsed > 0 else 0
                pct = processed / total * 100 if total else 0
                log.info(
                    "Progress: %d/%d (%.0f%%)  %.1f seg/s  "
                    "%d updated  %d errors  %d tiles cached",
                    processed, total, pct, rate, updated, errors, cache.tile_count,
                )

            offset += BATCH_SIZE
            if args.limit and processed >= args.limit:
                break

        # Final flush & commit
        if batch_rows and not args.dry_run:
            batch_update(conn, batch_rows)
        if not args.dry_run:
            conn.commit()

        elapsed = time.monotonic() - t_start
        rate = processed / elapsed if elapsed > 0 else 0
        log.info(
            "DONE  %d segments in %.1f s (%.1f seg/s)  "
            "%d updated  %d errors  %d tiles loaded",
            processed, elapsed, rate, updated, errors, cache.tile_count,
        )

    finally:
        conn.close()


if __name__ == "__main__":
    main()
