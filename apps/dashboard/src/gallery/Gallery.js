import React from "react";
import "./gallery.css"
import { calcDelay } from "../helpers";
import { fetchGallery, imageSrc } from "./api";
import { fetchOverview } from "../home/api";

/* The photo frame: what this Pi shows for twenty-three hours a day.
 *
 * It used to be the picture and nothing else - not the time, not whether the
 * flat was fine, not which picture this was or how many there were, and no
 * sign that touching it anywhere brings the dashboard back. A warning could
 * sit behind the screensaver for a day without anybody seeing it.
 *
 * Now the picture still owns the whole panel, and three things hang on it in
 * the band along the foot, where a photograph has the least in it:
 *
 *   - the time, large, because a frame on a wall is the clock of its room;
 *   - one line of the flat's state, built from the same /overview the room
 *     panel reads, so a silent sensor cannot hide here;
 *   - the picture's place in the set, which is also the only hint that there
 *     is a set to swipe through.
 *
 * All of it sits on a gradient scrim rather than a panel: a panel over a
 * photograph is a second window, and this mode exists to show the photograph.
 */

/* How often the overlay refreshes. The clock has to be right to the minute;
   the flat's state changes on the order of minutes and is read from a
   service, so it goes at a tenth of that rate. */
const CLOCK_EVERY_MS = 20 * 1000
const STATE_EVERY_MS = 5 * 60 * 1000

const WEEKDAYS = ["Sonntag", "Montag", "Dienstag", "Mittwoch", "Donnerstag",
                  "Freitag", "Samstag"]
const MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
                "August", "September", "Oktober", "November", "Dezember"]

const BATTERY_LOW_PCT = 20

class Gallery extends React.Component{
    constructor(props){
        super(props);
        this.state = {
            mouseX: 0,
            srcSet: [],
            srcIndex: 0,
            showElement: true,
            now: new Date(),
            flat: null,
        }
        this.setMousePos = this.setMousePos.bind(this)
        this.handleDrag = this.handleDrag.bind(this)
        this.changeImage = this.changeImage.bind(this)
        this.handleAutoSwitch = this.handleAutoSwitch.bind(this)
        this.checkTime = this.checkTime.bind(this)
        this.convertTimeToMinutes = this.convertTimeToMinutes.bind(this)
        this.loadFlat = this.loadFlat.bind(this)
    }

    componentDidMount(){
        if (this.props.settings.galleryPauseAtNight){
            this.checkTime();
            this.timer = setInterval(this.checkTime, 60000);
        }
        if (this.props.settings.autoSwitch){
            this.handleAutoSwitch();
        }
        /* The pictures come from the profile service, which keeps uploads and
           links in one list. The static file is only a fallback for a service
           that cannot be reached - an empty list from a service that answered
           means the gallery is empty, which is a different thing and must not
           be papered over with whatever happens to be shipped. */
        fetchGallery()
            .then(data => this.setState({ srcSet: (data.entries || []).map(imageSrc) }))
            .catch(() => {
                fetch('/assets/images.json')
                    .then(response => response.json())
                    .then(data => this.setState({ srcSet: data.images || [] }))
                    .catch(() => this.setState({ srcSet: [] }));
            });

        this.clockId = setInterval(() => this.setState({ now: new Date() }), CLOCK_EVERY_MS)
        this.loadFlat()
        this.flatId = setInterval(this.loadFlat, STATE_EVERY_MS)
    }

    componentWillUnmount() {
        clearInterval(this.intervalId);
        clearInterval(this.timer);
        clearInterval(this.clockId);
        clearInterval(this.flatId);
    }

    /* The flat, from the same answer the room panel reads. A failure leaves
       the line out rather than putting an error on a photo frame: the frame
       is not where a service outage is dealt with, and the dashboard behind
       it says so plainly. */
    loadFlat(){
        fetchOverview()
            .then(data => this.setState({ flat: flatState(data) }))
            .catch(() => this.setState({ flat: null }))
    }

    checkTime() {
        const { galleryDisplayTimeStart, galleryDisplayTimeEnd } = this.props.settings;

        const now = new Date();
        const currentTime = (now.getHours() * 60) + now.getMinutes();

        const startTime = this.convertTimeToMinutes(galleryDisplayTimeStart)
        const endTime = this.convertTimeToMinutes(galleryDisplayTimeEnd)

        if (startTime <= currentTime && currentTime <= endTime) {
            if (!this.state.showElement) {
                this.setState({ showElement: true });
            }
        } else {
            if (this.state.showElement) {
                this.setState({ showElement: false });
            }
        }
    }

    convertTimeToMinutes(timeStr) {
        const [hours, minutes] = timeStr.split(':').map(Number);
        return (hours * 60) + minutes;
    }

    handleAutoSwitch(){
        let delay = calcDelay(this.props.settings.autoSwitchTime, this.props.settings.autoSwitchUnit)
        this.intervalId = setInterval(() => {
            this.changeImage();
        }, delay);
    }

    setMousePos(x){
        this.setState({
            mouseX: x,
        })
    }

