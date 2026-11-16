export interface CalendarSnapshot {
  today_date: string;
  weekday: string;
  week_snapshot: string;
  current_month: string;
  next_month: string;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function calendarSnapshot(now: Date = new Date()): CalendarSnapshot {
  const y = now.getFullYear();
  const m = now.getMonth();
  const d = now.getDate();
  const today_date = `${y}-${pad(m + 1)}-${pad(d)}`;
  const weekday = WEEKDAYS[now.getDay()];
  const current_month = MONTHS[m];
  const next_month = MONTHS[(m + 1) % 12];

  const dayDow = now.getDay();
  const offset = dayDow === 0 ? -6 : 1 - dayDow;
  const monday = new Date(now);
  monday.setDate(d + offset);

  const days: string[] = [];
  for (let i = 0; i < 7; i++) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    days.push(`${WEEKDAYS[day.getDay()]} ${day.getDate()}`);
  }
  const week_snapshot = days.join(", ");

  return { today_date, weekday, week_snapshot, current_month, next_month };
}
