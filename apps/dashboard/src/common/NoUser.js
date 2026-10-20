/* Shown where a pane's content would be when nobody is chosen.
 *
 * These panes belong to a person. Without one there is nothing to fetch, and an
 * empty screen would read as "no tasks yet" rather than "no idea whose tasks".
 */
export default function NoUser({ what = "Dieser Bereich" }) {
    return (
        <p className="nouser">
            {what} gehört zu einem Benutzer. Oben rechts einen auswählen oder anlegen.
        </p>
    )
}
