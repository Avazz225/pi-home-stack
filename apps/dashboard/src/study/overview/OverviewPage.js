import { useState, useEffect } from "react"
import { fetchOverview } from "../api"
import {
    CpBar, CpBarLegend, StateBadge, STATUS_LABELS, fmtCp, fmtGrade, fmtAvg, semesterRank, ModuleLink,
} from "../shared"
import "./overview.css"

export default function OverviewPage({ onNavigate }) {
    const [data, setData] = useState(null)
    const [error, setError] = useState(false)

    useEffect(() => {
        fetchOverview().then(setData).catch(() => setError(true))
    }, [])

    if (error) return <div className="study-status error">Studium-Service nicht erreichbar.</div>
    if (!data) return <div className="study-status">Lädt…</div>

    const { totals, categories } = data
    const thesis = totals.thesis
    const allModules = categories.flatMap(c => c.modules.map(m => ({ ...m, category: c.name })))
    const upcoming = allModules
        .filter(m => m.status === "geplant" || m.status === "laufend")
        .sort((a, b) => semesterRank(a.semester) - semesterRank(b.semester))
    const done = allModules
        .filter(m => m.status === "abgeschlossen")
        .sort((a, b) => semesterRank(b.semester) - semesterRank(a.semester))

    return (
        <div className="study-view">
            <div className="study-card ov-hero">
                <span className="study-meta">Credit Points geschafft</span>
                <div className="ov-hero-value">
                    {totals.cp_done}
                    <span className="ov-hero-unit">von {totals.target_cp} CP</span>
                </div>
                {/* The thesis sits at the end of the bar at its full size, whatever its
                    status — it is a fixed block, so the coursework segments leave it out. */}
                <CpBar done={totals.cp_done_coursework}
                       planned={Math.max(totals.cp_committed_coursework - totals.cp_done_coursework, 0)}
                       thesis={thesis ? thesis.cp : 0}
                       thesisDone={!!thesis && thesis.done}
                       max={totals.target_cp}
                       state={totals.cp_done >= totals.target_cp ? "ok" : "unter"} />
                <div className="ov-hero-foot">
                    <div className="ov-hero-stats">
                        <span className="study-meta">
                            Gesamt: <strong>{totals.progress} %</strong> · noch {fmtCp(Math.max(totals.target_cp - totals.cp_done, 0))}
                        </span>
                        {thesis && (
                            <span className="study-meta">
                                Bis zur Thesis: <strong>{totals.progress_coursework} %</strong>
                                {totals.cp_to_thesis > 0 ? ` · noch ${fmtCp(totals.cp_to_thesis)}` : " · vollständig"}
                            </span>
                        )}
                    </div>
                    <CpBarLegend doneLabel="abgeschlossen" plannedLabel="eingeplant"
                                 thesisLabel={thesis ? "Thesis" : null} />
                </div>
            </div>

            <div className="ov-tiles">
                <Tile label="Notenschnitt" value={fmtAvg(totals.grade_average)}
                      hint={totals.grade_average_unweighted ? `ungewichtet ${fmtAvg(totals.grade_average_unweighted)}` : "noch keine Note erfasst"} />
                <Tile label="Module abgeschlossen" value={`${totals.modules_done}/${totals.modules_total}`}
                      hint={`${fmtCp(totals.cp_committed)} belegt oder geplant`} />
                <Tile label="Aktiver Plan" value={data.active_plan ? data.active_plan.name : "–"}
                      small hint={data.active_plan ? "wird gerade verfolgt" : "kein Plan aktiv"}
                      onClick={() => onNavigate("plans")} />
            </div>

            <div className="study-card">
                <div className="study-card-header">
                    <h4>CP-Check je Fachrichtung</h4>
                    <button className="study-text-btn" onClick={() => onNavigate("categories")}>Fachrichtungen bearbeiten</button>
                </div>
                {categories.length === 0 && <p className="study-empty">Noch keine Fachrichtung angelegt.</p>}
                {categories.map(cat => (
                    <div key={cat.id} className="ov-cat">
                        <div className="study-cat-head">
                            <span className="study-cat-name">{cat.name}</span>
                            {!!cat.is_thesis && <span className="study-chip study-chip-thesis">Thesis</span>}
                            <span className="study-meta study-num">
                                {fmtCp(cat.stats.cp_committed)} von {cat.cp_min ?? "?"}–{cat.cp_max ?? "?"} CP
                            </span>
                            <StateBadge state={cat.stats.state} value={cat.stats.cp_committed} min={cat.cp_min} max={cat.cp_max} />
                        </div>
                        <CpBar done={cat.stats.cp_done}
                               planned={Math.max(cat.stats.cp_committed - cat.stats.cp_done, 0)}
                               min={cat.cp_min} max={cat.cp_max} state={cat.stats.state} />
                    </div>
                ))}
                <CpBarLegend doneLabel="abgeschlossen" plannedLabel="eingeplant" />
            </div>

            <div className="study-card">
                <div className="study-card-header">
                    <h4>Als Nächstes</h4>
                    <button className="study-text-btn" onClick={() => onNavigate("modules")}>Module bearbeiten</button>
                </div>
                {upcoming.length === 0 && <p className="study-empty">Kein Modul auf „geplant“ oder „laufend“ gesetzt.</p>}
                {upcoming.map(m => <ModuleRow key={m.id} module={m} />)}
            </div>

            <div className="study-card">
                <h4 className="study-h4">Zuletzt abgeschlossen</h4>
                {done.length === 0 && <p className="study-empty">Noch nichts abgeschlossen.</p>}
                {done.slice(0, 6).map(m => <ModuleRow key={m.id} module={m} showGrade />)}
            </div>
        </div>
    )
}

function Tile({ label, value, hint, small, onClick }) {
    return (
        <div className={`study-card ov-tile${onClick ? " clickable" : ""}`} onClick={onClick}>
            <span className="study-meta">{label}</span>
            <span className={`ov-tile-value${small ? " small" : ""}`}>{value}</span>
            <span className="study-meta ov-tile-hint">{hint}</span>
        </div>
    )
}

function ModuleRow({ module, showGrade }) {
    return (
        <div className="ov-row">
            <span className={`study-chip study-chip-${module.status}`}>{STATUS_LABELS[module.status]}</span>
            <span className="ov-row-title">{module.title}<ModuleLink url={module.url} /></span>
            <span className="study-meta">{module.category}</span>
            <span className="study-meta ov-row-num">{fmtCp(module.cp)}</span>
            {module.semester && <span className="study-meta ov-row-num">{module.semester} Sem.</span>}
            {showGrade && <span className="ov-row-grade">{fmtGrade(module.grade)}</span>}
        </div>
    )
}
