import React from 'react';

/* Icon for the current theme mode: a sun for light, a moon for dark and a
 * half-filled circle for the automatic mode that follows the system. */
export default function MdiThemeMode({ mode = "auto", ...props }) {
    return (
        <svg xmlns="http://www.w3.org/2000/svg" width={36} height={36} viewBox="0 0 24 24" {...props}>
            {mode === "light" && (
                <g stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" fill="none">
                    <circle cx="12" cy="12" r="4.2" fill="currentColor" stroke="none" />
                    <path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.6 1.6M17 17l1.6 1.6M18.6 5.4L17 7M7 17l-1.6 1.6" />
                </g>
            )}
            {mode === "dark" && (
                <>
                    <mask id="theme-moon-cut">
                        <rect x="0" y="0" width="24" height="24" fill="white" />
                        <circle cx="17.5" cy="7.5" r="8.2" fill="black" />
                    </mask>
                    <circle cx="12" cy="12" r="9" fill="currentColor" mask="url(#theme-moon-cut)" />
                </>
            )}
            {mode === "auto" && (
                <>
                    <circle cx="12" cy="12" r="8.6" fill="none" stroke="currentColor" strokeWidth="1.8" />
                    <path d="M12 3.4a8.6 8.6 0 0 1 0 17.2z" fill="currentColor" />
                </>
            )}
        </svg>
    );
}
