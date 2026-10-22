/* Reading a timestamp that came from a service.
 *
 * Two shapes arrive, and they look alike:
 *
 *   2026-10-20T05:33:53+00:00   written by Python, carries its zone
 *   2026-10-20 05:33:53         written by SQLite's datetime('now'), UTC but
 *                               with nothing saying so
 *
 * JavaScript reads the second as *local* time, so on this Pi it lands two hours
 * out - and in winter one, which is the kind of wrongness that gets blamed on
 * the clock rather than on the parser. The marker is added where it is missing.
 */
export function parseStamp(value) {
    if (value == null || value === "") return null
    if (typeof value === "number") return new Date(value * 1000)
    const text = String(value).trim()
    // A zone is there when the string ends in Z or carries a ±hh:mm after the
    // time. Checked on the time part only: the date's own hyphens are not signs.
    const timePart = text.slice(10)
    const zoned = /[Zz]$/.test(text) || /[+-]\d{2}:?\d{2}$/.test(timePart)
    const date = new Date(zoned ? text : `${text.replace(" ", "T")}Z`)
    return isNaN(date.getTime()) ? null : date
}

export function formatStamp(value, options = { dateStyle: "short", timeStyle: "short" }) {
    const date = parseStamp(value)
    return date ? date.toLocaleString("de-DE", options) : "–"
}
