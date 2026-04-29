"""
Converts flights.csv to flights.json for the JEDCO no-show app.
Usage: python csv_to_flights_json.py <input.csv> [output.json]
Default output: ../flights.json  (overwrites the existing file)

Terminal assignment rules:
  - Taken from the CSV data — each airline maps to a single terminal.
  - Conflict cases use flight-number patterns derived from the actual data:
      SV: SV2xxx -> H  (Royal Air Maroc-codeshare North Africa routes), rest -> T1
      TK: TK5xxx -> H  (regional codeshares operated by other carriers), rest -> T1
      VF: VF6xxx -> H  (regional Turkish flights), rest -> T1
      F3: F39xxx -> H  (Batik Air / Citilink Indonesian codeshares), rest -> T1
      PC: 4-digit numbers -> H, 3-digit numbers -> N  (Pegasus main vs charter)
      AT: 4-digit numbers -> H, 3-digit numbers -> T1  (Royal Air Maroc regional vs main)
"""

import csv
import json
import re
import sys
from pathlib import Path

# Base terminal per IATA prefix (all clean, single-terminal airlines)
TERMINAL_MAP = {
    "2S": "Hajj",
    "3T": "North",
    "6E": "North",
    "7Q": "Hajj",
    "9P": "Hajj",
    "A3": "T1",
    "AH": "Hajj",
    "AI": "North",
    "BA": "T1",
    "BG": "Hajj",
    "BJ": "Hajj",
    "BM": "Hajj",
    "BS": "Hajj",
    "C6": "Hajj",
    "D3": "North",
    "D7": "Hajj",
    "DV": "North",
    "E5": "North",
    "EK": "T1",
    "ET": "North",
    "EW": "T1",
    "EY": "T1",
    "FG": "Hajj",
    "FH": "Hajj",
    "FZ": "T1",
    "G9": "North",
    "GA": "Hajj",
    "GF": "T1",
    "HU": "T1",
    "HY": "North",
    "IX": "North",
    "IY": "North",
    "J4": "North",
    "JT": "Hajj",
    "KU": "T1",
    "ME": "T1",
    "MH": "T1",
    "MS": "T1",
    "NE": "North",
    "NP": "North",
    "OV": "North",
    "PA": "Hajj",
    "PF": "Hajj",
    "PK": "Hajj",
    "QP": "Hajj",
    "QR": "T1",
    "R5": "Hajj",
    "RB": "North",
    "RJ": "T1",
    "RQ": "Hajj",
    "SD": "North",
    "SM": "North",
    "SZ": "North",
    "TU": "North",
    "UZ": "Hajj",
    "W9": "North",
    "WY": "T1",
    "XC": "Hajj",
    "XY": "T1",
}


def iata_prefix(flight_number):
    m = re.match(r"^([A-Z0-9]{2})", flight_number.upper())
    return m.group(1) if m else ""


def flight_number_digits(flight_number):
    m = re.search(r"(\d+)", flight_number)
    return int(m.group(1)) if m else 0


def assign_terminal(flight_number):
    prefix = iata_prefix(flight_number)
    digits = flight_number_digits(flight_number)

    if prefix == "SV":
        return "Hajj" if 2000 <= digits <= 2999 else "T1"

    if prefix == "TK":
        return "Hajj" if 5000 <= digits <= 5999 else "T1"

    if prefix == "VF":
        return "Hajj" if 6100 <= digits <= 6199 else "T1"

    if prefix == "F3":
        # F39xxx -> Hajj, others -> T1
        num_str = re.search(r"\d+", flight_number)
        return "Hajj" if num_str and num_str.group().startswith("39") else "T1"

    if prefix == "PC":
        return "Hajj" if digits >= 1000 else "North"

    if prefix == "AT":
        return "Hajj" if digits >= 1000 else "T1"

    return TERMINAL_MAP.get(prefix, "UNKNOWN")


def fix_excel_scientific(val):
    """
    Excel converts e.g. 6E0092 -> 6.00E+92 when saving as CSV.
    This converts it back to 6E92 (IndiGo style).
    """
    val = val.strip()
    # Match patterns like 6.00E+92 or 6E+92
    m = re.match(r'^(\d+)(?:\.\d+)?[Ee]\+?(\d+)$', val)
    if m:
        prefix = m.group(1)       # e.g. "6"
        exponent = m.group(2)     # e.g. "92"
        return f"{prefix}E{exponent}"
    return val


def format_std(raw):
    """Normalize STD from 'H:MM' or 'HH:MM' to 'HH:MM'."""
    raw = raw.strip()
    if ":" in raw:
        h, m = raw.split(":", 1)
        return f"{int(h):02d}:{m.zfill(2)}"
    return raw


def main():
    if len(sys.argv) < 2:
        print("Usage: python csv_to_flights_json.py <input.csv> [output.json]")
        sys.exit(1)

    input_path = Path(sys.argv[1])
    output_path = (
        Path(sys.argv[2]) if len(sys.argv) >= 3
        else Path(__file__).parent.parent / "flights.json"
    )

    flights = {}
    unknown = []

    with open(input_path, encoding="cp1252") as f:
        reader = csv.DictReader(f)
        # Strip whitespace from header names (e.g. 'Country  ')
        reader.fieldnames = [h.strip() for h in reader.fieldnames]
        for row in reader:
            fn = fix_excel_scientific(row["Flight Number"].strip())
            if not fn:
                continue

            terminal = assign_terminal(fn)
            if terminal == "UNKNOWN":
                unknown.append(fn)

            flights[fn] = {
                "destination": row["Destination"].strip(),
                "std": format_std(row["STD"]),
                "city": row["City"].strip(),
                "country": row["Country"].strip(),
                "nationality": row["Nationality"].strip(),
                "terminal": terminal,
            }

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(flights, f, ensure_ascii=False, indent=2)

    print(f"Written {len(flights)} flights -> {output_path}")

    if unknown:
        print(f"\nWARNING: {len(unknown)} flights with unrecognized airline prefix:")
        for fn in unknown:
            print(f"  {fn}")


if __name__ == "__main__":
    main()
