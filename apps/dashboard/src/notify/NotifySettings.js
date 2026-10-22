import { useCallback, useEffect, useState } from "react"
import {
    fetchKinds, fetchRules, createRule, updateRule, deleteRule, checkRulesNow,
    fetchChannels, createChannel, deleteChannel, testChannel,
} from "./api"
import { useUser } from "../common/user"
import Hint from "../common/Hint"
import "./notify.css"

/* What this person wants to be told, and where.
 *
 * The rule kinds come from the service rather than being listed here: each one
 * knows which settings it needs, so a kind added there appears here by itself
 * with the right fields. That is the only reason this screen stays one screen.
 */

const MINUTES = (seconds) => Math.max(1, Math.round((seconds || 3600) / 60))

export default function NotifySettings() {
    const { userId } = useUser()
    const [kinds, setKinds] = useState([])
    const [rules, setRules] = useState([])
    const [channels, setChannels] = useState([])
    const [adding, setAdding] = useState(null)
    const [url, setUrl] = useState("")
    const [busy, setBusy] = useState(false)
    const [message, setMessage] = useState("")
    const [error, setError] = useState("")

    const refresh = useCallback(async () => {
        if (!userId) return
        try {
            const [k, r, c] = await Promise.all([fetchKinds(), fetchRules(), fetchChannels()])
            setKinds(k)
            setRules(r)
            setChannels(c)
            setError("")
        } catch (e) {
            setError(e.message)
        }
    }, [userId])

    useEffect(() => { refresh() }, [refresh])

    async function run(action, note) {
        setBusy(true)
        try {
            const result = await action()
            await refresh()
            setError("")
            setMessage(typeof note === "function" ? note(result) : note || "")
        } catch (e) {
            setError(e.message)
            setMessage("")
        } finally {
            setBusy(false)
        }
    }

    if (!userId) {
        return <p className="user-hint">
            Benachrichtigungen gehören zu einem Benutzer — oben rechts einen auswählen.
        </p>
    }
    if (error && kinds.length === 0) {
        return <p className="user-hint">Benachrichtigungsdienst nicht erreichbar: {error}</p>
    }

    const spec = kinds.find(k => k.kind === adding)

    return (
        <div>
            <p className="user-hint">
                Geprüft wird jede Minute. Eine Regel, die gerade gemeldet hat, schweigt für
                die eingestellte Wartezeit — sonst käme eine Meldung pro Minute, bis jemand
                das Licht ausmacht.
            </p>

            {rules.length === 0 && <p className="user-hint">Noch keine Regel.</p>}

            <div className="ns-rules">
                {rules.map(rule => (
                    <div key={rule.id} className="home-row" data-off={!rule.enabled}>
                        <span className="home-row-title">{rule.name}</span>
                        <span className="home-meta">
                            {Object.entries(rule.params || {})
                                .filter(([, v]) => v !== "" && v != null)
                                .map(([k, v]) => `${k}: ${v}`).join(", ") || "alle"}
                            {` · ${MINUTES(rule.cooldown_s)} min Ruhe`}
                        </span>
                        <span className="fps-spacer" />
                        <label className="fps-inline">
                            <input type="checkbox" checked={!!rule.enabled} disabled={busy}
                                   onChange={e => run(() => updateRule(rule.id,
                                       { enabled: e.target.checked }))} />
                            aktiv
                        </label>
                        <button className="profile-action-btn danger" disabled={busy}
                                onClick={() => run(() => deleteRule(rule.id), "Regel entfernt.")}>
                            ✕
                        </button>
                    </div>
                ))}
            </div>

            {!adding && (
                <div className="profile-save-row">
                    <select className="set-room-select" value="" disabled={busy}
                            aria-label="Regel hinzufügen"
                            onChange={e => e.target.value && setAdding(e.target.value)}>
                        <option value="">+ Regel hinzufügen…</option>
                        {kinds.map(k => <option key={k.kind} value={k.kind}>{k.label}</option>)}
                    </select>
                    {rules.length > 0 && (
                        <button className="profile-action-btn" disabled={busy}
                                onClick={() => run(checkRulesNow, r => r.sent
                                    ? `${r.sent} Meldung(en) erzeugt.`
                                    : "Nichts zu melden.")}>
                            Jetzt prüfen
                        </button>
                    )}
                </div>
            )}

            {spec && <RuleForm spec={spec} busy={busy}
                               onCancel={() => setAdding(null)}
                               onSave={params => run(
                                   () => createRule({ kind: spec.kind, params, name: spec.label }),
                                   "Regel angelegt.").then(() => setAdding(null))} />}

            <div className="ns-channels">
                <b>Zusätzlich zustellen</b>
                <Hint>
                    Ein Webhook, kein eigener Dienst je Anbieter: ntfy, Gotify, Home Assistant
                    und Discord nehmen alle einen POST entgegen. Wer eigene Feldnamen braucht,
                    hinterlegt eine Vorlage mit <code>{"{{title}}"}</code>,{" "}
                    <code>{"{{body}}"}</code>, <code>{"{{level}}"}</code>.
                </Hint>
                {channels.length === 0 && (
                    <p className="user-hint">
                        Nur die Glocke im Dashboard. Das erreicht dich, wenn du hinsiehst.
                    </p>
                )}
                {channels.map(channel => (
                    <div key={channel.id} className="home-row">
                        <span className="home-row-title">{channel.config.url}</span>
                        {channel.last_error
                            ? <span className="home-meta nb-error">{channel.last_error}</span>
                            : <span className="home-meta">bereit</span>}
                        <span className="fps-spacer" />
                        <button className="profile-action-btn" disabled={busy}
                                onClick={() => run(() => testChannel(channel.id),
                                                   "Testnachricht geschickt.")}>
                            Testen
                        </button>
                        <button className="profile-action-btn danger" disabled={busy}
                                onClick={() => run(() => deleteChannel(channel.id), "Entfernt.")}>
                            ✕
                        </button>
                    </div>
                ))}
                <div className="profile-save-row">
                    <input className="profile-name-input" value={url}
                           placeholder="https://ntfy.local/haus"
                           onChange={e => setUrl(e.target.value)} />
                    <button className="profile-save-btn" disabled={busy || !url.trim()}
                            onClick={() => { run(() => createChannel(
                                { kind: "webhook", config: { url: url.trim() } }),
                                "Kanal angelegt."); setUrl("") }}>
                        Hinzufügen
                    </button>
                </div>
            </div>

            {message && <p className="user-hint">{message}</p>}
            {error && <p className="io-status error">{error}</p>}
        </div>
    )
}

/* The form for one new rule, built from what the kind says it needs. A room
   field offers the rooms this flat has; anything else is a number. */
function RuleForm({ spec, busy, onSave, onCancel }) {
    const [values, setValues] = useState(() => Object.fromEntries(
        (spec.params || []).map(p => [p.name, p.default ?? ""])))

    return (
        <div className="ns-form">
            <b>{spec.label}</b>
            {(spec.params || []).length === 0 && (
                <p className="user-hint">Diese Regel braucht keine Einstellung.</p>
            )}
            {(spec.params || []).map(param => (
                <label key={param.name} className="home-field">
                    {param.label}
                    <input type={param.type === "number" ? "number" : "text"}
                           value={values[param.name] ?? ""}
                           onChange={e => setValues(v => ({ ...v, [param.name]: e.target.value }))} />
                </label>
            ))}
            <div className="profile-save-row">
                <button className="profile-save-btn" disabled={busy}
                        onClick={() => onSave(Object.fromEntries(
                            Object.entries(values).filter(([, v]) => v !== "")))}>
                    Anlegen
                </button>
                <button className="profile-action-btn" disabled={busy}
                        onClick={onCancel}>Abbrechen</button>
            </div>
        </div>
    )
}
