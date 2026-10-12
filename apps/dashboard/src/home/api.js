const HOME_API = process.env.REACT_APP_HOME_API_ENDPOINT || ""

async function request(path, options) {
    const r = await fetch(`${HOME_API}${path}`, options && {
        ...options,
        headers: { "Content-Type": "application/json" },
        body: options.body ? JSON.stringify(options.body) : undefined,
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
