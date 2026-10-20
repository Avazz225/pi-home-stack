import { useState, useRef, useEffect } from "react"
import MdiTick from "../icons/Tick"
import { exportConfig, importConfig, apiFetchProfiles, apiFetchProfile, apiSaveProfile, apiDeleteProfile, applyProfileData } from "../helpers"
import { THEME_MODES } from "../theme"
import { useUser, renameUser, deleteUser, fetchLegacy, adoptLegacy } from "../common/user"
import "./settings.css"

const NumPresets = [1, 5, 10, 15, 30]
const UnitPresets = ["s", "m", "h", "d"]

export default function Settings({settings, toggleSettings, updateSettings, theme}){
    return(
        <div className="settingsContainer">
            <div className="settingsPane">
                <Appearance theme={theme}/>
                <DashSwitch settings={settings} updateSettings={updateSettings}/>
                <GallerySwitch settings={settings} updateSettings={updateSettings}/>
                <GalleryPause settings={settings} updateSettings={updateSettings}/>
                <UserManager />
                <ProfileManager />
                <ConfigIO />
                <CloseBtn toggleSettings={toggleSettings}/>
            </div>
        </div>
    )
}

/* Who may use this dashboard, and what their names are.
 *
 * Choosing happens in the toolbar; this is the registry behind it. Renaming is
 * free because the services store an id, never a name - that is the whole
 * reason for the id.
 *
 * Deleting is not free and says so: this service can remove the entry and that
 * person's todo list, and it cannot reach into the tracking or study databases.
 * Promising otherwise would be worse than leaving the rows.
 */
function UserManager(){
    const { users, userId, select, refresh } = useUser()
    const [editing, setEditing] = useState(null)
    const [name, setName] = useState("")
    const [legacy, setLegacy] = useState(null)
    const [busy, setBusy] = useState(false)
    const [error, setError] = useState("")

    useEffect(() => {
        fetchLegacy().then(setLegacy).catch(() => setLegacy(null))
    }, [])

    async function run(action){
        setBusy(true)
        try {
            await action()
            await refresh()
            setError("")
        } catch (e) {
            setError(e.message)
        } finally {
            setBusy(false)
        }
    }

    async function save(id){
        const wanted = name.trim()
        if (!wanted) return setEditing(null)
        await run(() => renameUser(id, wanted))
        setEditing(null)
    }

    async function remove(user){
        // eslint-disable-next-line no-restricted-globals
        const sure = window.confirm(
            `${user.name} entfernen?\n\n` +
            "Die ToDo-Liste dieses Benutzers bleibt erhalten, ebenso alles in " +
            "Feature-Tracking und Modulplanung. Entfernt wird nur der Eintrag.")
        if (!sure) return
        await run(() => deleteUser(user.id))
    }

    return(
        <div>
            <b>Benutzer</b>
            <p className="user-hint">
                Kein Anmeldeverfahren — eine Liste von Namen für ein Netz, in dem sich alle
                kennen. Wer gerade dran ist, merkt sich jedes Gerät selbst.
            </p>

            {users.length === 0 && (
                <p className="user-hint">Noch niemand angelegt — oben rechts in der Leiste.</p>
            )}

            <div className="profile-list">
                {users.map(u => (
                    <div key={u.id} className={"profile-item" + (u.id === userId ? " active" : "")}>
                        {editing === u.id ? (
                            <input className="profile-name-input" value={name} autoFocus
                                   onChange={e => setName(e.target.value)}
                                   onKeyDown={e => { if (e.key === "Enter") save(u.id) }}
                                   onBlur={() => save(u.id)} />
                        ) : (
                            <span className="profile-name">{u.name}</span>
                        )}
                        {u.id !== userId && (
                            <button className="profile-action-btn" disabled={busy}
                                    onClick={() => select(u.id)}>Wechseln</button>
                        )}
                        <button className="profile-action-btn" disabled={busy}
                                onClick={() => { setEditing(u.id); setName(u.name) }}>Umbenennen</button>
                        <button className="profile-action-btn danger" disabled={busy}
                                onClick={() => remove(u)}>✕</button>
                    </div>
                ))}
            </div>

            {/* Only while there is something to adopt: data from before there
                were users belongs to nobody, and nobody would go looking for a
                button that explains that. */}
            {legacy && legacy.todos > 0 && (
                <div className="user-hint">
                    Aus der Zeit vor den Benutzern liegen {legacy.todos} ToDo-Einträge ohne
                    Besitzer. {userId
                        ? <button className="profile-action-btn" disabled={busy}
                                  onClick={() => run(async () => {
                                      await adoptLegacy()
                                      setLegacy(await fetchLegacy())
                                  })}>Mir zuordnen</button>
                        : "Dafür zuerst oben rechts einen Benutzer wählen."}
                </div>
            )}

            {error && <p className="io-status error">{error}</p>}
        </div>
    )
}

