// Passenger counts must reach the server as plain Latin digits.
//
// The inputs that use this are type="text" with inputMode="numeric" so phones
// show the bare number pad instead of the full keyboard. That choice means the
// browser no longer enforces numeric input itself, so anything else that can
// still arrive — pasted text, or Arabic-Indic digits from a non-Latin
// keyboard — gets normalised or dropped here.
export function toLatinDigits(s) {
  return String(s)
    .replace(/[٠-٩]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x0660 + 48))   // Arabic-Indic
    .replace(/[۰-۹]/g, d => String.fromCharCode(d.charCodeAt(0) - 0x06F0 + 48))   // Extended (Persian/Urdu)
    .replace(/\D/g, '');
}
