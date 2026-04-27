#!/usr/bin/env python3
"""
Convert flights Excel/CSV to flights.json

Usage:
    python3 scripts/csv_to_flights_json.py flights.csv
    python3 scripts/csv_to_flights_json.py flights.csv --out flights.json

Expects columns (order doesn't matter, headers required):
    Flight Number, Destination, STD, City, Country, Nationality
    (Terminal column is ignored)
"""

import csv
import json
import sys
import os
import argparse
from pathlib import Path

def normalize_std(raw):
    """Ensure STD is H:MM or HH:MM format."""
    raw = str(raw).strip()
    if not raw:
        return ""
    # Handle cases like "3:30", "03:30", "330" etc.
    if ":" in raw:
        parts = raw.split(":")
        h = int(parts[0])
        m = int(parts[1])
    elif len(raw) <= 2:
        h = int(raw)
        m = 0
    elif len(raw) == 3:
        h = int(raw[0])
        m = int(raw[1:])
    elif len(raw) == 4:
        h = int(raw[:2])
        m = int(raw[2:])
    else:
        return raw  # unknown format, keep as-is
    return f"{h}:{m:02d}"

def csv_to_json(csv_path, out_path):
    flights = {}
    skipped = []

    with open(csv_path, newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)

        # Normalize header names (strip spaces, lowercase)
        raw_headers = reader.fieldnames or []
        header_map = {h.strip().lower().replace(" ", "_"): h for h in raw_headers}

        required = ["flight_number", "destination", "std", "city", "country", "nationality"]
        missing = [r for r in required if r not in header_map]
        if missing:
            print(f"ERROR: Missing columns: {missing}")
            print(f"Found columns: {list(header_map.keys())}")
            sys.exit(1)

        for i, row in enumerate(reader, start=2):
            def get(key):
                return row[header_map[key]].strip()

            flight_num = get("flight_number").upper()
            if not flight_num:
                skipped.append(f"Row {i}: empty flight number")
                continue

            flights[flight_num] = {
                "destination": get("destination").upper(),
                "std":         normalize_std(get("std")),
                "city":        get("city"),
                "country":     get("country"),
                "nationality": get("nationality"),
            }

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(flights, f, indent=2, ensure_ascii=False)

    print(f"Done: {len(flights)} flights written to {out_path}")
    if skipped:
        print(f"Skipped {len(skipped)} rows:")
        for s in skipped:
            print(f"  {s}")

def main():
    parser = argparse.ArgumentParser(description="Convert flights CSV to flights.json")
    parser.add_argument("csv", help="Path to the CSV file exported from Excel")
    parser.add_argument("--out", default=None,
                        help="Output JSON path (default: flights.json next to this script)")
    args = parser.parse_args()

    csv_path = Path(args.csv).resolve()
    if not csv_path.exists():
        print(f"ERROR: File not found: {csv_path}")
        sys.exit(1)

    if args.out:
        out_path = Path(args.out).resolve()
    else:
        # Default: backend/flights.json (one level up from scripts/)
        out_path = Path(__file__).parent.parent / "flights.json"

    csv_to_json(csv_path, out_path)

if __name__ == "__main__":
    main()
