import React from "react";
import { Pill, Empty, Status, Btn } from "../../common/ui";
import "./table.css"

/* What the line is doing, and what it did.
 *
 * This pane used to be a database dump: every measurement as a row of
 * "254.6 MBit/s (101.9 %)", the whole table tinted green except the failures,
 * cells centred across the full width. Nothing on the page answered the
 * question the pane exists for - is the line delivering what it is paid to
 * deliver - and nothing said what was booked, so the percentages had no
 * denominator anywhere on screen. Reading a trend meant reading every number.
 *
 * Now: the last measurement as the headline with the booked line beside it,
 * a fortnight as two charts, and the log underneath.
 *
 * Two charts rather than one with two y-axes. Download and upload are 250 and
 * 50 MBit/s here; plotting them on one scale would flatten the upload into the
 * floor, and giving them an axis each is the one chart mistake that misleads
 * most reliably. What they do share is the share of what was booked - which is
 * what the service already stores - so each gets its own chart on that one
 * scale, and the 80 % the service tests against can be drawn across both.
 *
 * A row is positional: [datetime, upload, upload_%, download, download_%, sla].
 * The service documents that its answer is a list of lists for exactly this
 * reason, so the order is a contract, not a detail.
 */

const MAX_PRESETS = [40, 120, 240, "Alle"]

/* How many measurements the charts cover, whatever the table is showing. The
   table's limit is about reading the log; the charts are about the shape of a
   fortnight, and two measurements a day makes that 28. */
const CHART_POINTS = 28

/* The top of the chart's scale, in percent of what was booked. Fixed rather
   than taken from the data: a scale that grows to fit its largest point makes
   every fortnight look the same, and the question here is distance from 100 %,
   not from the best day. */
const SCALE_TOP = 115

/* What the service tests against: both directions at or above this share of
   the booked line. */
const PROMISE_PCT = 80

export default class Table extends React.Component{
    constructor(){
        super();
        this.state = {
            data: [],
            limit: 40,
            loading: true,
            disconnected: false,
            sortColumn: null,
            sortOrder: 'asc'
        }

        this.sortData = this.sortData.bind(this)
        this.updateMax = this.updateMax.bind(this)
        this.fetchData = this.fetchData.bind(this)
    }

    componentDidMount(){
        this.fetchData()
    }

    fetchData(){
        fetch(process.env.REACT_APP_NW_API_ENDPOINT+'/speed-test-results'+(this.state.limit!== "Alle"?("?limit="+this.state.limit):""))
        .then(response => {
            if (!response.ok) {
                throw new Error("Network response was not ok");
            }
            return response.json();
        })
        .then(data => {
            this.setState({
                data: data,
                loading: false,
                disconnected: false,
            })
        })
        .catch(error => {
            /* Said out loud. The old pane set this flag and never rendered it,
               so a dead service looked exactly like a line that had never been
               measured. */
            this.setState({disconnected: true, loading: false})
        });
    }

    updateMax(num){
        this.setState({
            limit: num
        }, () => {
            this.fetchData()
        })
    }

    sortData(columnIndex) {
        const { data, sortColumn, sortOrder } = this.state;

        let newSortOrder = 'asc';
        if (sortColumn === columnIndex && sortOrder === 'asc') {
            newSortOrder = 'desc'; // Wenn bereits aufsteigend, dann absteigend
        }

        const sortedData = [...data].sort((a, b) => {
            const aValue = a[columnIndex];
            const bValue = b[columnIndex];

            if (aValue < bValue) return newSortOrder === 'asc' ? -1 : 1;
            if (aValue > bValue) return newSortOrder === 'asc' ? 1 : -1;
            return 0;
        });

        this.setState({
            data: sortedData,
            sortColumn: columnIndex,
            sortOrder: newSortOrder
        });
    }

