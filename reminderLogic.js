// Kar le yaar — reminder scheduling logic (server-side)
// This mirrors the client's repeat/snooze logic exactly, so a reminder that
// repeats "every week on Mon/Wed" behaves the same whether it's advanced by
// the browser (app open) or by this server (app closed).

const WEEKDAYS_COUNT = 7;

function isDue(reminder, now) {
  if (reminder.completed) return false;
  const t = reminder.snoozedUntil
    ? new Date(reminder.snoozedUntil).getTime()
    : new Date(reminder.datetime).getTime();
  return t <= now.getTime();
}

function stepOnce(date, repeat) {
  const nd = new Date(date);
  switch (repeat.type) {
    case 'hourly':
      nd.setHours(nd.getHours() + 1);
      break;
    case 'daily':
      nd.setDate(nd.getDate() + 1);
      break;
    case 'weekly': {
      const days = (repeat.weekdays && repeat.weekdays.length)
        ? repeat.weekdays.slice().sort((a, b) => a - b)
        : [nd.getDay()];
      const cur = nd.getDay();
      let found = null;
      for (let i = 1; i <= WEEKDAYS_COUNT; i++) {
        const cand = (cur + i) % WEEKDAYS_COUNT;
        if (days.includes(cand)) { found = i; break; }
      }
      nd.setDate(nd.getDate() + (found || WEEKDAYS_COUNT));
      break;
    }
    case 'monthly':
      nd.setMonth(nd.getMonth() + 1);
      break;
    case 'yearly':
      nd.setFullYear(nd.getFullYear() + 1);
      break;
    case 'custom':
      if (repeat.unit === 'days') nd.setDate(nd.getDate() + repeat.n);
      else if (repeat.unit === 'weeks') nd.setDate(nd.getDate() + 7 * repeat.n);
      else if (repeat.unit === 'months') nd.setMonth(nd.getMonth() + repeat.n);
      break;
  }
  return nd;
}

// Advances reminder.datetime past `now`, returns true if it repeats (and was advanced),
// false if it does not repeat (caller should mark it completed instead).
function advanceRepeat(reminder, now) {
  const repeat = reminder.repeat;
  if (!repeat || repeat.type === 'none') return false;
  let d = new Date(reminder.datetime);
  let guard = 0;
  while (d.getTime() <= now.getTime() && guard < 500) {
    d = stepOnce(d, repeat);
    guard++;
  }
  reminder.datetime = d.toISOString();
  reminder.snoozedUntil = null;
  return true;
}

function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
function addMonths(d, n) { const r = new Date(d); r.setMonth(r.getMonth() + n); return r; }
function sameTimeOnDate(origIso, targetDate) {
  const orig = new Date(origIso);
  const d = new Date(targetDate);
  d.setHours(orig.getHours(), orig.getMinutes(), 0, 0);
  return d;
}

function applySnooze(reminder, kind, now) {
  const base = now || new Date();
  let next;
  switch (kind) {
    case '10m': next = new Date(base.getTime() + 10 * 60000); break;
    case '30m': next = new Date(base.getTime() + 30 * 60000); break;
    case '1h': next = new Date(base.getTime() + 60 * 60000); break;
    case 'tomorrow': next = sameTimeOnDate(reminder.datetime, addDays(base, 1)); break;
    case 'nextweek': next = sameTimeOnDate(reminder.datetime, addDays(base, 7)); break;
    case 'nextmonth': next = sameTimeOnDate(reminder.datetime, addMonths(base, 1)); break;
    default: next = new Date(base.getTime() + 10 * 60000);
  }
  reminder.snoozedUntil = next.toISOString();
}

module.exports = { isDue, advanceRepeat, applySnooze };
