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
  downloadRecordsBtn: $('downloadRecordsBtn'),
  downloadLapsBtn: $('downloadLapsBtn'),
  downloadAllBtn: $('downloadAllBtn'),
};

let currentFile = null;
let parsedData = null;
let normalized = null;

const RECORD_COLUMNS = [
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

const LAP_COLUMNS = [
  'lap',
  'start_time',
  'total_distance_km',
  'total_timer_time_s',
  'avg_pace_min_km',
  'avg_speed_kmh',
  'avg_heart_rate_bpm',
  'max_heart_rate_bpm',
  'avg_cadence_rpm',
  'max_cadence_rpm',
  'total_ascent_m',
  'total_descent_m',
  'calories',
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

els.downloadRecordsBtn.addEventListener('click', () => {
  if (!normalized) return;
  downloadCsv(`${baseName(currentFile.name)}_records.csv`, normalized.records, RECORD_COLUMNS);
});

els.downloadLapsBtn.addEventListener('click', () => {
  if (!normalized) return;
  downloadCsv(`${baseName(currentFile.name)}_laps.csv`, normalized.laps, LAP_COLUMNS);
});

els.downloadAllBtn.addEventListener('click', () => {
  if (!normalized) return;
  downloadCsv(`${baseName(currentFile.name)}_activity.csv`, normalized.activityRows, normalized.activityColumns);
});

async function handleFile(file) {
  if (!file.name.toLowerCase().endsWith('.fit')) {
    showStatus('error', 'File không hợp lệ. Hãy chọn file có đuôi .fit.');
    return;
  }

  currentFile = file;
  els.fileName.textContent = file.name;
  els.fileMeta.textContent = `${formatBytes(file.size)} • xử lý ngay trên thiết bị này`;
  els.fileRow.classList.remove('hidden');
  els.summarySection.classList.add('hidden');
  showStatus('loading', 'Đang đọc và phân tích FIT...');

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
    normalized = normalizeFit(parsedData);

    if (!normalized.records.length && !normalized.laps.length) {
      throw new Error('Không tìm thấy record hoặc lap trong file FIT.');
    }

    render(normalized);
    showStatus('success', `Đã đọc xong: ${normalized.records.length.toLocaleString('vi-VN')} records, ${normalized.laps.length} laps.`);
  } catch (error) {
    console.error(error);
    parsedData = null;
    normalized = null;
    els.summarySection.classList.add('hidden');
    showStatus('error', `Không thể đọc file FIT: ${String(error?.message ?? error)}`);
  }
}

function normalizeFit(data) {
  const recordsRaw = Array.isArray(data?.records) ? data.records : [];
  const lapsRaw = Array.isArray(data?.laps) ? data.laps : [];
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const session = sessions[0] ?? {};

  const records = recordsRaw.map((r) => {
    const speed = num(firstDefined(r.enhanced_speed, r.speed));
    const distance = num(r.distance);
    return {
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
    const avgSpeed = num(firstDefined(lap.enhanced_avg_speed, lap.avg_speed));
    return {
      lap: index + 1,
      start_time: iso(lap.start_time),
      total_distance_km: distance,
      total_timer_time_s: timer,
      avg_pace_min_km: paceFromDistanceTime(distance, timer, avgSpeed),
      avg_speed_kmh: avgSpeed,
      avg_heart_rate_bpm: num(lap.avg_heart_rate),
      max_heart_rate_bpm: num(lap.max_heart_rate),
      avg_cadence_rpm: num(lap.avg_cadence),
      max_cadence_rpm: num(lap.max_cadence),
      total_ascent_m: num(lap.total_ascent),
      total_descent_m: num(lap.total_descent),
      calories: num(lap.total_calories),
    };
  });

  const lastRecordDistance = records.length ? records[records.length - 1].distance_km : null;
  const totalDistance = num(firstDefined(session.total_distance, lastRecordDistance, sum(laps.map((x) => x.total_distance_km))));
  const totalTimer = num(firstDefined(session.total_timer_time, session.total_elapsed_time, max(records.map((x) => x.timer_time_s)), sum(laps.map((x) => x.total_timer_time_s))));
  const avgSpeed = num(firstDefined(session.enhanced_avg_speed, session.avg_speed));
  const avgHr = num(firstDefined(session.avg_heart_rate, average(records.map((x) => x.heart_rate_bpm))));
  const maxHr = num(firstDefined(session.max_heart_rate, max(records.map((x) => x.heart_rate_bpm))));
  const avgCadence = num(firstDefined(session.avg_cadence, average(records.map((x) => x.cadence_rpm))));
  const ascent = num(firstDefined(session.total_ascent, sum(laps.map((x) => x.total_ascent_m))));
  const calories = num(firstDefined(session.total_calories, sum(laps.map((x) => x.calories))));
  const sport = String(firstDefined(session.sport, data?.sport, 'activity'));

  const summary = {
    sport,
    total_distance_km: totalDistance,
    total_timer_time_s: totalTimer,
    avg_pace_min_km: paceFromDistanceTime(totalDistance, totalTimer, avgSpeed),
    avg_heart_rate_bpm: avgHr,
    max_heart_rate_bpm: maxHr,
    avg_cadence_rpm: avgCadence,
    total_ascent_m: ascent,
    calories,
  };

  const activityColumns = ['section', 'metric', 'value', 'unit'];
  const activityRows = [
    { section: 'summary', metric: 'sport', value: summary.sport, unit: '' },
    { section: 'summary', metric: 'distance', value: summary.total_distance_km, unit: 'km' },
    { section: 'summary', metric: 'time', value: summary.total_timer_time_s, unit: 's' },
    { section: 'summary', metric: 'avg_pace', value: summary.avg_pace_min_km, unit: 'min/km' },
    { section: 'summary', metric: 'avg_hr', value: summary.avg_heart_rate_bpm, unit: 'bpm' },
    { section: 'summary', metric: 'max_hr', value: summary.max_heart_rate_bpm, unit: 'bpm' },
    { section: 'summary', metric: 'avg_cadence', value: summary.avg_cadence_rpm, unit: 'rpm' },
    { section: 'summary', metric: 'elevation_gain', value: summary.total_ascent_m, unit: 'm' },
    { section: 'summary', metric: 'calories', value: summary.calories, unit: 'kcal' },
    ...laps.map((lap) => ({ section: `lap_${lap.lap}`, metric: 'json', value: JSON.stringify(lap), unit: '' })),
  ];

  return { summary, records, laps, activityRows, activityColumns };
}

function render(data) {
  const s = data.summary;
  els.sportBadge.textContent = titleCase(s.sport);

  const cards = [
    ['Distance', formatNumber(s.total_distance_km, 2), 'km'],
    ['Time', formatDuration(s.total_timer_time_s), ''],
    ['Avg Pace', formatPace(s.avg_pace_min_km), '/km'],
    ['Avg HR', formatNumber(s.avg_heart_rate_bpm, 0), 'bpm'],
    ['Max HR', formatNumber(s.max_heart_rate_bpm, 0), 'bpm'],
    ['Cadence', formatNumber(s.avg_cadence_rpm, 0), 'rpm'],
    ['Elevation +', formatNumber(s.total_ascent_m, 0), 'm'],
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
        <td>${lap.lap}</td>
        <td>${formatNumber(lap.total_distance_km, 2)} km</td>
        <td>${formatDuration(lap.total_timer_time_s)}</td>
        <td>${formatPace(lap.avg_pace_min_km)}</td>
        <td>${formatNumber(lap.avg_heart_rate_bpm, 0)}</td>
        <td>${formatNumber(lap.max_heart_rate_bpm, 0)}</td>
        <td>${formatNumber(lap.avg_cadence_rpm, 0)}</td>
        <td>${formatNumber(lap.total_ascent_m, 0)} m</td>
      </tr>
    `).join('');
  } else {
    els.lapsBody.innerHTML = '<tr><td colspan="8" class="empty-cell">File FIT này không chứa lap.</td></tr>';
  }

  els.downloadLapsBtn.disabled = !data.laps.length;
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
  // Some FIT devices expose step_length in mm; values > 10 are almost certainly millimetres.
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
  return n === null ? '—' : n.toLocaleString('vi-VN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
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