function CloseBtn({toggleSettings}){
    return(
        <button className="invisibleBtn settCloseBtn" onClick={() => toggleSettings()}>
            <MdiTick/>
        </button>
    )
}

/* The theme is a per-device preference, so it is kept out of the synced settings
 * object and stored under its own localStorage key by src/theme.js. */
function Appearance({theme}){
    if (!theme) return null
    return(
        <div>
            <b>Darstellung</b>
            <div className="btnWrapper">
                {THEME_MODES.map(({key, label}) => (
                    <button
                        key={key}
                        className={"multiSelectBtn theme-btn" + (theme.mode === key ? " active" : "")}
                        onClick={() => theme.selectMode(key)}
                    >
                        {label}
                    </button>
                ))}
            </div>
            {theme.mode === "auto" &&
                <p className="settings-caption">Folgt dem System – aktuell {theme.resolved === "dark" ? "dunkel" : "hell"}.</p>
            }
        </div>
    )
}

function DashSwitch({settings, updateSettings}){
    return(
        <div>
            <b>Dashboard</b><br/>
            Automatisch umschalten
            <input type="checkbox" checked={settings.dashSwitch} onClick={() => updateSettings("dashSwitch", !settings.dashSwitch)} />
            {settings.dashSwitch &&
            <>
                <Numbers currentVal={settings.dashSwitchTime} sekey={"dashSwitchTime"} updateSettings={updateSettings}/>
                <Units exclude={["d", "h"]} currentVal={settings.dashSwitchUnit} sekey={"dashSwitchUnit"} updateSettings={updateSettings}/>
            </>
            }
        </div>
    )
}

function GallerySwitch({settings, updateSettings}){
    return(
        <div>
            <b>Galerie</b><br/>
            Automatisch nächstes Bild
            <input type="checkbox" checked={settings.autoSwitch} onClick={() => updateSettings("autoSwitch", !settings.autoSwitch)} />
            {settings.autoSwitch &&
            <>
                <Numbers currentVal={settings.autoSwitchTime} sekey={"autoSwitchTime"} updateSettings={updateSettings}/>
                <Units currentVal={settings.autoSwitchUnit} sekey={"autoSwitchUnit"} updateSettings={updateSettings}/>
            </>
            }
        </div>
    )
}

function GalleryPause({settings, updateSettings}){
    return(
        <div>
            <b>Bildschirmschoner</b><br/>
            Galerie von ... bis ... anzeigen
            <input type="checkbox" checked={settings.galleryPauseAtNight} onClick={() => updateSettings("galleryPauseAtNight", !settings.galleryPauseAtNight)} />
            {settings.galleryPauseAtNight &&
            <div>
                <input type="time" value={((settings.galleryDisplayTimeStart.length === 5) ? "" : "0") + settings.galleryDisplayTimeStart} onChange={(e) => updateSettings("galleryDisplayTimeStart", e.target.value)} />-
                <input type="time" value={((settings.galleryDisplayTimeEnd.length === 5) ? "" : "0") + settings.galleryDisplayTimeEnd} onChange={(e) => updateSettings("galleryDisplayTimeEnd", e.target.value)} />
            </div>
            }
        </div>
    )
}

