import FitParser from 'fit-file-parser';
import './style.css';

const $ = (id) => document.getElementById(id);

const els = {
  fileInput: $('fileInput'),
  dropZone: $('dropZone'),
  fileRow: $('fileRow'),
  fileName: $('fileName'),
  fileMeta: $('fileMeta'),
  clearBtn: $('clearBtn'),
  status: $('status'),
  summarySection: $('summarySection'),
  summaryGrid: $('summaryGrid'),
  sportBadge: $('sportBadge'),
  lapsBody: $('lapsBody'),
  downloadFullBtn: $('downloadFullBtn'),
};

let currentFile = null;
let parsedData = null;
let normalized = null;

// One flat schema for AI-friendly analysis. Rows are identified by row_type:
// summary -> split -> record.
const FULL_CSV_COLUMNS = [
  'row_type',
  'source_file',
  'sport',
  'activity_start_time',

  // Activity summary fields
  'total_distance_km',
  'total_timer_time_s',
  'total_elapsed_time_s',
  'avg_pace_min_km',
  'avg_speed_kmh',
  'avg_heart_rate_bpm',
  'max_heart_rate_bpm',
  'avg_cadence_rpm',
  'max_cadence_rpm',
  'avg_power_w',
  'max_power_w',
  'total_ascent_m',
  'total_descent_m',
  'calories',

  // Split / lap fields
  'split',
  'split_start_time',
  'split_distance_km',
  'split_timer_time_s',
  'split_elapsed_time_s',
  'split_avg_pace_min_km',
  'split_avg_speed_kmh',
  'split_avg_heart_rate_bpm',
  'split_max_heart_rate_bpm',
  'split_avg_cadence_rpm',
  'split_max_cadence_rpm',
  'split_avg_power_w',
  'split_max_power_w',
  'split_total_ascent_m',
  'split_total_descent_m',
  'split_calories',

  // Timestamped record fields
  'record_index',
  'timestamp',
  'elapsed_time_s',
  'timer_time_s',
  'distance_km',
  'speed_kmh',
  'pace_min_km',
  'heart_rate_bpm',
  'cadence_rpm',
  'stride_length_m',
  'altitude_m',
  'enhanced_altitude_m',
  'temperature_c',
  'power_w',
  'position_lat_deg',
  'position_long_deg',
];

els.dropZone.addEventListener('click', () => els.fileInput.click());
els.fileInput.addEventListener('change', () => {
  const file = els.fileInput.files?.[0];
  if (file) handleFile(file);
});
els.clearBtn.addEventListener('click', reset);

for (const eventName of ['dragenter', 'dragover']) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.add('dragging');
  });
}

for (const eventName of ['dragleave', 'drop']) {
  els.dropZone.addEventListener(eventName, (event) => {
    event.preventDefault();
    event.stopPropagation();
    els.dropZone.classList.remove('dragging');
  });
}

els.dropZone.addEventListener('drop', (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) handleFile(file);
});

els.downloadFullBtn.addEventListener('click', () => {
  if (!normalized || !currentFile) return;
  const filename = `${baseName(currentFile.name)}_full.csv`;
  downloadCsv(filename, normalized.fullCsvRows, FULL_CSV_COLUMNS);
});

