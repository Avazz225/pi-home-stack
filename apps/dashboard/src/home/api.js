import { userHeaders } from "../common/user"

const HOME_API = process.env.REACT_APP_HOME_API_ENDPOINT || ""

async function request(path, options) {
    /* no-store, on every call: an answer from a service is a fact about right
       now, never a document. It matters most when the service was not there
       yet - nginx then serves the dashboard's own page for that path with
       status 200, and a browser that keeps it replays that page long after the
       service exists. Which is exactly how a missing route survived its own
       repair.
    */
    /* Built unconditionally: it used to be passed only when there were options,
       so a plain GET went out with no headers at all - and the overview has to
       say who is asking, or everyone gets the flat's arrangement instead of
       their own. */
    const r = await fetch(`${HOME_API}${path}`, {
        ...options,
        cache: "no-store",
        headers: { "Content-Type": "application/json", ...userHeaders() },
        body: options && options.body ? JSON.stringify(options.body) : undefined,
    })
    if (!r.ok) {
        // The service answers failed device calls with a readable reason rather
        // than only a status code, so it is worth digging out.
        let detail = r.statusText
        try {
            const payload = await r.json()
            detail = payload.error || payload.message || detail
        } catch { /* no JSON body */ }
        throw new Error(detail)
    }
    return r.json()
}

export const fetchOverview = () => request("/overview")

export const createRoom = (data) => request("/rooms", { method: "POST", body: data })
export const updateRoom = (id, data) => request(`/rooms/${id}`, { method: "PUT", body: data })
export const deleteRoom = (id) => request(`/rooms/${id}`, { method: "DELETE" })

export const bindDevice = (roomId, data) => request(`/rooms/${roomId}/devices`, { method: "POST", body: data })
export const unbindDevice = (id) => request(`/devices/${id}`, { method: "DELETE" })

export const setLight = (lightId, data) => request(`/lights/${lightId}`, { method: "POST", body: data })
export const setRoomLights = (roomId, data) => request(`/rooms/${roomId}/lights`, { method: "POST", body: data })

export const discoverHue = () => request("/hue/discover")
export const pairHue = (ip) => request("/hue/pair", { method: "POST", body: { ip } })
export const forgetHue = () => request("/hue", { method: "DELETE" })
export const fetchHueLights = () => request("/hue/lights")
export const automapHue = () => request("/hue/automap", { method: "POST" })

export const connectShelly = (ip, password) =>
    request("/shelly/connect", { method: "POST", body: { ip, password } })
export const forgetShelly = () => request("/shelly", { method: "DELETE" })
export const fetchShellyDevices = () => request("/shelly/devices")
export const setTrvTarget = (id, targetC) =>
    request(`/trvs/${id}/target`, { method: "POST", body: { target_C: targetC } })
/* Writes the room's wish AND pushes it to the valves in it - the service does
   both in one call, because a setpoint no radiator heard of is just a number. */
export const setRoomTarget = (roomId, targetTemp) =>
    request(`/rooms/${roomId}/target_temp`, { method: "POST", body: { target_temp: targetTemp } })

/* The plan lives on the gateway, this is only its mirror's state. */
export const fetchShellySchedules = () => request("/shelly/schedules")
export const syncShellySchedules = () => request("/shelly/schedules/sync", { method: "POST" })

/* Scenes are the flat's, like the lamps they drive. */
export const fetchScenes = () => request("/scenes")
export const createScene = (data) => request("/scenes", { method: "POST", body: data })
export const updateScene = (id, data) => request(`/scenes/${id}`, { method: "PUT", body: data })
export const deleteScene = (id) => request(`/scenes/${id}`, { method: "DELETE" })
export const startScene = (id) => request(`/scenes/${id}/start`, { method: "POST" })
export const stopScene = (id, turnOff = true) =>
    request(`/scenes/${id}/stop`, { method: "POST", body: { turn_off: turnOff } })

export const fetchVacuumStatus = () => request("/vacuum/status")
export const connectVacuum = () => request("/vacuum/connect", { method: "POST" })
export const disconnectVacuum = () => request("/vacuum/disconnect", { method: "POST" })
export const cleanAll = () => request("/vacuum/clean", { method: "POST", body: { all: true } })
export const cleanRooms = (roomIds) => request("/vacuum/clean", { method: "POST", body: { room_ids: roomIds } })
export const controlVacuum = (action) => request("/vacuum/control", { method: "POST", body: { action } })
export const setFanSpeed = (level) => request("/vacuum/fan-speed", { method: "POST", body: { level } })

export const createSchedule = (roomId, data) => request(`/rooms/${roomId}/schedules`, { method: "POST", body: data })
export const updateSchedule = (id, data) => request(`/schedules/${id}`, { method: "PUT", body: data })
export const deleteSchedule = (id) => request(`/schedules/${id}`, { method: "DELETE" })

export const fetchSettings = () => request("/settings")
export const saveSettings = (data) => request("/settings", { method: "PUT", body: data })
