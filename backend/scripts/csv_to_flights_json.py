"""
Merges a schedule export into backend/flights.json.

Usage: python csv_to_flights_json.py <input.csv|.xlsx> [output.json]
Default output: ../flights.json

The export is a partial picture — one day's departures, a few hundred flights
out of the ~1,800 the app knows. So it is merged, not substituted: a flight in
the file overwrites the entry it matches, one that is new is added, and one the
file does not mention is left alone. Replacing wholesale would delete every
flight that happened not to fly that day.

Pass --replace to rebuild from scratch instead, for a genuinely complete export.

Input columns — Arabic or English headers, in any order:

    رقم الرحلة / Flight Number      required
    الرمز / Destination / IATA      required, the 3-letter airport code
    المجدول / STD                   required, HH:MM
    الصالة / Terminal               optional (H/N/T1/T4 or Hajj/North/...)

City, country and nationality are NOT read from here. They depend only on the
airport code, so they live once per airport in airports.json rather than being
repeated on every flight to it. A code missing from that file is reported at
the end so it can be added once.

Terminal assignment: the file's own column wins when present and recognised.
Otherwise it falls back to the airline-code map below, with flight-number
patterns for the airlines that split across terminals:
    SV: SV2xxx -> Hajj, rest -> T1
    TK: TK5xxx -> Hajj, rest -> T1
    VF: VF61xx -> Hajj, rest -> T1
    F3: F39xxx -> Hajj, rest -> T1
    PC: 4-digit -> Hajj, 3-digit -> North
    AT: 4-digit -> Hajj, 3-digit -> T1
"""

import csv
import json
import re
import sys
from pathlib import Path

# Base terminal per IATA prefix (airlines that use a single terminal)
TERMINAL_MAP = {
    "2S": "Hajj", "3T": "North", "6E": "North", "7Q": "Hajj", "9P": "Hajj",
    "A3": "T1",   "A4": "Hajj",  "AH": "Hajj",  "AI": "North", "BA": "T1",
    "BG": "Hajj", "BJ": "Hajj",  "BM": "Hajj",  "BS": "Hajj",  "C6": "Hajj",
    "D3": "North","D7": "Hajj",  "DH": "Hajj",  "DV": "North", "E5": "North",
    "EK": "T1",   "ER": "Hajj",  "ET": "North", "EW": "T1",    "EY": "T1",
    "FG": "Hajj", "FH": "Hajj",  "FZ": "T1",    "G9": "North", "GA": "Hajj",
    "GF": "T1",   "HU": "T1",    "HY": "North", "IX": "North", "IY": "North",
    "J2": "North","J4": "North", "J9": "North", "JT": "Hajj",  "KU": "T1",
    "ME": "T1",   "MH": "T1",    "MS": "T1",    "NB": "Hajj",  "NE": "North",
    "NP": "North","OV": "North", "PA": "Hajj",  "PF": "Hajj",  "PK": "Hajj",
    "QP": "Hajj", "QR": "T1",    "R5": "Hajj",  "RB": "North", "RJ": "T1",
    "RQ": "Hajj", "SD": "North", "SM": "North", "SZ": "North", "TU": "North",
    "UZ": "Hajj", "W4": "North", "W9": "North", "WY": "T1",    "XC": "Hajj",
    "XY": "T1",   "YI": "Hajj",
}

TERMINAL_ALIASES = {
    "H": "Hajj", "HAJJ": "Hajj",
    "N": "North", "NORTH": "North",
    "T1": "T1", "T": "T1", "1": "T1",
    "T4": "T4", "4": "T4",
}

# Terminal 4 is not in scheduled operation yet. It appears in exports with
# provisional-looking numbers (999, 1234, 2222, 5555, 7777, 8888) across many
# airlines, which reads as the terminal being exercised in the source system
# rather than flown. Importing them would send staff — and a bus badge — to a
# terminal that is not running, so they are skipped and reported.
#
# DELETE THIS WHEN TERMINAL 4 OPENS. It is a temporary hold, not a rule: the
# count reported each run is the signal, because real flight numbers will
# replace the placeholder ones.
SKIP_TERMINAL = "T4"

