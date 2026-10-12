/* Labels and small display helpers shared by the study views. */

export const STATUS_LABELS = {
    offen: "Offen",
    geplant: "Geplant",
    laufend: "Laufend",
    abgeschlossen: "Abgeschlossen",
}

/* The spreadsheet used the single letters "s" and "p"; anything else the user
   types is shown as entered. */
export const EXAM_FORMS = {
    s: "Schriftlich",
    m: "Mündlich",
    p: "Portfolio",
}

export function examFormLabel(value) {
    if (!value) return ""
    return EXAM_FORMS[value] || value
}

/* Semester labels stay free text ("3.", "(6./7.)", "?"), so ordering goes by the
   first number in the label — same rule as in the backend. */
export function semesterRank(value) {
    if (!value || !value.trim()) return 999
    const match = value.match(/\d+/)
    return match ? Number(match[0]) : 998
}

export function fmtCp(value) {
    if (value === null || value === undefined || value === "") return "–"
    const num = Number(value)
    return `${Number.isInteger(num) ? num : num.toFixed(1).replace(".", ",")} CP`
}

export function fmtGrade(value) {
    if (value === null || value === undefined || value === "") return "–"
    return Number(value).toFixed(1).replace(".", ",")
}

/* Averages keep the second decimal — 1,85 and 1,9 are not the same statement. */
export function fmtAvg(value) {
    if (value === null || value === undefined || value === "") return "–"
    return Number(value).toFixed(2).replace(".", ",")
}

export function stateLabel(state, value, min, max) {
    if (state === "unter") return `noch ${fmtCp(Math.round((min - value) * 10) / 10)}`
    if (state === "ueber") return `${fmtCp(Math.round((value - max) * 10) / 10)} zu viel`
    return "im Rahmen"
}

export function StateBadge({ state, value, min, max }) {
    return <span className={`study-state study-state-${state}`}>{stateLabel(state, value, min, max)}</span>
}

/* Horizontal CP meter. The track is scaled to the upper end of the interval, the
   minimum is drawn as a marker line — a category is checked against a range, not
   against one target number. The marker comes first in the DOM so that the last
   child is always a fill and gets the rounded data end. */
export function CpBar({ done, planned = 0, thesis = 0, thesisDone = false, min, max, state = "unter" }) {
    const total = done + planned + thesis
    const scale = Math.max(max || 0, total, 1)
    const pct = (value) => `${Math.min(value / scale, 1) * 100}%`
    const range = [min, max].filter(v => v !== null && v !== undefined).join("–")

    // The rounded data end belongs to the last segment that grows from the
    // baseline — which is not the thesis, because that one is pinned to the far
    // end of the track instead of following the progress.
    const endClass = (kind) => (kind === (planned > 0 ? "planned" : "done") ? " end" : "")

    return (
        <div className="study-cpbar" data-state={state}
             title={`${fmtCp(total)}${range ? ` von ${range} CP` : ""}`}>
            {min > 0 && min < scale && <span className="study-cpbar-min" style={{ left: pct(min) }} />}
            {done > 0 && <div className={`study-cpbar-fill study-cpbar-done${endClass("done")}`} style={{ width: pct(done) }} />}
            {planned > 0 && <div className={`study-cpbar-fill study-cpbar-planned${endClass("planned")}`} style={{ width: pct(planned) }} />}
            {thesis > 0 && (
                <div className={`study-cpbar-fill study-cpbar-thesis${thesisDone ? " done" : ""}`}
                     style={{ width: pct(thesis) }} />
            )}
        </div>
    )
}

/* Shown wherever a bar carries more than one kind of segment — the colors alone
   must never have to say which part is which. */
export function CpBarLegend({ doneLabel = "abgeschlossen", plannedLabel = "geplant", thesisLabel, state = "unter" }) {
    return (
        <div className="study-cpbar-legend">
            <span className="study-legend-key">
                <span className={`study-legend-swatch${state === "ok" ? " done-ok" : ""}`} />{doneLabel}
            </span>
            <span className="study-legend-key">
                <span className={`study-legend-swatch planned${state === "ok" ? " done-ok" : ""}`} />{plannedLabel}
            </span>
            {thesisLabel && (
                <span className="study-legend-key">
                    <span className="study-legend-swatch thesis" />{thesisLabel}
                </span>
            )}
        </div>
    )
}

export function ModuleLink({ url }) {
    if (!url) return null
    return (
        <a className="study-link" href={url} target="_blank" rel="noreferrer"
           onClick={e => e.stopPropagation()} title="Modulbeschreibung in Moses öffnen">↗</a>
    )
}