    render(){
        const { data, loading, disconnected } = this.state

        if (loading) return <Status>Lädt…</Status>
        if (disconnected) {
            return <Status tone="danger">Der Speedtest-Dienst ist nicht erreichbar.</Status>
        }
        if (data.length === 0) {
            return (
                <div className="nw-view">
                    <Empty>
                        Noch keine Messung. Der Dienst misst nach Zeitplan; die erste
                        Zeile erscheint danach von selbst.
                    </Empty>
                </div>
            )
        }

        /* Newest first is how the service answers, but the user may have
           sorted the table - the headline and the charts must keep describing
           the newest measurement either way. */
        const byTime = [...data].sort((a, b) => String(b[0]).localeCompare(String(a[0])))
        const latest = byTime[0]
        const booked = bookedFrom(byTime)

        /* Oldest first for the chart, so time runs left to right. */
        const series = byTime.slice(0, CHART_POINTS).reverse()

        return (
            <div className="nw-view">
                <Headline latest={latest} booked={booked} />

                <div className="nw-plots">
                    <Plot title="Download" series={series} index={4}
                          from={series[0]} to={latest} />
                    <Plot title="Upload" series={series} index={2}
                          from={series[0]} to={latest} />
                </div>

                <div className="nw-log">
                    <div className="nw-log-head">
                        <h4>Messungen</h4>
                        <span className="nw-spacer" />
                        <span className="nw-log-label">Zeilen</span>
                        {MAX_PRESETS.map(num => (
                            <Btn key={num} size="sm" on={this.state.limit === num}
                                 onClick={() => this.updateMax(num)}>{num}</Btn>
                        ))}
                    </div>
                    <div className="nw-table-wrap">
                        <table className="networkTable">
                            <TableHead
                                onSort={this.sortData}
                                sortColumn={this.state.sortColumn}
                                sortOrder={this.state.sortOrder}
                            />
                            <TableData entries={data}/>
                        </table>
                    </div>
                </div>
            </div>
        )
    }
}

/* What the line is doing right now. */
function Headline({ latest, booked }) {
    const downPct = latest[4]
    const upPct = latest[2]
    const met = latest[5] === 1
    return (
        <div className="nw-headline">
            <span className="nw-figure">{fmtSpeed(latest[3])}</span>
            <span className="nw-unit">MBit/s Download</span>
            <Pill tone={met ? "ok" : "danger"}>
                {fmtPct(downPct)} {booked.down != null ? `der gebuchten ${booked.down}` : "der Zusage"}
            </Pill>
            <Pill>Upload {fmtSpeed(latest[1])} · {fmtPct(upPct)}</Pill>
            <span className="nw-spacer" />
            <span className="nw-when">gemessen {fmtWhen(latest[0])}</span>
        </div>
    )
}

/* One direction over the last fortnight, as a share of what was booked.
 *
 * Drawn by hand rather than with a charting library: this is one line over
 * about thirty points, and the dashboard carries no chart dependency for the
 * sake of it. */
