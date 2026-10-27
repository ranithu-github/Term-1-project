// The station is in Sri Lanka, but the server runs on UTC, so every time shown
// to people (emails, dashboard, admin panel) is formatted in Sri Lanka time.
export const STATION_TIME_ZONE = 'Asia/Colombo';

/**
 * A date and time in Sri Lanka time, e.g. "Oct 27, 2026, 3:45 PM"
 */
export function formatStationDateTime(value: Date | string): string {
  return new Date(value).toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: STATION_TIME_ZONE,
  });
}

/**
 * A short weekday and time in Sri Lanka time, e.g. "Tue 3:45 PM"
 */
export function formatStationDueTime(value: Date | string): string {
  return new Date(value).toLocaleString('en-US', {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: STATION_TIME_ZONE,
  });
}

/**
 * Day, date and time in Sri Lanka time, e.g. "Thu 29 Oct, 3:40 PM"
 */
export function formatStationDue(value: Date | string): string {
  const d = new Date(value);
  const day = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: STATION_TIME_ZONE }).replace(',', '');
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: STATION_TIME_ZONE });
  return `${day}, ${time}`;
}

/**
 * Time left until (or past) a moment, e.g. "23 h 12 min" / "45 min"
 */
export function formatTimeLeft(value: Date | string, now = Date.now()): { overdue: boolean; text: string } {
  const diff = new Date(value).getTime() - now;
  const mins = Math.floor(Math.abs(diff) / 60000);
  const text = mins < 60 ? `${Math.max(mins, 1)} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
  return { overdue: diff < 0, text };
}
