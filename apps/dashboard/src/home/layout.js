/* What the home view shows, in which order, and what it leaves out.
 *
 * Two questions that look alike and are not:
 *
 *   is it available?   does this flat have the thing at all - a valve in this
 *                      room, a robot set up, a sensor that reports humidity.
 *                      Derived from the data, never configured. An empty block
 *                      for a device nobody owns is noise, and a reading that
 *                      says "-" forever teaches people to ignore the panel.
 *   is it wanted?      the operator's own order and their decision to hide
 *                      something that *is* available. Stored, because it is a
 *                      preference and nothing can derive it.
 *
 * The stored order is merged rather than trusted: anything new is appended in
 * its default place, anything unknown is dropped. So a section added in a later
 * version appears by itself instead of vanishing because an older setting did
 * not list it.
 */

/* openByDefault: what you want at a glance stays open, what you edit now and
   then folds away. The heating plan is a list of times - worth having, not worth
   scrolling past every time a room is opened. Whatever the reader folds or
   unfolds afterwards is remembered. */
export const SECTIONS = [
    { id: "climate", label: "Klima", openByDefault: true },
    { id: "lights", label: "Licht", openByDefault: true },
    { id: "schedule", label: "Heizplan", openByDefault: false },
    { id: "vacuum", label: "Saugroboter", openByDefault: false },
]

/* The climate tiles. `available` gets the room's climate block and decides
   whether this one has anything to say. */
export const CLIMATE_TILES = [
    { id: "temperature", label: "Temperatur", available: c => c.temperature != null },
    { id: "humidity", label: "Luftfeuchte", available: c => c.humidity != null },
    { id: "trv_target", label: "Ventil-Soll", available: c => c.trv_target != null },
    { id: "valve", label: "Ventilstellung", available: c => c.valve_position != null },
    { id: "head", label: "Kopftemperatur", available: c => c.head_temperature != null },
    { id: "battery", label: "Batterie", available: c => c.battery != null },
    { id: "window", label: "Fenster", available: c => c.window_open != null },
]

export const DEFAULT_LAYOUT = {
    sections: SECTIONS.map(s => s.id),
    climate_tiles: CLIMATE_TILES.map(t => t.id),
    hidden: [],
}

/* Merge of a stored order with the known one: stored first, in its order, then
   whatever the stored order never mentioned. */
function mergeOrder(stored, known) {
    const valid = (Array.isArray(stored) ? stored : []).filter(id => known.includes(id))
    return [...valid, ...known.filter(id => !valid.includes(id))]
}

/* Takes the raw stored string, because the two callers come by it differently:
   the settings screen has it from /settings, the room panel from /overview,
   which ships it with the rooms for the same reason it ships the wall widths -
   the first paint should not need a second request. */
export function readLayout(raw) {
    let stored = {}
    try {
        stored = JSON.parse(raw || "{}") || {}
    } catch {
        // A hand-edited setting that does not parse falls back to the default
        // rather than taking the whole view down with it.
        stored = {}
    }
    return {
        sections: mergeOrder(stored.sections, DEFAULT_LAYOUT.sections),
        climate_tiles: mergeOrder(stored.climate_tiles, DEFAULT_LAYOUT.climate_tiles),
        hidden: (Array.isArray(stored.hidden) ? stored.hidden : []),
    }
}

export const isHidden = (layout, id) => (layout.hidden || []).includes(id)

/* Which sections this room can fill. The schedule is the odd one: a plan can be
   written before a radiator is bound, and one that exists must stay reachable or
   it could never be deleted. */
export function sectionAvailable(id, { room, hue, shelly, vacuum }) {
    const climate = room.climate || {}
    const lights = room.lights || {}
    /* Boolean(), not the bare expression: an absent subsystem makes the chain
       evaluate to undefined, which is falsy and therefore works - until someone
       compares the result to false. A predicate answers yes or no. */
    switch (id) {
        case "climate":
            return Boolean(climate.bound > 0 || (shelly && shelly.configured && shelly.trvs > 0))
        case "lights":
            return Boolean(lights.bound > 0 || (hue && hue.configured))
        case "schedule":
            return Boolean(climate.bound > 0 || (room.schedules || []).length > 0)
        case "vacuum":
            return Boolean((room.vacuum_rooms || []).length > 0
                || (vacuum && (vacuum.configured || vacuum.connected)))
        default:
            return true
    }
}

export function orderedSections(layout, context) {
    return layout.sections
        .filter(id => !isHidden(layout, id))
        .filter(id => sectionAvailable(id, context))
        .map(id => SECTIONS.find(s => s.id === id))
        .filter(Boolean)
}

export function orderedTiles(layout, climate) {
    return layout.climate_tiles
        .filter(id => !isHidden(layout, id))
        .map(id => CLIMATE_TILES.find(t => t.id === id))
        .filter(tile => tile && tile.available(climate || {}))
}

/* Moves one entry by one place. Returns a new array, and the same one when the
   move would fall off either end. */
export function moveWithin(order, id, delta) {
    const from = order.indexOf(id)
    const to = from + delta
    if (from < 0 || to < 0 || to >= order.length) return order
    const next = [...order]
    next.splice(to, 0, ...next.splice(from, 1))
    return next
}
