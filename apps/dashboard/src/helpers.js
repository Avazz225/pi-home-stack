const SETTINGS_TEMPLATE = {
    "autoSwitch":true,
    "autoSwitchTime": 1,
    "autoSwitchUnit": "h",
    "galleryPauseAtNight":true,
    "galleryDisplayTimeStart": "06:00",
    "galleryDisplayTimeEnd": "22:00",
    "dashSwitch": false,
    "dashSwitchTime": 1,
    "dashSwitchUnit": "m",
}

function loadSettings(){
    let sett = localStorage.getItem("settings")
    if (sett == null){
        localStorage.setItem("settings", JSON.stringify(SETTINGS_TEMPLATE))
        return SETTINGS_TEMPLATE
    } else {
        return JSON.parse(sett)
    }
}

function updateSettings(newSettings){
    localStorage.setItem("settings", JSON.stringify(newSettings))
}

function calcDelay(num, unit){
    if (unit === 's') {
        return num * 1000;
    } else if (unit === 'm') {
        return num * 1000 * 60;
    } else if (unit === 'h') {
        return num * 1000 * 60 * 60;
    } else if (unit === 'd') {
        return num * 1000 * 60 * 60 * 24;
    }
}

function loadTodos(){
    const raw = localStorage.getItem("todos")
    return raw ? JSON.parse(raw) : []
}

function saveTodos(todos){
    localStorage.setItem("todos", JSON.stringify(todos))
}

function loadQuicklinks(){
    const raw = localStorage.getItem("quicklinks")
    return raw ? JSON.parse(raw) : []
}

function saveQuicklinks(categories){
    localStorage.setItem("quicklinks", JSON.stringify(categories))
}


function generateId(){
    if (typeof crypto !== "undefined" && crypto.randomUUID) {
        return crypto.randomUUID()
    }
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0
        return (c === "x" ? r : (r & 0x3 | 0x8)).toString(16)
    })
}

function exportConfig(){
    const data = {
        version: 1,
        exported: new Date().toISOString(),
        settings: JSON.parse(localStorage.getItem("settings") || "{}"),
        todos: JSON.parse(localStorage.getItem("todos") || "[]"),
        quicklinks: JSON.parse(localStorage.getItem("quicklinks") || "[]"),
        lastOption: localStorage.getItem("lastOption") || "network_speed",
    }
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `dashboard-config-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
}

function importConfig(file, onSuccess, onError){
    const reader = new FileReader()
    reader.onload = (e) => {
        try {
            const data = JSON.parse(e.target.result)
            if (data.settings)   localStorage.setItem("settings",   JSON.stringify(data.settings))
            if (data.todos)      localStorage.setItem("todos",      JSON.stringify(data.todos))
            if (data.quicklinks) localStorage.setItem("quicklinks", JSON.stringify(data.quicklinks))
            if (data.lastOption) localStorage.setItem("lastOption", data.lastOption)
            onSuccess()
        } catch {
            onError()
        }
    }
    reader.readAsText(file)
}

// ── Profile API ──────────────────────────────────────────────────────────────

const PROFILE_API = process.env.REACT_APP_PROFILE_API_ENDPOINT || ""

async function apiFetchProfiles(){
    const r = await fetch(`${PROFILE_API}/profiles`)
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
}

async function apiFetchProfile(name){
    const r = await fetch(`${PROFILE_API}/profiles/${encodeURIComponent(name)}`)
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
}

async function apiSaveProfile(name){
    const body = {
        settings:   JSON.parse(localStorage.getItem("settings")   || "{}"),
        todos:      JSON.parse(localStorage.getItem("todos")       || "[]"),
        quicklinks: JSON.parse(localStorage.getItem("quicklinks")  || "[]"),
        lastOption: localStorage.getItem("lastOption") || "network_speed",
    }
    const r = await fetch(`${PROFILE_API}/profiles/${encodeURIComponent(name)}`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(body),
    })
    if (!r.ok) throw new Error(r.statusText)
    localStorage.setItem("activeProfile", name)
}

async function apiFetchTodos(){
    const r = await fetch(`${PROFILE_API}/todos`)
    if (!r.ok) throw new Error(r.statusText)
    return r.json()
}

async function apiSaveTodos(todos){
    await fetch(`${PROFILE_API}/todos`, {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(todos),
    })
}

async function apiDeleteProfile(name){
    await fetch(`${PROFILE_API}/profiles/${encodeURIComponent(name)}`, { method: "DELETE" })
    if (localStorage.getItem("activeProfile") === name){
        localStorage.removeItem("activeProfile")
    }
}

function applyProfileData(data){
    if (data.settings)   localStorage.setItem("settings",   JSON.stringify(data.settings))
    if (data.todos) {
        localStorage.setItem("todos", JSON.stringify(data.todos))
        apiSaveTodos(data.todos).catch(() => {})
    }
    if (data.quicklinks) localStorage.setItem("quicklinks", JSON.stringify(data.quicklinks))
    if (data.lastOption) localStorage.setItem("lastOption", data.lastOption)
    localStorage.setItem("activeProfile", data.name)
}

export {loadSettings, updateSettings, calcDelay, loadTodos, saveTodos, loadQuicklinks, saveQuicklinks, exportConfig, importConfig, generateId, apiFetchProfiles, apiFetchProfile, apiSaveProfile, apiDeleteProfile, applyProfileData, apiFetchTodos, apiSaveTodos}