function ProfileManager(){
    const [profiles, setProfiles]     = useState([])
    const [nameInput, setNameInput]   = useState("")
    const [busy, setBusy]             = useState(false)
    const [status, setStatus]         = useState(null)
    const [serverOk, setServerOk]     = useState(true)
    const activeProfile = localStorage.getItem("activeProfile")

    useEffect(() => { refresh() }, [])

    async function refresh(){
        try {
            setProfiles(await apiFetchProfiles())
            setServerOk(true)
        } catch {
            setServerOk(false)
        }
    }

    function flash(type, msg){
        setStatus({ type, msg })
        setTimeout(() => setStatus(null), 3000)
    }

    async function handleSave(){
        const name = nameInput.trim()
        if (!name) return
        setBusy(true)
        try {
            await apiSaveProfile(name)
            setNameInput("")
            flash("ok", `„${name}" gespeichert.`)
            await refresh()
        } catch {
            flash("err", "Speichern fehlgeschlagen.")
        } finally { setBusy(false) }
    }

    async function handleLoad(name){
        setBusy(true)
        try {
            const data = await apiFetchProfile(name)
            applyProfileData(data)
            window.location.reload()
        } catch {
            flash("err", "Laden fehlgeschlagen.")
            setBusy(false)
        }
    }

    async function handleDelete(name){
        await apiDeleteProfile(name)
        await refresh()
    }

    return(
        <div>
            <b>Profile</b>
            {!serverOk && <p className="io-status error">Server nicht erreichbar.</p>}

            {profiles.length > 0 && (
                <div className="profile-list">
                    {profiles.map(p => (
                        <div key={p.name} className={"profile-item" + (p.name === activeProfile ? " active" : "")}>
                            <span className="profile-name">{p.name}</span>
                            <span className="profile-date">{fmtDate(p.savedAt)}</span>
                            <button className="profile-action-btn" onClick={() => handleLoad(p.name)} disabled={busy}>Laden</button>
                            <button className="profile-action-btn danger" onClick={() => handleDelete(p.name)}>✕</button>
                        </div>
                    ))}
                </div>
            )}

            <div className="profile-save-row">
                <input
                    className="profile-name-input"
                    value={nameInput}
                    onChange={e => setNameInput(e.target.value)}
                    onKeyDown={e => e.key === "Enter" && handleSave()}
                    placeholder="Profilname …"
                />
                <button
                    className="profile-save-btn"
                    onClick={handleSave}
                    disabled={busy || !nameInput.trim() || !serverOk}
                >
                    Speichern
                </button>
            </div>
            {status && <p className={"io-status " + (status.type === "ok" ? "success" : "error")}>{status.msg}</p>}
        </div>
    )
}

function fmtDate(iso){
    if (!iso) return ""
    const d = new Date(iso)
    return d.toLocaleString("de-DE", { day:"2-digit", month:"2-digit", year:"2-digit", hour:"2-digit", minute:"2-digit" })
}

function ConfigIO(){
    const [status, setStatus] = useState(null)
    const fileRef = useRef(null)

    function handleImport(e){
        const file = e.target.files[0]
        if (!file) return
        importConfig(
            file,
            () => { setStatus("success"); setTimeout(() => window.location.reload(), 900) },
            () => { setStatus("error");   setTimeout(() => setStatus(null), 3000) }
        )
        e.target.value = ""
    }

    return(
        <div>
            <b>Lokales Backup</b>
            <div className="btnWrapper">
                <button className="multiSelectBtn io-btn" onClick={exportConfig}>Exportieren</button>
                <button className="multiSelectBtn io-btn" onClick={() => fileRef.current.click()}>Importieren</button>
                <input ref={fileRef} type="file" accept=".json" style={{ display: "none" }} onChange={handleImport} />
            </div>
            {status === "success" && <p className="io-status success">Import erfolgreich – Seite wird neu geladen…</p>}
            {status === "error"   && <p className="io-status error">Ungültige Datei.</p>}
        </div>
    )
}

function Numbers({exclude=[], sekey, updateSettings, currentVal}){
    return(
        <div className="btnWrapper">
            {NumPresets.map((num) => <>
                {!exclude.includes(num) && <button className={(currentVal === num) ? "multiSelectBtn active" : "multiSelectBtn"} onClick={() => updateSettings(sekey, num)}>{num}</button>}
            </>)}
        </div>
    )
}

function Units({exclude=[], sekey, updateSettings, currentVal}){
    return(
        <div className="btnWrapper">
            {UnitPresets.map((unit) => <>
                {!exclude.includes(unit) && <button className={(currentVal === unit) ? "multiSelectBtn active" : "multiSelectBtn"} onClick={() => updateSettings(sekey, unit)}>{unit}</button>}
            </>)}
        </div>
    )
}
