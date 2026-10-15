import Collapsible from "../../common/Collapsible"

/* One collapsible settings block: the shared Collapsible in a card frame.
 *
 * Closed by default. All four blocks expanded at once made the settings page so
 * long that the one being looked for was never on screen - and the floorplan
 * editor alone is taller than a phone.
 */
export default function SettingsSection({ id, title, chips, summary, defaultOpen = false, children }) {
    return (
        <Collapsible
            id={id}
            store="home.settings.open."
            className="home-card as-card"
            title={<h4>{title}</h4>}
            chips={chips}
            summary={summary}
            defaultOpen={defaultOpen}
        >
            {children}
        </Collapsible>
    )
}
