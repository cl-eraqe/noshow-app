"""
Rebuilds backend/flights.json from a schedule export.

Usage: python csv_to_flights_json.py <input.csv|.xlsx> [output.json]
Default output: ../flights.json  (overwrites the existing file)

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

    input_path = Path(sys.argv[1])
    base_dir = Path(__file__).parent.parent
    output_path = Path(sys.argv[2]) if len(sys.argv) >= 3 else base_dir / "flights.json"
    airports_path = base_dir / "airports.json"

    header, rows = read_rows(input_path)
    cols = _match_headers(header)
    missing = [f for f in ("flight", "destination", "std") if f not in cols]
    if missing:
        print(f"ERROR: could not find column(s) for {', '.join(missing)}")
        print(f"       file headers: {header}")
        sys.exit(1)

    airports = json.loads(airports_path.read_text(encoding="utf-8")) if airports_path.exists() else {}

    flights = {}
    unknown_terminal, unknown_airport = [], {}
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

        flights[fn] = {
            "destination": dest,
            "std": format_std(row[cols["std"]]),
            "terminal": terminal,
        }

    output_path.write_text(
        json.dumps(dict(sorted(flights.items())), ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(f"Written {len(flights)} flights -> {output_path}")

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