# Header synonyms, so an Arabic or English export both work unchanged.
HEADERS = {
    "flight":      ("رقم الرحلة", "flight number", "flight", "flight_number", "flightnumber"),
    "destination": ("الرمز", "destination", "iata", "code", "dest"),
    "std":         ("المجدول", "std", "scheduled", "time"),
    "terminal":    ("الصالة", "terminal"),
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
        num = re.search(r"\d+", flight_number)
        return "Hajj" if num and num.group().startswith("39") else "T1"
    if prefix == "PC":
        return "Hajj" if digits >= 1000 else "North"
    if prefix == "AT":
        return "Hajj" if digits >= 1000 else "T1"

    return TERMINAL_MAP.get(prefix, "UNKNOWN")


def normalize_flight_number(value):
    """SV0309 / sv 309 / 6.00E+92 -> SV309 / 6E92.

    Excel turns 6E0092 into scientific notation on save, and exports pad
    numbers with leading zeros; the app stores neither.
    """
    s = str(value).strip()
    m = re.match(r"^(\d+)(?:\.\d+)?[Ee]\+?(\d+)$", s)   # Excel scientific
    if m:
        s = f"{m.group(1)}E{m.group(2)}"
    s = s.upper().replace(" ", "")
    m = re.match(r"^([A-Z\d]{2})0*(\d+)$", s)           # drop leading zeros
    return m.group(1) + m.group(2) if m else s


def format_std(raw):
    """Normalize a scheduled time to HH:MM, from text or an Excel time cell."""
    if hasattr(raw, "strftime"):
        return raw.strftime("%H:%M")
    s = str(raw).strip()
    m = re.match(r"^(\d{1,2}):(\d{2})", s)
    return f"{int(m.group(1)):02d}:{m.group(2)}" if m else s


def normalize_terminal(raw):
    if raw is None:
        return None
    val = str(raw).strip().upper()
    return TERMINAL_ALIASES.get(val) if val else None


def _detect_encoding(path):
    """Pick the encoding to read a CSV with.

    The import used to hardcode cp1252, which cannot represent Turkish 'ş' —
    Eskişehir arrived as "Eski?ehir" with no error raised.
    """
    for enc in ("utf-8-sig", "cp1252"):
        try:
            with open(path, encoding=enc) as f:
                f.read()
            return enc
        except UnicodeDecodeError:
            continue
    return "latin-1"


def _match_headers(names):
    """Map our four field names onto whatever this file calls its columns."""
    found = {}
    for field, aliases in HEADERS.items():
        for i, name in enumerate(names):
            if str(name or "").strip().lower() in aliases:
                found[field] = i
                break
    return found


def read_rows(path):
    """Return (header_names, rows) from a .csv or .xlsx."""
    if path.suffix.lower() in (".xlsx", ".xlsm"):
        import openpyxl
        ws = openpyxl.load_workbook(path, data_only=True).active
        values = list(ws.values)
        return list(values[0]), [r for r in values[1:] if r and r[0] is not None]
    with open(path, encoding=_detect_encoding(path)) as f:
        reader = csv.reader(f)
        header = next(reader)
        return header, [r for r in reader if r and r[0].strip()]


def main():
    if len(sys.argv) < 2:
        print("Usage: python csv_to_flights_json.py <input.csv|.xlsx> [output.json]")
        sys.exit(1)

    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    replace = "--replace" in sys.argv

    input_path = Path(args[0])
    base_dir = Path(__file__).parent.parent
    output_path = Path(args[1]) if len(args) >= 2 else base_dir / "flights.json"
    airports_path = base_dir / "airports.json"

    header, rows = read_rows(input_path)
    cols = _match_headers(header)
    missing = [f for f in ("flight", "destination", "std") if f not in cols]
    if missing:
        print(f"ERROR: could not find column(s) for {', '.join(missing)}")
        print(f"       file headers: {header}")
        sys.exit(1)

    airports = json.loads(airports_path.read_text(encoding="utf-8")) if airports_path.exists() else {}

    # Start from what we already have, unless a full rebuild was asked for.
    existing = {}
    if output_path.exists() and not replace:
        existing = json.loads(output_path.read_text(encoding="utf-8"))
    flights = dict(existing)

    added, updated, unchanged = [], [], 0
    unknown_terminal, unknown_airport, skipped = [], {}, []
    for row in rows:
        fn = normalize_flight_number(row[cols["flight"]])
        if not fn:
            continue

        dest = str(row[cols["destination"]] or "").strip().upper()
        terminal = normalize_terminal(row[cols["terminal"]]) if "terminal" in cols else None
        if terminal is None:
            terminal = assign_terminal(fn)
        if terminal == "UNKNOWN":
            unknown_terminal.append(fn)
        if dest and dest not in airports:
            unknown_airport.setdefault(dest, []).append(fn)

        if terminal == SKIP_TERMINAL:
            skipped.append(fn)
            continue

        entry = {
            "destination": dest,
            "std": format_std(row[cols["std"]]),
            "terminal": terminal,
        }
        before = flights.get(fn)
        if before is None:
            added.append(fn)
        elif before != entry:
            updated.append((fn, before, entry))
        else:
            unchanged += 1
        flights[fn] = entry

    output_path.write_text(
        json.dumps(dict(sorted(flights.items())), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    kept = len(flights) - len(added) - len(updated) - unchanged
    print(f"{len(rows)} row(s) in the file -> {output_path}")
    print(f"  added     {len(added):>5}")
    print(f"  updated   {len(updated):>5}")
    print(f"  unchanged {unchanged:>5}")
    if not replace:
        print(f"  untouched {kept:>5}   (not in this file, left as they were)")
    print(f"  total     {len(flights):>5} flights")

    if updated:
        print(f"\nCHANGED — the file disagreed with what we had:")
        for fn, b, a_ in updated[:30]:
            diffs = [f"{k}: {b.get(k)} -> {a_[k]}" for k in a_ if b.get(k) != a_[k]]
            print(f"  {fn:<9} {'; '.join(diffs)}")
        if len(updated) > 30:
            print(f"  ... and {len(updated) - 30} more")

    if skipped:
        print(f"\nSKIPPED {len(skipped)} flight(s) in {SKIP_TERMINAL} — that terminal is not in "
              f"scheduled operation yet:")
        print(f"  {', '.join(skipped)}")
        print(f"  (remove SKIP_TERMINAL in this script once it opens)")

    if unknown_terminal:
        print(f"\nWARNING: {len(unknown_terminal)} flight(s) with an unrecognised airline prefix "
              f"(terminal left UNKNOWN):")
        for fn in unknown_terminal:
            print(f"  {fn}")

    if unknown_airport:
        print(f"\nWARNING: {len(unknown_airport)} airport code(s) missing from airports.json — "
              f"flights to them will have no nationality until added:")
        for code, fns in sorted(unknown_airport.items()):
            print(f"  {code}  ({len(fns)} flight(s): {', '.join(fns[:3])})")


if __name__ == "__main__":
    main()