async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.fit')) {
    showStatus('error', 'Invalid file. Please select a file with the .fit extension.');
    return;
  }

  currentFile = file;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} • processed locally on this device`;
  els.fileRow.classList.remove('hidden');
  els.summarySection.classList.add('hidden');
  showStatus('loading', 'Reading and parsing FIT data...');

  try {
    const buffer = await file.arrayBuffer();
    const parser = new FitParser({
      mode: 'list',
      speedUnit: 'km/h',
      lengthUnit: 'km',
      temperatureUnit: 'celsius',
      elapsedRecordField: true,
      force: true,
    });

    parsedData = await parser.parseAsync(buffer);
    normalized = normalizeFit(parsedData, file.name);

    if (!normalized.records.length && !normalized.laps.length) {
      throw new Error('No activity records or splits were found in this FIT file.');
    }

    render(normalized);
    showStatus(
      'success',
      `Ready: ${normalized.records.length.toLocaleString('en-US')} records and ${normalized.laps.length.toLocaleString('en-US')} splits.`
    );
  } catch (error) {
    console.error(error);
    parsedData = null;
    normalized = null;
    els.summarySection.classList.add('hidden');
    showStatus('error', `Unable to read this FIT file: ${String(error?.message ?? error)}`);
  }
}

function normalizeFit(data, sourceFile) {
  const recordsRaw = Array.isArray(data?.records) ? data.records : [];
  const lapsRaw = Array.isArray(data?.laps) ? data.laps : [];
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const session = sessions[0] ?? {};

  const records = recordsRaw.map((r, index) => {
    const speed = num(firstDefined(r.enhanced_speed, r.speed));
    const distance = num(r.distance);

    return {
      record_index: index + 1,
      timestamp: iso(r.timestamp),
      elapsed_time_s: num(r.elapsed_time),
      timer_time_s: num(r.timer_time),
      distance_km: distance,
      speed_kmh: speed,
      pace_min_km: paceFromSpeed(speed),
      heart_rate_bpm: num(r.heart_rate),
      cadence_rpm: num(r.cadence),
      stride_length_m: normalizeStrideLength(r.step_length ?? r.stride_length),
      altitude_m: num(r.altitude),
      enhanced_altitude_m: num(r.enhanced_altitude),
      temperature_c: num(r.temperature),
      power_w: num(r.power),
      position_lat_deg: semicircleToDegrees(r.position_lat),
      position_long_deg: semicircleToDegrees(r.position_long),
    };
  });

  const laps = lapsRaw.map((lap, index) => {
    const distance = num(lap.total_distance);
    const timer = num(firstDefined(lap.total_timer_time, lap.total_elapsed_time));
    const elapsed = num(firstDefined(lap.total_elapsed_time, lap.total_timer_time));
    const avgSpeed = num(firstDefined(lap.enhanced_avg_speed, lap.avg_speed));

    return {
      split: index + 1,
      split_start_time: iso(lap.start_time),
      split_distance_km: distance,
      split_timer_time_s: timer,
      split_elapsed_time_s: elapsed,
      split_avg_pace_min_km: paceFromDistanceTime(distance, timer, avgSpeed),
      split_avg_speed_kmh: avgSpeed,
      split_avg_heart_rate_bpm: num(lap.avg_heart_rate),
      split_max_heart_rate_bpm: num(lap.max_heart_rate),
      split_avg_cadence_rpm: num(lap.avg_cadence),
      split_max_cadence_rpm: num(lap.max_cadence),
      split_avg_power_w: num(lap.avg_power),
      split_max_power_w: num(lap.max_power),
      split_total_ascent_m: num(lap.total_ascent),
      split_total_descent_m: num(lap.total_descent),
      split_calories: num(lap.total_calories),
    };
  });

  const lastRecordDistance = records.length ? records[records.length - 1].distance_km : null;
  const totalDistance = num(firstDefined(
    session.total_distance,
    lastRecordDistance,
    sum(laps.map((x) => x.split_distance_km))
  ));
  const totalTimer = num(firstDefined(
    session.total_timer_time,
    max(records.map((x) => x.timer_time_s)),
    sum(laps.map((x) => x.split_timer_time_s))
  ));
  const totalElapsed = num(firstDefined(
    session.total_elapsed_time,
    max(records.map((x) => x.elapsed_time_s)),
    sum(laps.map((x) => x.split_elapsed_time_s))
  ));
  const avgSpeed = num(firstDefined(session.enhanced_avg_speed, session.avg_speed));
  const avgHr = num(firstDefined(session.avg_heart_rate, average(records.map((x) => x.heart_rate_bpm))));
  const maxHr = num(firstDefined(session.max_heart_rate, max(records.map((x) => x.heart_rate_bpm))));
  const avgCadence = num(firstDefined(session.avg_cadence, average(records.map((x) => x.cadence_rpm))));
  const maxCadence = num(firstDefined(session.max_cadence, max(records.map((x) => x.cadence_rpm))));
  const avgPower = num(firstDefined(session.avg_power, average(records.map((x) => x.power_w))));
  const maxPower = num(firstDefined(session.max_power, max(records.map((x) => x.power_w))));
  const ascent = num(firstDefined(session.total_ascent, sum(laps.map((x) => x.split_total_ascent_m))));
  const descent = num(firstDefined(session.total_descent, sum(laps.map((x) => x.split_total_descent_m))));
  const calories = num(firstDefined(session.total_calories, sum(laps.map((x) => x.split_calories))));
  const sport = String(firstDefined(session.sport, data?.sport, 'activity'));
  const activityStartTime = iso(firstDefined(
    session.start_time,
    laps[0]?.split_start_time,
    records[0]?.timestamp
  ));

  const summary = {
    source_file: sourceFile,
    sport,
    activity_start_time: activityStartTime,
    total_distance_km: totalDistance,
    total_timer_time_s: totalTimer,
    total_elapsed_time_s: totalElapsed,
    avg_pace_min_km: paceFromDistanceTime(totalDistance, totalTimer, avgSpeed),
    avg_speed_kmh: avgSpeed,
    avg_heart_rate_bpm: avgHr,
    max_heart_rate_bpm: maxHr,
    avg_cadence_rpm: avgCadence,
    max_cadence_rpm: maxCadence,
    avg_power_w: avgPower,
    max_power_w: maxPower,
    total_ascent_m: ascent,
    total_descent_m: descent,
    calories,
  };

  const context = {
    source_file: summary.source_file,
    sport: summary.sport,
    activity_start_time: summary.activity_start_time,
  };

  const summaryRow = {
    row_type: 'summary',
    ...context,
    ...summary,
  };

  const splitRows = laps.map((lap) => ({
    row_type: 'split',
    ...context,
    ...lap,
  }));

  const recordRows = records.map((record) => ({
    row_type: 'record',
    ...context,
    ...record,
  }));

  // A single CSV: first the overall context, then splits, then second-by-second records.
  const fullCsvRows = [summaryRow, ...splitRows, ...recordRows];

  return { summary, records, laps, fullCsvRows };
}

function render(data) {
  const s = data.summary;
  els.sportBadge.textContent = titleCase(s.sport);

  const cards = [
    ['Distance', formatNumber(s.total_distance_km, 2), 'km'],
    ['Time', formatDuration(s.total_timer_time_s), ''],
    ['Average Pace', formatPace(s.avg_pace_min_km), '/km'],
    ['Average HR', formatNumber(s.avg_heart_rate_bpm, 0), 'bpm'],
    ['Max HR', formatNumber(s.max_heart_rate_bpm, 0), 'bpm'],
    ['Avg Cadence', formatNumber(s.avg_cadence_rpm, 0), 'rpm'],
    ['Elevation Gain', formatNumber(s.total_ascent_m, 0), 'm'],
    ['Calories', formatNumber(s.calories, 0), 'kcal'],
  ];

  els.summaryGrid.innerHTML = cards.map(([label, value, unit]) => `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)} <span>${escapeHtml(unit)}</span></div>
    </div>
  `).join('');

  if (data.laps.length) {
    els.lapsBody.innerHTML = data.laps.map((lap) => `
      <tr>
        <td>${lap.split}</td>
        <td>${formatNumber(lap.split_distance_km, 2)} km</td>
        <td>${formatDuration(lap.split_timer_time_s)}</td>
        <td>${formatPace(lap.split_avg_pace_min_km)}</td>
        <td>${formatNumber(lap.split_avg_heart_rate_bpm, 0)}</td>
        <td>${formatNumber(lap.split_max_heart_rate_bpm, 0)}</td>
        <td>${formatNumber(lap.split_avg_cadence_rpm, 0)}</td>
        <td>${formatNumber(lap.split_total_ascent_m, 0)} m</td>
      </tr>
    `).join('');
  } else {
    els.lapsBody.innerHTML = '<tr><td colspan="8" class="empty-cell">No split data found in this FIT file.</td></tr>';
  }

  els.summarySection.classList.remove('hidden');
}

function reset() {
  currentFile = null;
  parsedData = null;
  normalized = null;
  els.fileInput.value = '';
  els.fileRow.classList.add('hidden');
  els.summarySection.classList.add('hidden');
  els.status.classList.add('hidden');
}

function showStatus(type, message) {
  els.status.className = `status ${type}`;
  els.status.textContent = message;
}

function downloadCsv(filename, rows, columns) {
  const csv = toCsv(rows, columns);
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function toCsv(rows, columns) {
  const header = columns.map(csvCell).join(',');
  const lines = rows.map((row) => columns.map((column) => csvCell(row[column])).join(','));
  return [header, ...lines].join('\r\n');
}

function csvCell(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function num(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStrideLength(value) {
  const n = num(value);
  if (n === null) return null;
  // Some FIT devices expose step_length in millimetres; values > 10 are almost certainly mm.
  return n > 10 ? n / 1000 : n;
}

function paceFromSpeed(speedKmh) {
  const speed = num(speedKmh);
  return speed && speed > 0 ? 60 / speed : null;
}

function paceFromDistanceTime(distanceKm, seconds, fallbackSpeed) {
  const d = num(distanceKm);
  const t = num(seconds);
  if (d && d > 0 && t && t > 0) return (t / 60) / d;
  return paceFromSpeed(fallbackSpeed);
}

function semicircleToDegrees(value) {
  const n = num(value);
  return n === null ? null : n * (180 / 2147483648);
}

function average(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  if (!valid.length) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function sum(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  return valid.length ? valid.reduce((a, b) => a + b, 0) : null;
}

function max(values) {
  const valid = values.filter((x) => Number.isFinite(x));
  return valid.length ? Math.max(...valid) : null;
}

function iso(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function formatPace(value) {
  const pace = num(value);
  if (!pace || pace <= 0) return '—';
  let minutes = Math.floor(pace);
  let seconds = Math.round((pace - minutes) * 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const value = num(seconds);
  if (value === null) return '—';
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}

function formatNumber(value, decimals = 0) {
  const n = num(value);
  return n === null
    ? '—'
    : n.toLocaleString('en-US', {
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals,
      });
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function baseName(filename) {
  return filename.replace(/\.fit$/i, '').replace(/[^a-zA-Z0-9._-]+/g, '_');
}

function titleCase(value) {
  return String(value || 'activity').replaceAll('_', ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
