import { useState, useEffect } from "react"
import { fetchDashboardSummary } from "../api"
import { Pill, Status, Empty } from "../../common/ui"
import "./startpage.css"

/* Where the project stands, and what to do about it.
 *
 * This page used to be nine cards in a rigid three-column grid, every one the
 * same weight. "Terminprognose" was three numbers in a card six hundred pixels
 * tall; "Offene Risiken" and "Überfällige Elemente" were one sentence each in
 * cards just as tall; the one figure that mattered - how many features are at
 * risk - was a small amber number in the corner of the first card. So the page
 * was mostly empty space and the thing to act on was the hardest part of it to
 * find.
 *
 * Now: a line that says where the project stands, one list of what needs
 * attention, the milestones beside it, and everything that is empty folded
 * into a single muted line at the foot.
 */

export default function StartPage() {
    const [summary, setSummary] = useState(null)
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(false)

    useEffect(() => {
        fetchDashboardSummary()
            .then(setSummary)
            .catch(() => setError(true))
            .finally(() => setLoading(false))
    }, [])

    if (loading) return <Status>Lädt…</Status>
    if (error || !summary) return <Status tone="danger">Tracking-Service nicht erreichbar.</Status>

    const overdue = [
        ...summary.overdue.milestones.map(m => ({ ...m, kind: "Milestone" })),
        ...summary.overdue.features.map(f => ({ ...f, kind: "Feature" })),
        ...summary.overdue.work_packages.map(w => ({ ...w, kind: "Arbeitspaket",
                                                     target_date: w.planned_end })),
    ]
    const attention = attentionRows(summary, overdue)
    const counts = summary.forecast_counts
    const total = counts.on_track + counts.endangered

    return (
        <div className="sp-view">
            {/* Where the project stands, before any of the detail. */}
            <div className="sp-summary">
                <span className="sp-total">{total}</span>
                <span className="tracking-meta">Features</span>
                <Pill tone="ok" dot>{counts.on_track} im Plan</Pill>
                {counts.endangered > 0 && (
                    <Pill tone="warn" dot>{counts.endangered} gefährdet</Pill>
                )}
                {overdue.length > 0 && (
                    <Pill tone="danger" dot>{overdue.length} überfällig</Pill>
                )}
                {counts.low_confidence > 0 && (
                    <Pill tone="warn">{counts.low_confidence} × niedriges Vertrauen</Pill>
                )}
            </div>

            <div className="sp-split">
                <section className="tracking-card sp-pane">
                    <div className="sp-pane-head">
                        <h4>Braucht Aufmerksamkeit</h4>
                        <span className="tracking-meta">nach Termin</span>
                    </div>
                    {attention.length === 0
                        ? <Empty>Nichts gefährdet, nichts blockiert.</Empty>
                        : attention.map(row => <AttentionRow key={row.key} row={row} />)}
                </section>

                <section className="tracking-card sp-pane">
                    <div className="sp-pane-head">
                        <h4>Meilensteine</h4>
                    </div>
                    {summary.upcoming_milestones.length === 0
                        ? <Empty>Keiner in den nächsten 90 Tagen.</Empty>
                        : summary.upcoming_milestones.map(m => (
                            <MilestoneRow key={m.id} milestone={m} />
                        ))}
                </section>
            </div>

            {/* What is empty, as one line. Three cards each saying "nichts
                vorhanden" cost more room than the content they would hold. */}
            <QuietLine summary={summary} overdue={overdue} />
        </div>
    )
}

/* Features at risk and blocked work packages, as one list.
 *
 * They were two cards. It is the same question - what is stuck - asked of two
 * tables, and splitting it meant reading both to answer it. Sorted by date,
 * because the one due first is the one to look at, whichever table it came
 * from.
 */
function attentionRows(summary, overdue) {
    const rows = []

    for (const f of summary.endangered_features) {
        rows.push({
            key: `f${f.id}`,
            kind: "feature",
            tone: f.status === "rot" ? "danger" : "warn",
            title: f.title,
            where: f.milestone_title || f.owner || "",
            date: f.target_date,
            label: f.target_date ? fmtDate(f.target_date) : "–",
        })
    }

    for (const wp of summary.blocked_work_packages) {
        rows.push({
            key: `w${wp.id}`,
            kind: "package",
            tone: "danger",
            title: wp.title,
            where: wp.feature_title || "",
            date: wp.blocked_since,
            label: wp.blocked_since ? `seit ${fmtDate(wp.blocked_since)}` : "blockiert",
        })
    }

    for (const item of overdue) {
        rows.push({
            key: `o${item.kind}${item.id}`,
            kind: "overdue",
            tone: "danger",
            title: item.title,
            where: item.kind,
            date: item.target_date,
            label: item.target_date ? fmtDate(item.target_date) : "überfällig",
        })
    }

    /* Undated rows last: a thing with no date cannot be ranked against one
       that has one, and putting it first would push a real deadline down. */
    return rows.sort((a, b) => (a.date || "9999").localeCompare(b.date || "9999"))
}

function AttentionRow({ row }) {
    return (
        <div className="sp-row" data-kind={row.kind}>
            <span className="sp-row-mark" data-tone={row.tone} aria-hidden />
            <span className="sp-row-title">{row.title}</span>
            {/* The milestone it will make late. A feature at risk means
                nothing on its own. */}
            <span className="sp-row-where">{row.where}</span>
            <span className="sp-row-date" data-tone={row.tone}>{row.label}</span>
        </div>
    )
}

function MilestoneRow({ milestone }) {
    const done = milestone.features_done ?? null
    const total = milestone.features_total ?? null
    const tone = milestone.status === "rot" ? "danger"
        : milestone.status === "gelb" ? "warn" : "ok"
    return (
        <div className="sp-stone">
            {/* No status dot in front of the title: the bar and the date
                already carry the tone, and a dot pushed every title out of
                line with the heading above it. */}
            <span className="sp-stone-line">
                <span className="sp-stone-title">{milestone.title}</span>
                <span className="fps-spacer" />
                {total != null && <span className="tracking-meta">{done}/{total}</span>}
                <span className="sp-stone-date" data-tone={tone}>
                    {fmtDate(milestone.target_date)}
                </span>
            </span>
            {total ? (
                <span className="sp-stone-bar">
                    <span className="sp-stone-fill" data-tone={tone}
                          style={{ width: `${Math.round((done / total) * 100)}%` }} />
                </span>
            ) : null}
        </div>
    )
}

/* Everything with nothing in it, in one sentence. */
function QuietLine({ summary, overdue }) {
    const quiet = []
    if (summary.open_risks.length === 0) quiet.push("keine offenen Risiken")
    if (summary.critical_chains.length === 0) quiet.push("keine blockierenden Abhängigkeiten")
    if (overdue.length === 0) quiet.push("nichts überfällig")
    if (quiet.length === 0) return null
    return (
        <p className="sp-quiet">
            {quiet.join(" · ").replace(/^k/, "K")}
        </p>
    )
}

function fmtDate(iso) {
    if (!iso) return ""
    const [y, m, d] = iso.slice(0, 10).split("-")
    return `${d}.${m}.${y.slice(2)}`
}
