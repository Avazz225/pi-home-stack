import { useState, useEffect, useCallback } from "react"
import {
    fetchPlans, fetchPlan, createPlan, updatePlan, deletePlan, activatePlan, adoptPlan,
    createPlanEntry, updatePlanEntry, deletePlanEntry, fetchOverview,
} from "../api"
import { CpBar, StateBadge, STATUS_LABELS, fmtCp, ModuleLink } from "../shared"
import "./plans.css"

export default function PlanView() {
    const [openId, setOpenId] = useState(null)

    if (openId) return <PlanDetail planId={openId} onBack={() => setOpenId(null)} />
    return <PlanList onOpen={setOpenId} />
}

/* ── Plan list ───────────────────────────────────────────────────────────── */

function PlanList({ onOpen }) {
    const [plans, setPlans] = useState(null)
    const [error, setError] = useState(false)
    const [adding, setAdding] = useState(false)
    const [renameId, setRenameId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)

    const refresh = useCallback(async () => {
        try {
            setPlans(await fetchPlans())
            setError(false)
        } catch {
            setError(true)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    if (error) return <div className="study-status error">Studium-Service nicht erreichbar.</div>
    if (!plans) return <div className="study-status">Lädt…</div>

    return (
        <div className="study-view">
            <div className="study-card">
                <h4 className="study-h4">Planungsmodus</h4>
                <p className="study-empty">
                    Ein Plan legt sich über den Modulpool: Er sagt nur, welches Modul in welchem
                    Semester liegen soll. Stammdaten und Noten bleiben bei den Modulen, Pläne bleiben
                    dadurch untereinander vergleichbar. Der aktive Plan ist der, an dem du dich
                    gerade langhangelst.
                </p>
            </div>

            {plans.length === 0 && (
                <div className="study-card"><p className="study-empty">Noch kein Plan angelegt.</p></div>
            )}

            {plans.map(plan => (
                <div key={plan.id} className="study-card">
                    <div className="study-card-header">
                        <h4>{plan.name}</h4>
                        {!!plan.is_active && <span className="study-state study-state-ok">aktiv</span>}
                        <span className="study-meta study-num">
                            {plan.entry_count} {plan.entry_count === 1 ? "Modul" : "Module"} · {fmtCp(plan.cp_planned)}
                        </span>
                        <button className="study-icon-btn" title="Umbenennen"
                                onClick={() => setRenameId(renameId === plan.id ? null : plan.id)}>✎</button>
                        <button className="study-icon-btn delete" title="Löschen"
                                onClick={() => setConfirmId(plan.id)}>✕</button>
                    </div>
                    {plan.description && <p className="study-empty">{plan.description}</p>}

                    {renameId === plan.id && (
                        <PlanFields plan={plan} plans={plans}
                                    onSave={async values => { await updatePlan(plan.id, values); setRenameId(null); refresh() }}
                                    onCancel={() => setRenameId(null)} />
                    )}
                    {confirmId === plan.id && (
                        <div className="study-confirm">
                            „{plan.name}“ wirklich löschen? Module und Noten bleiben erhalten, nur die Planung geht verloren.
                            <button className="study-btn danger"
                                    onClick={() => deletePlan(plan.id).then(() => { setConfirmId(null); refresh() })}>Löschen</button>
                            <button className="study-btn" onClick={() => setConfirmId(null)}>Abbrechen</button>
                        </div>
                    )}

                    <div className="plan-actions">
                        <button className="study-btn primary" onClick={() => onOpen(plan.id)}>Öffnen</button>
                        <button className="study-btn" onClick={() => activatePlan(plan.id).then(refresh)}>
                            {plan.is_active ? "Nicht mehr aktiv" : "Aktiv setzen"}
                        </button>
                    </div>
                </div>
            ))}

            {adding ? (
                <div className="study-card">
                    <PlanFields plans={plans} withSource
                                onSave={async values => { await createPlan(values); setAdding(false); refresh() }}
                                onCancel={() => setAdding(false)} />
                </div>
            ) : (
                <button className="study-add-btn" onClick={() => setAdding(true)}>+ Neuer Plan</button>
            )}
        </div>
    )
}

function PlanFields({ plan, plans, withSource, onSave, onCancel }) {
    const [name, setName] = useState(plan?.name ?? "")
    const [description, setDescription] = useState(plan?.description ?? "")
    const [source, setSource] = useState("empty")

    function submit() {
        if (!name.trim()) return
        const values = { name: name.trim(), description: description.trim() || null }
        if (withSource && source === "current") values.seed_from_current = true
        if (withSource && source.startsWith("copy:")) values.copy_from_plan_id = Number(source.slice(5))
        onSave(values)
    }

    return (
        <div className="study-form">
            <label className="study-field wide">Name
                <input value={name} onChange={e => setName(e.target.value)} autoFocus
                       placeholder="z. B. Abschluss in 4 Semestern" />
            </label>
            <label className="study-field wide">Beschreibung
                <input value={description} onChange={e => setDescription(e.target.value)} />
            </label>
            {withSource && (
                <label className="study-field wide">Startpunkt
                    <select value={source} onChange={e => setSource(e.target.value)}>
                        <option value="empty">Leerer Plan</option>
                        <option value="current">Aus aktuellem Stand (geplant, laufend, abgeschlossen)</option>
                        {plans.map(p => <option key={p.id} value={`copy:${p.id}`}>Kopie von „{p.name}“</option>)}
                    </select>
                </label>
            )}
            <div className="study-form-actions">
                <button className="study-btn primary" onClick={submit}>Speichern</button>
                <button className="study-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}

/* ── Plan detail ─────────────────────────────────────────────────────────── */

function PlanDetail({ planId, onBack }) {
    const [plan, setPlan] = useState(null)
    const [pool, setPool] = useState(null)
    const [error, setError] = useState(false)
    const [adding, setAdding] = useState(false)
    const [confirmAdopt, setConfirmAdopt] = useState(false)

    const refresh = useCallback(async () => {
        try {
            const [planData, overview] = await Promise.all([fetchPlan(planId), fetchOverview()])
            setPlan(planData)
            setPool(overview)
            setError(false)
        } catch {
            setError(true)
        }
    }, [planId])

    useEffect(() => { refresh() }, [refresh])

    if (error) return <div className="study-status error">Plan nicht erreichbar.</div>
    if (!plan || !pool) return <div className="study-status">Lädt…</div>

    const entriesById = Object.fromEntries(plan.entries.map(e => [e.id, e]))
    const inPlan = new Set(plan.entries.map(e => e.module_id))

    return (
        <div className="study-view">
            <div className="study-card">
                <div className="study-card-header plan-detail-head">
                    <button className="study-icon-btn" onClick={onBack} title="Zurück zur Planliste">←</button>
                    <h4>{plan.name}</h4>
                    {!!plan.is_active && <span className="study-state study-state-ok">aktiv</span>}
                </div>
                {plan.description && <p className="study-empty">{plan.description}</p>}

                <div className="plan-summary">
                    <span className="plan-summary-value">{plan.totals.cp_total}</span>
                    <span className="study-meta">von {plan.totals.target_cp} CP abgedeckt</span>
                    {plan.totals.missing > 0
                        ? <span className="study-state study-state-unter">noch {fmtCp(plan.totals.missing)}</span>
                        : <span className="study-state study-state-ok">Ziel erreicht</span>}
                </div>

                {plan.categories.map(cat => (
                    <div key={cat.id} className="plan-cat">
                        <div className="study-cat-head">
                            <span className="study-cat-name">{cat.name}</span>
                            <span className="study-meta study-num">
                                {fmtCp(cat.cp_total)} von {cat.cp_min ?? "?"}–{cat.cp_max ?? "?"} CP
                            </span>
                            <StateBadge state={cat.state} value={cat.cp_total} min={cat.cp_min} max={cat.cp_max} />
                        </div>
                        <CpBar done={cat.cp_done} planned={cat.cp_planned} min={cat.cp_min} max={cat.cp_max} state={cat.state} />
                    </div>
                ))}

                <div className="plan-actions">
                    <button className="study-btn" onClick={() => activatePlan(plan.id).then(refresh)}>
                        {plan.is_active ? "Nicht mehr aktiv" : "Aktiv setzen"}
                    </button>
                    <button className="study-btn primary" onClick={() => setConfirmAdopt(true)}>Plan übernehmen</button>
                </div>
                {confirmAdopt && (
                    <div className="study-confirm">
                        Übernehmen schreibt die Semester dieses Plans in die Module und setzt offene
                        Module auf „geplant“. Abgeschlossene Module bleiben unberührt.
                        <button className="study-btn primary"
                                onClick={() => adoptPlan(plan.id).then(() => { setConfirmAdopt(false); refresh() })}>Übernehmen</button>
                        <button className="study-btn" onClick={() => setConfirmAdopt(false)}>Abbrechen</button>
                    </div>
                )}
            </div>

            <div className="plan-board">
                {plan.semesters.length === 0 && (
                    <div className="study-card"><p className="study-empty">Noch kein Modul im Plan.</p></div>
                )}
                {plan.semesters.map(sem => (
                    <div key={sem.label} className="study-card plan-column">
                        <div className="plan-column-head">
                            <span className="plan-column-title">{sem.label === "ohne Semester" ? sem.label : `${sem.label} Semester`}</span>
                            <span className="study-meta study-num">{fmtCp(sem.cp)}</span>
                        </div>
                        {sem.entry_ids.map(id => (
                            <PlanEntryRow key={id} entry={entriesById[id]} refresh={refresh} />
                        ))}
                    </div>
                ))}
            </div>

            {adding ? (
                <div className="study-card">
                    <AddEntryForm overview={pool} inPlan={inPlan}
                                  onSave={async values => { await createPlanEntry(plan.id, values); setAdding(false); refresh() }}
                                  onCancel={() => setAdding(false)} />
                </div>
            ) : (
                <button className="study-add-btn" onClick={() => setAdding(true)}>+ Modul in den Plan</button>
            )}
        </div>
    )
}

function PlanEntryRow({ entry, refresh }) {
    const [editing, setEditing] = useState(false)
    const [semester, setSemester] = useState(entry.semester ?? "")

    return (
        <div className="plan-entry">
            <div className="plan-entry-head">
                <span className={`study-chip study-chip-${entry.status}`}>{STATUS_LABELS[entry.status]}</span>
                <span className="plan-entry-title">{entry.title}<ModuleLink url={entry.url} /></span>
                <span className="study-meta study-num">{fmtCp(entry.cp)}</span>
                <button className="study-icon-btn" title="Semester ändern" onClick={() => setEditing(!editing)}>✎</button>
                <button className="study-icon-btn delete" title="Aus dem Plan entfernen"
                        onClick={() => deletePlanEntry(entry.id).then(refresh)}>✕</button>
            </div>
            {editing && (
                <div className="study-form">
                    <label className="study-field narrow">Semester
                        <input value={semester} onChange={e => setSemester(e.target.value)}
                               placeholder="leer = Semester des Moduls" />
                    </label>
                    <div className="study-form-actions">
                        <button className="study-btn primary"
                                onClick={() => updatePlanEntry(entry.id, { semester: semester.trim() || null })
                                    .then(() => { setEditing(false); refresh() })}>Speichern</button>
                        <button className="study-btn" onClick={() => setEditing(false)}>Abbrechen</button>
                    </div>
                </div>
            )}
        </div>
    )
}

function AddEntryForm({ overview, inPlan, onSave, onCancel }) {
    const [moduleId, setModuleId] = useState("")
    const [semester, setSemester] = useState("")

    const groups = [
        ...overview.categories.map(c => ({ name: c.name, modules: c.modules })),
        { name: "Ideenpool", modules: overview.pool },
    ].map(g => ({ ...g, modules: g.modules.filter(m => !inPlan.has(m.id)) }))
     .filter(g => g.modules.length > 0)

    if (groups.length === 0) {
        return (
            <div>
                <p className="study-empty">Alle Module sind bereits im Plan.</p>
                <button className="study-btn" onClick={onCancel}>Schließen</button>
            </div>
        )
    }

    return (
        <div className="study-form">
            <label className="study-field wide">Modul
                <select value={moduleId} onChange={e => setModuleId(e.target.value)} autoFocus>
                    <option value="">Modul wählen…</option>
                    {groups.map(g => (
                        <optgroup key={g.name} label={g.name}>
                            {g.modules.map(m => (
                                <option key={m.id} value={m.id}>{m.title} ({fmtCp(m.cp)})</option>
                            ))}
                        </optgroup>
                    ))}
                </select>
            </label>
            <label className="study-field narrow">Semester
                <input value={semester} onChange={e => setSemester(e.target.value)} placeholder="z. B. 6." />
            </label>
            <div className="study-form-actions">
                <button className="study-btn primary" disabled={!moduleId}
                        onClick={() => onSave({ module_id: Number(moduleId), semester: semester.trim() || null })}>
                    Aufnehmen
                </button>
                <button className="study-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}
