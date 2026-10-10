import { useState, useEffect } from "react"
import { fetchConfig, saveConfig, checkConnection } from "../api"
import "./settings.css"

export default function BackupSettings() {
    const [config, setConfig] = useState(null)
    const [problems, setProblems] = useState([])
    const [loadError, setLoadError] = useState("")
    const [saving, setSaving] = useState(false)
    const [saved, setSaved] = useState(false)
    const [checking, setChecking] = useState(false)
    const [checkResult, setCheckResult] = useState(null)

    useEffect(() => {
        fetchConfig()
            .then(data => {
                const { problems: p, ...rest } = data
                setConfig(rest)
                setProblems(p || [])
            })
            .catch(e => setLoadError(e.message))
    }, [])

    function update(key, value) {
        setConfig(prev => ({ ...prev, [key]: value }))
        setSaved(false)
        setCheckResult(null)
    }

    async function submit() {
        setSaving(true)
        try {
            const { aws_secret_access_key_set, ...payload } = config
            const data = await saveConfig(payload)
            const { problems: p, ...rest } = data
            setConfig(rest)
            setProblems(p || [])
            setSaved(true)
            setLoadError("")
        } catch (e) {
            setLoadError(e.message)
        } finally {
            setSaving(false)
        }
    }

    async function runCheck() {
        setChecking(true)
        setCheckResult(null)
        try {
            setCheckResult(await checkConnection())
        } catch (e) {
            setCheckResult({ ok: false, problems: [e.message] })
        } finally {
            setChecking(false)
        }
    }

    if (loadError && !config) return <div className="backup-status error">Backup-Service nicht erreichbar: {loadError}</div>
    if (!config) return <div className="backup-status">Lädt…</div>

    return (
        <div className="backup-settings">
            {problems.length > 0 && (
                <div className="backup-status warn">
                    <strong>Noch offen:</strong>
                    <ul>{problems.map((p, i) => <li key={i}>{p}</li>)}</ul>
                </div>
            )}

            <label className="settings-toggle">
                <input
                    type="checkbox"
                    checked={config.enabled === "1"}
                    onChange={e => update("enabled", e.target.checked ? "1" : "0")}
                />
                <span>Sicherung aktiv — ohne diesen Haken bricht der nächtliche Cronjob ab</span>
            </label>

            <Section title="Quelle">
                <Field label="NAS-Wurzelverzeichnis" hint="Oberhalb dieses Pfades wird nichts gelesen.">
                    <input value={config.nas_root} onChange={e => update("nas_root", e.target.value)} />
                </Field>
            </Section>

            <Section title="AWS-Zugangsdaten"
                     note="Gelten für alle Ziele — Bucket, Region und Speicherklasse stehen unter „Ziele“. Leer lassen, um die Standard-Credential-Kette von boto3 zu nutzen (~/.aws oder Instance-Profile).">
                <Field label="Access Key ID">
                    <input
                        value={config.aws_access_key_id}
                        onChange={e => update("aws_access_key_id", e.target.value)}
                        autoComplete="off"
                    />
                </Field>
                <Field
                    label="Secret Access Key"
                    hint={config.aws_secret_access_key_set
                        ? "Gespeichert. Feld leeren und neu ausfüllen, um ihn zu ersetzen."
                        : "Noch nicht hinterlegt."}
                >
                    <input
                        type="password"
                        value={config.aws_secret_access_key}
                        onChange={e => update("aws_secret_access_key", e.target.value)}
                        autoComplete="new-password"
                    />
                </Field>
            </Section>

            <Section title="Verschlüsselung"
                     note="Der Schlüssel wird dem Passwort-Feld eines kdbx-Eintrags entnommen. kdbx-Dateien selbst werden unverschlüsselt gesichert, damit sie direkt nutzbar bleiben.">
                <Field label="Pfad zur kdbx-Datei">
                    <input value={config.kdbx_path} onChange={e => update("kdbx_path", e.target.value)} />
                </Field>
                <Field label="Titel des Schlüssel-Eintrags">
                    <input value={config.kdbx_entry_title} onChange={e => update("kdbx_entry_title", e.target.value)} />
                </Field>
                <Field label="Datei mit dem kdbx-Master-Passwort" hint="Muss chmod 600 sein, sonst verweigert der Job den Start.">
                    <input value={config.kdbx_password_file} onChange={e => update("kdbx_password_file", e.target.value)} />
                </Field>
            </Section>

            <Section title="Aufbewahrung">
                <Field label="Gelöschte Dateien aufbewahren (Tage)"
                       hint="Verschwundene oder abgewählte Dateien bekommen einen Löschmarker und werden erst nach dieser Frist aus S3 entfernt.">
                    <input
                        type="number" min="1" max="3650"
                        value={config.retention_days}
                        onChange={e => update("retention_days", e.target.value)}
                    />
                </Field>
                <Field label="Zwischenspeicher für verschlüsselte Dateien" hint="Leer = System-Temp. Muss genug Platz für die größte Datei haben.">
                    <input value={config.staging_dir} onChange={e => update("staging_dir", e.target.value)} />
                </Field>
            </Section>

            <div className="settings-actions">
                <button className="primary" onClick={submit} disabled={saving}>
                    {saving ? "Speichert…" : "Speichern"}
                </button>
                <button onClick={runCheck} disabled={checking}>
                    {checking ? "Prüft…" : "Verbindung prüfen"}
                </button>
                {saved && <span className="settings-ok">Gespeichert.</span>}
            </div>

            {checkResult && (
                <div className={`backup-status ${checkResult.ok ? "ok" : "error"}`}>
                    {checkResult.ok
                        ? "Bucket erreichbar und Backup-Schlüssel lesbar."
                        : <><strong>Prüfung fehlgeschlagen:</strong>
                            <ul>{checkResult.problems.map((p, i) => <li key={i}>{p}</li>)}</ul></>}
                </div>
            )}
        </div>
    )
}

function Section({ title, note, children }) {
    return (
        <div className="settings-section">
            <h4>{title}</h4>
            {note && <p className="settings-note">{note}</p>}
            {children}
        </div>
    )
}

function Field({ label, hint, children }) {
    return (
        <div className="settings-field">
            <label>{label}</label>
            {children}
            {hint && <span className="settings-hint">{hint}</span>}
        </div>
    )
}