function Plot({ title, series, index, from, to }) {
    const W = 420
    const H = 76
    const values = series.map(row => row[index])
    if (values.length < 2) {
        return (
            <section className="nw-plot">
                <div className="nw-plot-head"><h4>{title}</h4></div>
                <Empty>Noch zu wenige Messungen für einen Verlauf.</Empty>
            </section>
        )
    }

    const step = W / (values.length - 1)
    const y = (v) => H - (Math.min(v, SCALE_TOP) / SCALE_TOP) * H
    const line = values
        .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)},${y(v).toFixed(1)}`)
        .join(" ")
    const promiseY = y(PROMISE_PCT)
    const lastY = y(values[values.length - 1])

    return (
        <section className="nw-plot">
            <div className="nw-plot-head">
                <h4>{title}</h4>
                <span className="nw-spacer" />
                <span className="nw-plot-meta">{values.length} Messungen</span>
            </div>
            {/* No axis labels inside the picture: the scale is a share of the
                booked line and the only value on it worth a label is the
                promise, which is named under the chart. */}
            <svg className="nw-chart" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
                 role="img" aria-label={`${title}: Verlauf der letzten ${values.length} Messungen`}>
                <line className="nw-promise" x1="0" y1={promiseY} x2={W} y2={promiseY}
                      strokeDasharray="3 3" />
                <path className="nw-area" d={`${line} L${W},${H} L0,${H} Z`} />
                <path className="nw-line" d={line} />
                <circle className="nw-dot" cx={W} cy={lastY} r="3" />
            </svg>
            <div className="nw-plot-foot">
                <span>{fmtDay(from[0])}</span>
                <span className="nw-promise-label">Zusage {PROMISE_PCT} %</span>
                <span className="nw-spacer" />
                <span>{fmtDay(to[0])}</span>
            </div>
        </section>
    )
}

function TableData({entries}){
    return(
        <tbody>
            {entries.map((entry, index) =>
            <tr key={`${entry[0]}-${index}`} data-missed={entry[5] === 1 ? undefined : "true"}>
                <td className="nw-cell-when">{formatDate(entry[0])}</td>
                <td className="nw-cell-num">{fmtSpeed(entry[3])}<span className="nw-cell-pct">{fmtPct(entry[4])}</span></td>
                <td className="nw-cell-num">{fmtSpeed(entry[1])}<span className="nw-cell-pct">{fmtPct(entry[2])}</span></td>
                {/* Only a failed row carries a colour. Tinting every row green
                    left the colour saying nothing. */}
                <td className="nw-cell-sla">
                    {entry[5] === 1
                        ? <span className="nw-met">erfüllt</span>
                        : <Pill tone="danger">verfehlt</Pill>}
                </td>
            </tr>
            )}
        </tbody>
    )
}

function TableHead({ onSort, sortColumn, sortOrder }) {
    const mark = (column) => sortColumn === column ? (sortOrder === 'asc' ? ' ↑' : ' ↓') : ''
    return (
        <thead>
            <tr>
                <th onClick={() => onSort(0)}>Datum{mark(0)}</th>
                <th className="nw-cell-num" onClick={() => onSort(3)}>Download{mark(3)}</th>
                <th className="nw-cell-num" onClick={() => onSort(1)}>Upload{mark(1)}</th>
                <th className="nw-cell-sla" onClick={() => onSort(5)}>Zusage{mark(5)}</th>
            </tr>
        </thead>
    );
}

/* What the line was booked at.
 *
 * The service stores the measurement and its share of the booked line, never
 * the booked line itself, so it has to be read back out of the two. Taken from
 * several recent rows and rounded to the nearest five, because one row's
 * rounding would otherwise put "der gebuchten 249" on the page. Rows with a
 * percentage of zero are skipped: dividing by them says nothing. */
function bookedFrom(rows) {
    const guess = (value, percent) =>
        percent > 0 ? (value / percent) * 100 : null

    const pick = (valueIndex, percentIndex) => {
        const guesses = rows.slice(0, 8)
            .map(row => guess(row[valueIndex], row[percentIndex]))
            .filter(n => n != null && isFinite(n) && n > 0)
        if (guesses.length === 0) return null
        guesses.sort((a, b) => a - b)
        const median = guesses[Math.floor(guesses.length / 2)]
        return Math.round(median / 5) * 5
    }

    return { down: pick(3, 4), up: pick(1, 2) }
}

function fmtSpeed(value) {
    if (value == null) return "–"
    return Number(value).toFixed(1).replace(".", ",")
}

function fmtPct(value) {
    if (value == null) return "–"
    return `${Math.round(value)} %`
}

function fmtWhen(dateString) {
    const date = new Date(dateString)
    if (isNaN(date)) return dateString
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fmtDay(dateString) {
    const date = new Date(dateString)
    if (isNaN(date)) return ""
    return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.`
}

const pad = (n) => String(n).padStart(2, "0")

function formatDate(dateString) {
    const date = new Date(dateString);
    if (isNaN(date)) return dateString

    const day = String(date.getDate()).padStart(2, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const year = date.getFullYear();
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');

    return `${day}.${month}.${year} um ${hours}:${minutes}`;
}
