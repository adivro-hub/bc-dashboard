/* GET /api/hours-bundle?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Combines the Neon mirror of `data_access.hour_statistics()` (vehicle
 * state counts per hour) with per-hour job counts derived from
 * job_analogue (ASAP / PREBOOK / DONE / CANCELLED). Returns the same
 * structure parsers.parseHours() would produce from an XLS so
 * dashboard.js can render it without further changes.
 *
 * Response shape:
 *   {
 *     period:        "<from> .. <to>",
 *     period_start:  "YYYY-MM-DD",
 *     period_end:    "YYYY-MM-DD",
 *     timestamps:    [ "YYYY-MM-DDTHH:00", ... ],
 *     hourly: {
 *       jobs_asap, jobs_prebook, jobs_completed, jobs_cancelled,
 *       online, doing_job, in_rank, empty, on_break, going_home,
 *       logged_off, unknown
 *     },                                  // each value is an array, same length as timestamps
 *     by_hour_of_day: { ...same keys, each = array(24) of avg values },
 *     derived: { available_total, busy_total, online_total,
 *                on_break_total, util_avg, peak_available, peak_busy }
 *   }
 *
 * `hour_statistics` is per-day, so partial backfills show up as gaps:
 * we emit a row only for (date, hour) pairs present in the mirror, and
 * fill job counts with 0 when no jobs landed in that hour.
 */
import { query, ok, bad, parseDateRange, requireAuth } from './_db.js';

const STATE_KEYS = [
  'unknown', 'logged_off', 'online', 'empty',
  'in_rank', 'on_break', 'going_home', 'doing_job',
];
const JOB_KEYS = ['jobs_asap', 'jobs_prebook', 'jobs_cancelled', 'jobs_completed'];
const ALL_KEYS = [...JOB_KEYS, ...STATE_KEYS];

export default async function handler(req, res) {
  if (req.method !== 'GET') return bad(res, 405, 'GET only');
  if (!await requireAuth(req, res)) return;

  let from, to;
  try { ({ from, to } = parseDateRange(req)); }
  catch (e) { return bad(res, 400, e.message); }

  try {
    // One pass: pull hour_statistics rows in range, LEFT JOIN per-hour
    // job counts derived from job_analogue. Both sides are local time,
    // so no tz conversion required.
    const rows = await query(
      `WITH jobs AS (
         SELECT to_char(job_date, 'YYYY-MM-DD')   AS d,
                EXTRACT(HOUR FROM job_time)::int   AS h,
                COUNT(*) FILTER (WHERE upper(urgency) = 'ASAP')::int    AS jobs_asap,
                COUNT(*) FILTER (WHERE upper(urgency) = 'PREBOOK')::int AS jobs_prebook,
                COUNT(*) FILTER (WHERE status = 'CANCELLED')::int       AS jobs_cancelled,
                COUNT(*) FILTER (WHERE status = 'DONE')::int            AS jobs_completed
           FROM job_analogue
          WHERE job_date BETWEEN $1::date AND $2::date
            AND job_time IS NOT NULL
          GROUP BY 1, 2
       )
       SELECT to_char(h.date, 'YYYY-MM-DD') AS date,
              h.hour::int                   AS hour,
              h.unknown::bigint             AS unknown,
              h.logged_off::bigint          AS logged_off,
              h.online::bigint              AS online,
              h.empty::bigint               AS empty,
              h.in_rank::bigint             AS in_rank,
              h.on_break::bigint            AS on_break,
              h.going_home::bigint          AS going_home,
              h.doing_job::bigint           AS doing_job,
              COALESCE(j.jobs_asap,      0) AS jobs_asap,
              COALESCE(j.jobs_prebook,   0) AS jobs_prebook,
              COALESCE(j.jobs_cancelled, 0) AS jobs_cancelled,
              COALESCE(j.jobs_completed, 0) AS jobs_completed
         FROM hour_statistics h
         LEFT JOIN jobs j
           ON j.d = to_char(h.date, 'YYYY-MM-DD')
          AND j.h = h.hour
        WHERE h.date BETWEEN $1::date AND $2::date
        ORDER BY h.date ASC, h.hour ASC`,
      [from, to]
    );

    // Build timestamps + per-metric arrays
    const timestamps = [];
    const hourly = {};
    for (const k of ALL_KEYS) hourly[k] = [];
    const pad = (n) => String(n).padStart(2, '0');
    for (const r of rows) {
      timestamps.push(`${r.date}T${pad(r.hour)}:00`);
      for (const k of ALL_KEYS) {
        // pg returns BIGINT as string — coerce defensively.
        hourly[k].push(Number(r[k]) || 0);
      }
    }

    // by_hour_of_day: mean per hour-of-day across the range
    const sums = {};
    const counts = new Array(24).fill(0);
    for (const k of ALL_KEYS) sums[k] = new Array(24).fill(0);
    rows.forEach((r) => {
      const h = r.hour;
      counts[h] += 1;
      for (const k of ALL_KEYS) sums[k][h] += Number(r[k]) || 0;
    });
    const by_hour_of_day = {};
    for (const k of ALL_KEYS) {
      by_hour_of_day[k] = sums[k].map((v, h) => (counts[h] ? v / counts[h] : 0));
    }

    // Derived totals (mirrors parsers.parseHours)
    const sum = (arr) => arr.reduce((a, b) => a + b, 0);
    const online_total  = sum(hourly.online);
    const on_break_total = sum(hourly.on_break);
    const busy_total    = sum(hourly.doing_job);
    const available_total = online_total - on_break_total;
    const peak_available = hourly.online.length
      ? Math.max(...hourly.online.map((o, i) => o - hourly.on_break[i]))
      : 0;
    const peak_busy = hourly.doing_job.length ? Math.max(...hourly.doing_job) : 0;

    const derived = {
      available_total,
      busy_total,
      online_total,
      on_break_total,
      util_avg:       available_total ? busy_total / available_total : 0,
      peak_available,
      peak_busy,
    };

    ok(res, {
      period:       `${from} .. ${to}`,
      period_start: from,
      period_end:   to,
      timestamps,
      hourly,
      by_hour_of_day,
      derived,
    }, { cache: 'public, max-age=60, must-revalidate' });
  } catch (e) {
    console.error(e);
    bad(res, 500, e.message || 'hours-bundle query failed');
  }
}
