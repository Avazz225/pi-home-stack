import { useState, useEffect } from "react"
import { fetchOverview, createModule, updateModule, deleteModule } from "../api"
import {
    CpBar, StateBadge, STATUS_LABELS, EXAM_FORMS, examFormLabel, fmtCp, fmtGrade, ModuleLink,
} from "../shared"
import "./modules.css"

const STATUS_FILTERS = { alle: "Alle", offen: "Offen", geplant: "Geplant", laufend: "Laufend", abgeschlossen: "Abgeschlossen" }

const EMPTY = {
    title: "", cp: "", exam_form: "", contact: "", faculty: "", url: "",
    status: "offen", grade: "", semester: "", note: "",
}

/* Empty inputs must reach the API as NULL, not as "" — otherwise an emptied CP
   field would be stored as text and silently drop out of every sum. */
function toNumber(value) {
    if (value === "" || value === null || value === undefined) return null
    const num = Number(String(value).replace(",", "."))
    return Number.isNaN(num) ? null : num
}

function toText(value) {
    const text = (value ?? "").toString().trim()
    return text === "" ? null : text
}

export default function ModuleList() {
    const [data, setData] = useState(null)
    const [error, setError] = useState(false)
    const [query, setQuery] = useState("")
    const [statusFilter, setStatusFilter] = useState("alle")
    const [editingId, setEditingId] = useState(null)
    const [quickId, setQuickId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)
    const [addingTo, setAddingTo] = useState(undefined)

    async function refresh() {
        try {
            setData(await fetchOverview())
            setError(false)
        } catch {
            setError(true)
        }
    }

    useEffect(() => { refresh() }, [])

    if (error) return <div className="study-status error">Studium-Service nicht erreichbar.</div>
    if (!data) return <div className="study-status">Lädt…</div>

    const groups = [
        ...data.categories.map(c => ({ id: c.id, name: c.name, cp_min: c.cp_min, cp_max: c.cp_max, stats: c.stats, modules: c.modules })),
        { id: null, name: "Ideenpool", modules: data.pool, hint: "Zählt auf keine Fachrichtung ein." },
    ]

    const term = query.trim().toLowerCase()
    const matches = (m) =>
        (statusFilter === "alle" || m.status === statusFilter) &&
        (term === "" || `${m.title} ${m.contact || ""} ${m.semester || ""}`.toLowerCase().includes(term))

    async function save(id, values) {
        await updateModule(id, values)
        setEditingId(null)
        setQuickId(null)
        refresh()
    }

    return (
        <div className="study-view">
            <div className="study-card mod-filters">
                <input className="mod-search" placeholder="Modul, Ansprechpartner, Semester…"
                       value={query} onChange={e => setQuery(e.target.value)} />
                <div className="mod-filter-chips">
                    {Object.entries(STATUS_FILTERS).map(([key, label]) => (
                        <button key={key} className={`study-chip mod-filter${key === statusFilter ? " active" : ""}`}
                                onClick={() => setStatusFilter(key)}>{label}</button>
                    ))}
                </div>
            </div>

            {groups.map(group => {
                const visible = group.modules.filter(matches)
                return (
                    <div key={group.id ?? "pool"} className="study-card">
                        <div className="study-card-header">
                            <h4>{group.name}</h4>
                            {group.stats && (
                                <>
                                    <span className="study-meta study-num">
                                        {fmtCp(group.stats.cp_committed)} von {group.cp_min ?? "?"}–{group.cp_max ?? "?"} CP
                                    </span>
                                    <StateBadge state={group.stats.state} value={group.stats.cp_committed}
                                                min={group.cp_min} max={group.cp_max} />
                                </>
                            )}
                        </div>
                        {group.stats && (
                            <CpBar done={group.stats.cp_done}
                                   planned={Math.max(group.stats.cp_committed - group.stats.cp_done, 0)}
                                   min={group.cp_min} max={group.cp_max} state={group.stats.state} />
                        )}
                        {group.hint && <p className="study-empty">{group.hint}</p>}

                        {visible.length === 0 && <p className="study-empty">Kein Modul passt zum Filter.</p>}
                        {visible.map(m => (
                            <div key={m.id} className="mod-row-wrap">
                                <ModuleRow
                                    module={m}
                                    onQuick={() => { setQuickId(quickId === m.id ? null : m.id); setEditingId(null) }}
                                    onEdit={() => { setEditingId(editingId === m.id ? null : m.id); setQuickId(null) }}
                                    onDelete={() => setConfirmId(m.id)}
                                />
                                {m.note && <p className="study-empty mod-note">{m.note}</p>}
                                {confirmId === m.id && (
                                    <div className="study-confirm">
                                        „{m.title}“ wirklich löschen?
                                        <button className="study-btn danger" onClick={() => deleteModule(m.id).then(() => { setConfirmId(null); refresh() })}>Löschen</button>
                                        <button className="study-btn" onClick={() => setConfirmId(null)}>Abbrechen</button>
                                    </div>
                                )}
                                {quickId === m.id && <QuickDoneForm module={m} onSave={save} onCancel={() => setQuickId(null)} />}
                                {editingId === m.id && (
                                    <ModuleForm module={m} categories={data.categories}
                                                onSave={values => save(m.id, values)}
                                                onCancel={() => setEditingId(null)} />
                                )}
                            </div>
                        ))}

                        {addingTo === group.id ? (
                            <ModuleForm categories={data.categories} categoryId={group.id}
                                        onSave={async values => { await createModule(values); setAddingTo(undefined); refresh() }}
                                        onCancel={() => setAddingTo(undefined)} />
                        ) : (
                            <button className="study-add-btn" onClick={() => setAddingTo(group.id)}>+ Modul</button>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

function ModuleRow({ module, onQuick, onEdit, onDelete }) {
    const details = [
        fmtCp(module.cp),
        module.semester && `${module.semester} Semester`,
        examFormLabel(module.exam_form),
        module.contact,
        module.faculty && `Fak. ${module.faculty}`,
    ].filter(Boolean)

    return (
        <div className="mod-row">
            <span className={`study-chip study-chip-${module.status}`}>{STATUS_LABELS[module.status]}</span>
            <span className="mod-row-title">{module.title}<ModuleLink url={module.url} /></span>
            <span className="study-meta mod-row-details">{details.join(" · ")}</span>
            {module.grade !== null && module.grade !== undefined && (
                <span className="mod-row-grade"><span className="mod-grade-label">Note </span>{fmtGrade(module.grade)}</span>
            )}
            <span className="mod-row-actions">
                {module.status !== "abgeschlossen" && (
                    <button className="study-icon-btn" onClick={onQuick} title="Als abgeschlossen eintragen">✓</button>
                )}
                <button className="study-icon-btn" onClick={onEdit} title="Bearbeiten">✎</button>
                <button className="study-icon-btn delete" onClick={onDelete} title="Löschen">✕</button>
            </span>
        </div>
    )
}

/* The one entry that happens over and over: a module is finished, note down the
   grade and the semester without opening the full form. */
function QuickDoneForm({ module, onSave, onCancel }) {
    const [grade, setGrade] = useState(module.grade ?? "")
    const [semester, setSemester] = useState(module.semester ?? "")

    return (
        <div className="study-form mod-quick">
            <label className="study-field narrow">Note
                <input type="number" step="0.1" min="1" max="5" inputMode="decimal"
                       value={grade} onChange={e => setGrade(e.target.value)} />
            </label>
            <label className="study-field narrow">Semester
                <input value={semester} onChange={e => setSemester(e.target.value)} />
            </label>
            <div className="study-form-actions">
                <button className="study-btn primary"
                        onClick={() => onSave(module.id, { status: "abgeschlossen", grade: toNumber(grade), semester: toText(semester) })}>
                    Abgeschlossen
                </button>
                <button className="study-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}

function ModuleForm({ module, categories, categoryId, onSave, onCancel }) {
    const [form, setForm] = useState(() => ({
        ...EMPTY,
        ...(module ? Object.fromEntries(Object.keys(EMPTY).map(k => [k, module[k] ?? ""])) : {}),
        category_id: module ? module.category_id : (categoryId ?? null),
    }))
    const set = (key) => (e) => setForm({ ...form, [key]: e.target.value })

    function submit() {
        if (!form.title.trim()) return
        onSave({
            category_id: form.category_id === "" || form.category_id === null ? null : Number(form.category_id),
            title: form.title.trim(),
            cp: toNumber(form.cp),
            exam_form: toText(form.exam_form),
            contact: toText(form.contact),
            faculty: toText(form.faculty),
            url: toText(form.url),
            status: form.status,
            grade: toNumber(form.grade),
            semester: toText(form.semester),
            note: toText(form.note),
        })
    }

    return (
        <div className="study-form mod-form">
            <label className="study-field wide">Titel
                <input value={form.title} onChange={set("title")} autoFocus />
            </label>
            <label className="study-field">Fachrichtung
                <select value={form.category_id ?? ""} onChange={set("category_id")}>
                    <option value="">Ideenpool</option>
                    {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
            </label>
            <label className="study-field narrow">CP
                <input type="number" step="0.5" min="0" inputMode="decimal" value={form.cp} onChange={set("cp")} />
            </label>
            <label className="study-field narrow">Semester
                <input value={form.semester} onChange={set("semester")} placeholder="z. B. 5." />
            </label>
            <label className="study-field">Status
                <select value={form.status} onChange={set("status")}>
                    {Object.entries(STATUS_LABELS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </select>
            </label>
            <label className="study-field narrow">Note
                <input type="number" step="0.1" min="1" max="5" inputMode="decimal" value={form.grade} onChange={set("grade")} />
            </label>
            <label className="study-field">Prüfungsform
                <input list="study-exam-forms" value={form.exam_form} onChange={set("exam_form")} placeholder="s / p" />
                <datalist id="study-exam-forms">
                    {Object.entries(EXAM_FORMS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
                </datalist>
            </label>
            <label className="study-field">Ansprechpartner
                <input value={form.contact} onChange={set("contact")} />
            </label>
            <label className="study-field narrow">Fakultät
                <input value={form.faculty} onChange={set("faculty")} placeholder="IV" />
            </label>
            <label className="study-field wide">Modullink
                <input type="url" value={form.url} onChange={set("url")} placeholder="https://moseskonto.tu-berlin.de/…" />
            </label>
            <label className="study-field wide">Notiz
                <textarea rows="2" value={form.note} onChange={set("note")} />
            </label>
            <div className="study-form-actions">
                <button className="study-btn primary" onClick={submit}>Speichern</button>
                <button className="study-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}