    changeImage(next=true){
        if (next){
            this.setState({
                srcIndex: (this.state.srcIndex+1 === this.state.srcSet.length)?0:this.state.srcIndex+1
            })
        } else {
            this.setState({
                srcIndex: (this.state.srcIndex === 0)?this.state.srcSet.length-1:this.state.srcIndex-1
            })
        }
    }

    handleDrag(x){
        if(x>= this.state.mouseX){
            this.changeImage(false)
        } else {
            this.changeImage()
        }
    }

    render(){
        const { showElement, srcSet, srcIndex, now, flat } = this.state
        return(
            <div className="galleryWrapper" onClick={(e) => this.props.toggleDashboard()} onDragStart={(e) => this.setMousePos(e.clientX)} onTouchStart={(e) => this.setMousePos(e.clientX)} onDragEnd={(e) => this.handleDrag(e.clientX)} onTouchEnd={(e) => this.handleDrag(e.clientX)} draggable={true}>
                {showElement && srcSet.length > 0 &&
                    <img src={srcSet[srcIndex]} alt="Galeriebild" />}

                {/* Nothing over a screen that is meant to be dark: outside the
                    display hours this mode is the Pi's way of switching the
                    panel off, and a clock glowing on it defeats that. */}
                {showElement && (
                    <>
                        <div className="gal-scrim" aria-hidden />

                        <div className="gal-foot">
                            {/* A frame on a wall is the clock of its room. This
                                is the one place in the stack where a big number
                                needs no justifying. */}
                            <div className="gal-clock">
                                <span className="gal-time">{fmtTime(now)}</span>
                                <span className="gal-date">{fmtDate(now)}</span>
                            </div>

                            {flat && (flat.temperature != null || flat.notice) && (
                                <div className="gal-state">
                                    {flat.temperature != null && (
                                        <span className="gal-stat">
                                            <ThermometerIcon />
                                            <span>{fmtTemp(flat.temperature)}</span>
                                        </span>
                                    )}
                                    {/* The first fault, and how many more there
                                        are. A warning must not be able to sit
                                        behind the screensaver for a day. */}
                                    {flat.notice && (
                                        <span className="gal-stat" data-tone="warn">
                                            <WarnIcon />
                                            <span>
                                                {flat.notice}
                                                {flat.more > 0 && ` · ${flat.more} weitere`}
                                            </span>
                                        </span>
                                    )}
                                </div>
                            )}
                        </div>

                        {/* Which picture this is, and the only sign that there
                            is a set to swipe through. */}
                        {srcSet.length > 1 && srcSet.length <= 12 && (
                            <div className="gal-dots" aria-hidden>
                                {srcSet.map((_, i) => (
                                    <span key={i} className="gal-dot"
                                          data-on={i === srcIndex ? "true" : undefined} />
                                ))}
                            </div>
                        )}
                        {srcSet.length > 12 && (
                            <div className="gal-counter" aria-hidden>
                                {srcIndex + 1} / {srcSet.length}
                            </div>
                        )}

                        {srcSet.length === 0 && (
                            <p className="gal-nothing">
                                Noch kein Bild — in den Einstellungen unter „Galerie" eines
                                hochladen oder verknüpfen.
                            </p>
                        )}
                    </>
                )}
            </div>
        )
    }
}

/* The flat in one line, from the overview the room panel already reads.
 *
 * The temperature shown is the warmest room that has a reading, not an
 * average: an average over a flat whose balcony has no sensor and whose hall
 * is unheated describes nowhere, while the living room is the number somebody
 * walking past actually wants.
 */
export function flatState(data) {
    const rooms = (data && data.rooms) || []
    const faults = []
    let temperature = null

    for (const room of rooms) {
        const climate = room.climate || {}
        if (climate.temperature != null
            && (temperature == null || climate.temperature > temperature)) {
            temperature = climate.temperature
        }
        if (climate.silent) {
            faults.push(`${room.name} meldet seit ${fmtAge(climate.age_s)} nicht`)
        }
        if (climate.battery != null && climate.battery <= BATTERY_LOW_PCT) {
            faults.push(`${room.name}: Batterie ${climate.battery} %`)
        }
        if (climate.window_open) {
            faults.push(`${room.name}: Fenster offen`)
        }
    }

    if (data && data.shelly && data.shelly.error) {
        faults.unshift("Gateway nicht erreichbar")
    }

    return { temperature, notice: faults[0] || null, more: Math.max(0, faults.length - 1) }
}

function fmtTime(date) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

function fmtDate(date) {
    return `${WEEKDAYS[date.getDay()]}, ${date.getDate()}. ${MONTHS[date.getMonth()]}`
}

function fmtTemp(value) {
    return `${value.toFixed(1).replace(".", ",")}°`
}

function fmtAge(seconds) {
    if (seconds == null) return "unbekannter Zeit"
    if (seconds < 3600) return `${Math.round(seconds / 60)} min`
    if (seconds < 86400) return `${Math.round(seconds / 3600)} h`
    return `${Math.round(seconds / 86400)} Tagen`
}

/* Drawn here rather than pulled from an icon set: the dashboard ships no icon
   package, and these two are the only glyphs this screen has. */
function ThermometerIcon() {
    return (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
        </svg>
    )
}

function WarnIcon() {
    return (
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor"
             strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <path d="M12 9v4M12 17h.01"/>
        </svg>
    )
}

export default Gallery
