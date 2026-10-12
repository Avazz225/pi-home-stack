import { useState, useEffect, useCallback } from "react"
import {
    fetchOverview, createCategory, updateCategory, deleteCategory, fetchSettings, saveSettings,
} from "../api"
import { fmtCp } from "../shared"
import "./categories.css"

export default function CategoryList() {
    const [data, setData] = useState(null)
    const [settings, setSettings] = useState(null)
    const [error, setError] = useState(false)
    const [editingId, setEditingId] = useState(null)
    const [confirmId, setConfirmId] = useState(null)
    const [adding, setAdding] = useState(false)

    const refresh = useCallback(async () => {
        try {
            const [overview, config] = await Promise.all([fetchOverview(), fetchSettings()])
            setData(overview)
            setSettings(config)
            setError(false)
        } catch {
            setError(true)
        }
    }, [])

    useEffect(() => { refresh() }, [refresh])

    if (error) return <div className="study-status error">Studium-Service nicht erreichbar.</div>
    if (!data || !settings) return <div className="study-status">Lädt…</div>

    const categories = data.categories
    const sumMin = categories.reduce((acc, c) => acc + (c.cp_min || 0), 0)
    const sumMax = categories.reduce((acc, c) => acc + (c.cp_max || 0), 0)
    const target = Number(settings.target_cp)

    /* Renumbers the whole list instead of swapping two positions — categories
       created at different times can share a position, and a swap would then be
       a no-op. The list is short enough that the extra PUTs do not matter. */
    async function move(index, delta) {
        const target = index + delta
        if (target < 0 || target >= categories.length) return
        const reordered = [...categories]
        const [moved] = reordered.splice(index, 1)
        reordered.splice(target, 0, moved)
        await Promise.all(reordered.map((c, i) => (c.position === i ? null : updateCategory(c.id, { position: i }))))
        refresh()
    }

    return (
        <div className="study-view cat-view">
            <div className="study-card">
                <h4 className="study-h4">Regelabschluss</h4>
                <TargetForm value={settings.target_cp}
                            onSave={async value => { await saveSettings({ target_cp: value }); refresh() }} />
                <p className="study-empty">
                    Summe der Fachrichtungen: {fmtCp(sumMin)} bis {fmtCp(sumMax)}.
                    {sumMax < target && ` Das Maximum liegt unter dem Regelabschluss – es fehlen ${fmtCp(target - sumMax)}.`}
                    {sumMin > target && ` Das Minimum liegt über dem Regelabschluss – ${fmtCp(sumMin - target)} zu viel.`}
                </p>
            </div>

            {categories.map((cat, i) => (
                <div key={cat.id} className="study-card">
                    <div className="study-card-header">
                        <h4>{cat.name}</h4>
                        {!!cat.is_thesis && <span className="study-chip study-chip-thesis">Thesis</span>}
                        <span className="study-meta study-num">
                            {cat.cp_min ?? "?"}–{cat.cp_max ?? "?"} CP · {cat.stats.modules_total} {cat.stats.modules_total === 1 ? "Modul" : "Module"} · {fmtCp(cat.stats.cp_done)} abgeschlossen
                        </span>
                        <span className="cat-order">
                            <button className="study-icon-btn" title="Nach oben" disabled={i === 0} onClick={() => move(i, -1)}>↑</button>
                            <button className="study-icon-btn" title="Nach unten" disabled={i === categories.length - 1} onClick={() => move(i, 1)}>↓</button>
                        </span>
                        <button className="study-icon-btn" title="Bearbeiten"
                                onClick={() => setEditingId(editingId === cat.id ? null : cat.id)}>✎</button>
                        <button className="study-icon-btn delete" title="Löschen" onClick={() => setConfirmId(cat.id)}>✕</button>
                    </div>

                    {editingId === cat.id && (
                        <CategoryForm category={cat}
                                      onSave={async values => { await updateCategory(cat.id, values); setEditingId(null); refresh() }}
                                      onCancel={() => setEditingId(null)} />
                    )}
                    {confirmId === cat.id && (
                        <div className="study-confirm">
                            „{cat.name}“ löschen? Die {cat.stats.modules_total} zugeordneten Module wandern in den
                            Ideenpool und zählen dann auf keine Fachrichtung mehr ein.
                            <button className="study-btn danger"
                                    onClick={() => deleteCategory(cat.id).then(() => { setConfirmId(null); refresh() })}>Löschen</button>
                            <button className="study-btn" onClick={() => setConfirmId(null)}>Abbrechen</button>
                        </div>
                    )}
                </div>
            ))}

            {adding ? (
                <div className="study-card">
                    <CategoryForm onSave={async values => { await createCategory(values); setAdding(false); refresh() }}
                                  onCancel={() => setAdding(false)} />
                </div>
            ) : (
                <button className="study-add-btn" onClick={() => setAdding(true)}>+ Fachrichtung</button>
            )}
        </div>
    )
}

function TargetForm({ value, onSave }) {
    const [target, setTarget] = useState(value)

    return (
        <div className="study-form">
            <label className="study-field narrow">Credit Points gesamt
                <input type="number" min="0" step="1" inputMode="numeric"
                       value={target} onChange={e => setTarget(e.target.value)} />
            </label>
            <div className="study-form-actions">
                <button className="study-btn primary" disabled={target === value} onClick={() => onSave(target)}>Speichern</button>
            </div>
        </div>
    )
}

function CategoryForm({ category, onSave, onCancel }) {
    const [name, setName] = useState(category?.name ?? "")
    const [cpMin, setCpMin] = useState(category?.cp_min ?? "")
    const [cpMax, setCpMax] = useState(category?.cp_max ?? "")
    const [isThesis, setIsThesis] = useState(!!category?.is_thesis)

    function submit() {
        if (!name.trim()) return
        onSave({
            name: name.trim(),
            cp_min: cpMin === "" ? null : Number(cpMin),
            cp_max: cpMax === "" ? null : Number(cpMax),
            is_thesis: isThesis,
        })
    }

    return (
        <div className="study-form">
            <label className="study-field wide">Name
                <input value={name} onChange={e => setName(e.target.value)} autoFocus
                       placeholder="z. B. Fachstudium Informatik" />
            </label>
            <label className="study-field narrow">CP Minimum
                <input type="number" min="0" step="1" inputMode="numeric"
                       value={cpMin} onChange={e => setCpMin(e.target.value)} />
            </label>
            <label className="study-field narrow">CP Maximum
                <input type="number" min="0" step="1" inputMode="numeric"
                       value={cpMax} onChange={e => setCpMax(e.target.value)} />
            </label>
            <label className="study-field wide cat-thesis-toggle">
                <span>
                    <input type="checkbox" checked={isThesis} onChange={e => setIsThesis(e.target.checked)} />
                    Thesis – zählt separat
                </span>
                <span className="study-empty">
                    Der Fortschrittsbalken zeigt diese CP als eigenen Block am Ende und rechnet
                    „noch n CP bis zur Thesis“ ohne sie. Nur eine Fachrichtung kann das sein.
                </span>
            </label>
            <div className="study-form-actions">
                <button className="study-btn primary" onClick={submit}>Speichern</button>
                <button className="study-btn" onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}
