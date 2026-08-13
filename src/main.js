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
  deviceGrid: $('deviceGrid'),
  sportBadge: $('sportBadge'),
  lapsBody: $('lapsBody'),
  downloadFullBtn: $('downloadFullBtn'),
  analyzeAiBtn: $('analyzeAiBtn'),
  aiStatus: $('aiStatus'),
  aiResult: $('aiResult'),
};

let currentFile = null;
let parsedData = null;
let exportData = null;

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

els.analyzeAiBtn.addEventListener('click', analyzeWithAi);

els.downloadFullBtn.addEventListener('click', () => {
  if (!exportData || !currentFile) return;
  downloadCsv(`${baseName(currentFile.name)}_full.csv`, exportData.rows, exportData.columns);
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
  resetAiPanel();
  showStatus('loading', 'Reading and decoding FIT data...');

  try {
    const buffer = await file.arrayBuffer();

    // Intentionally use the parser's native/default FIT units and fields.
    // No custom speed/length conversion and no synthetic elapsed/timer fields.
    const parser = new FitParser({ mode: 'list' });
    parsedData = await parser.parseAsync(buffer);

    // Export every message exposed by fit-file-parser's canonical `messages` index.
    // No activity metrics are derived, renamed, filtered, or normalized for the CSV.
    exportData = buildLosslessDecodedCsv(parsedData);

    if (!exportData.rows.length) {
      throw new Error('No decoded FIT messages were found in this file.');
    }

    renderPreview(parsedData);
    showStatus(
      'success',
      `Ready: ${exportData.rows.length.toLocaleString('en-US')} decoded FIT messages across ${exportData.messageTypeCount.toLocaleString('en-US')} message types.`
    );
  } catch (error) {
    console.error(error);
    parsedData = null;
    exportData = null;
    els.summarySection.classList.add('hidden');
    showStatus('error', `Unable to read this FIT file: ${String(error?.message ?? error)}`);
  }
}

/**
 * Creates one wide CSV row per decoded FIT message.
 *
 * Activity data is not calculated or altered. Original parser field names are kept.
 * Two structural columns are required by CSV so mixed FIT message types can coexist:
 *   - message_type: the FIT message collection/name
 *   - message_index: zero-based occurrence within that message type
 *
 * Arrays/objects are serialized as JSON only because a CSV cell must be scalar text.
 */
function buildLosslessDecodedCsv(data) {
  const rows = [];
  const originalFieldNames = [];
  const seenFields = new Set();
  const messages = data?.messages;

  if (messages && typeof messages === 'object') {
    for (const [messageType, value] of Object.entries(messages)) {
      const items = Array.isArray(value) ? value : [value];

      items.forEach((message, messageIndex) => {
        if (!message || typeof message !== 'object') return;

        const row = {
          message_type: messageType,
          message_index: messageIndex,
        };

        for (const [fieldName, fieldValue] of Object.entries(message)) {
          row[fieldName] = fieldValue;
          if (!seenFields.has(fieldName)) {
            seenFields.add(fieldName);
            originalFieldNames.push(fieldName);
          }
        }

        rows.push(row);
      });
    }
  }

  // Compatibility fallback for parser versions/files that do not expose data.messages.
  // Only root arrays of decoded message objects are used; no values are synthesized.
  if (!rows.length && data && typeof data === 'object') {
    for (const [messageType, value] of Object.entries(data)) {
      if (messageType === 'messages' || !Array.isArray(value)) continue;

      value.forEach((message, messageIndex) => {
        if (!message || typeof message !== 'object') return;

        const row = {
          message_type: messageType,
          message_index: messageIndex,
        };

        for (const [fieldName, fieldValue] of Object.entries(message)) {
          row[fieldName] = fieldValue;
          if (!seenFields.has(fieldName)) {
            seenFields.add(fieldName);
            originalFieldNames.push(fieldName);
          }
        }

        rows.push(row);
      });
    }
  }

  return {
    rows,
    columns: ['message_type', 'message_index', ...originalFieldNames],
    messageTypeCount: new Set(rows.map((row) => row.message_type)).size,
  };
}

function getPrimaryDeviceInfo(data) {
  const candidates = [];

  if (Array.isArray(data?.device_infos)) candidates.push(...data.device_infos);
  if (Array.isArray(data?.device_info)) candidates.push(...data.device_info);

  const messageDevices = data?.messages?.device_info;
  if (Array.isArray(messageDevices)) candidates.push(...messageDevices);
  else if (messageDevices && typeof messageDevices === 'object') candidates.push(messageDevices);

  if (data?.file_id && typeof data.file_id === 'object') candidates.push(data.file_id);
  const messageFileId = data?.messages?.file_id;
  if (Array.isArray(messageFileId)) candidates.push(...messageFileId);
  else if (messageFileId && typeof messageFileId === 'object') candidates.push(messageFileId);

  const primary = candidates.find((item) => item?.product_name)
    ?? candidates.find((item) => item?.manufacturer || item?.product)
    ?? {};

  const productName = typeof primary.product_name === 'string' ? primary.product_name.trim() : '';
  const manufacturerRaw = primary.manufacturer ?? '';
  const manufacturer = typeof manufacturerRaw === 'string' ? manufacturerRaw.toUpperCase() : String(manufacturerRaw || '—');
  const product = primary.product ?? '';
  const serialNumber = primary.serial_number ?? primary.serialNumber ?? '';

  let displayName = productName;
  if (!displayName && manufacturer && product !== '') displayName = `${manufacturer} ${product}`;
  if (!displayName && manufacturer && manufacturer !== '—') displayName = manufacturer;
  if (!displayName && product !== '') displayName = `Device ${product}`;
  if (!displayName) displayName = '—';

  return {
    displayName,
    manufacturer: manufacturer || '—',
    productName: productName || (product !== '' ? String(product) : '—'),
    serialNumber: serialNumber !== '' ? String(serialNumber) : '—',
  };
}

function renderPreview(data) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const laps = Array.isArray(data?.laps) ? data.laps : [];
  const records = Array.isArray(data?.records) ? data.records : [];
  const session = sessions[0] ?? {};
  const device = getPrimaryDeviceInfo(data);

  const distanceM = finiteNumber(session.total_distance);
  const timerS = finiteNumber(session.total_timer_time ?? session.total_elapsed_time);
  const avgSpeedMs = finiteNumber(session.enhanced_avg_speed ?? session.avg_speed);
  const sport = session.sport ?? data?.sport ?? 'activity';

  els.sportBadge.textContent = titleCase(sport);

  const deviceItems = [
    ['Watch', device.displayName],
    ['Manufacturer', device.manufacturer],
    ['Product', device.productName],
    ['Serial Number', device.serialNumber],
  ];

  els.deviceGrid.innerHTML = deviceItems.map(([label, value], index) => `
    <div class="device-item">
      ${index === 0 ? '<div class="watch-icon">⌚</div>' : ''}
      <div>
        <div class="device-label">${escapeHtml(label)}</div>
        <div class="device-value">${escapeHtml(value)}</div>
      </div>
    </div>
  `).join('');

  const cards = [
    ['Distance', distanceM === null ? '—' : formatNumber(distanceM / 1000, 2), 'km'],
    ['Time', formatDuration(timerS), ''],
    ['Average Pace', formatPaceFromMps(avgSpeedMs), '/km'],
    ['Average HR', formatNumber(session.avg_heart_rate, 0), 'bpm'],
    ['Max HR', formatNumber(session.max_heart_rate, 0), 'bpm'],
    ['Avg Cadence', formatNumber(session.avg_cadence, 0), 'rpm'],
    ['Elevation Gain', formatNumber(session.total_ascent, 0), 'm'],
    ['Calories', formatNumber(session.total_calories, 0), 'kcal'],
  ];

  els.summaryGrid.innerHTML = cards.map(([label, value, unit]) => `
    <div class="metric-card">
      <div class="metric-label">${escapeHtml(label)}</div>
      <div class="metric-value">${escapeHtml(value)} <span>${escapeHtml(unit)}</span></div>
    </div>
  `).join('');

  if (laps.length) {
    els.lapsBody.innerHTML = laps.map((lap, index) => {
      const lapDistanceM = finiteNumber(lap.total_distance);
      const lapTimerS = finiteNumber(lap.total_timer_time ?? lap.total_elapsed_time);
      const lapSpeedMs = finiteNumber(lap.enhanced_avg_speed ?? lap.avg_speed);
      return `
        <tr>
          <td>${index + 1}</td>
          <td>${lapDistanceM === null ? '—' : `${formatNumber(lapDistanceM / 1000, 2)} km`}</td>
          <td>${formatDuration(lapTimerS)}</td>
          <td>${formatPaceFromMps(lapSpeedMs)}</td>
          <td>${formatNumber(lap.avg_heart_rate, 0)}</td>
          <td>${formatNumber(lap.max_heart_rate, 0)}</td>
          <td>${formatNumber(lap.avg_cadence, 0)}</td>
          <td>${formatNumber(lap.total_ascent, 0)} m</td>
        </tr>
      `;
    }).join('');
  } else {
    els.lapsBody.innerHTML = '<tr><td colspan="8" class="empty-cell">No lap data found in this FIT file.</td></tr>';
  }

  // Keep the preview usable even for FIT files without a session/lap hierarchy.
  if (!sessions.length && records.length) {
    els.sportBadge.textContent = 'FIT Activity';
  }

  els.summarySection.classList.remove('hidden');
}

async function analyzeWithAi() {
  if (!parsedData) return;

  const payload = buildAiAnalysisPayload(parsedData);
  els.analyzeAiBtn.disabled = true;
  els.aiResult.classList.add('hidden');
  showAiStatus('loading', 'Analyzing compact workout metrics with Cloudflare Workers AI...');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let body = null;
    try { body = await response.json(); } catch {}

    if (!response.ok) {
      throw new Error(body?.error || `AI request failed (${response.status}).`);
    }

    renderAiResult(body.analysis);
    showAiStatus('success', 'AI analysis ready.');
  } catch (error) {
    console.error(error);
    showAiStatus('error', String(error?.message || error));
  } finally {
    els.analyzeAiBtn.disabled = false;
  }
}

function buildAiAnalysisPayload(data) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  const laps = Array.isArray(data?.laps) ? data.laps : [];
  const records = Array.isArray(data?.records) ? data.records : [];
  const session = sessions[0] ?? {};
  const device = getPrimaryDeviceInfo(data);

  return {
    schema_version: 1,
    source: {
      sport: String(session.sport ?? data?.sport ?? 'activity'),
      watch_model: device.displayName === '—' ? null : device.displayName,
      privacy_note: 'No filename, serial number, GPS coordinates, or raw FIT file included.'
    },
    session: pickNumericFields(session, {
      total_distance_m: ['total_distance'],
      total_timer_time_s: ['total_timer_time'],
      total_elapsed_time_s: ['total_elapsed_time'],
      avg_speed_mps: ['enhanced_avg_speed', 'avg_speed'],
      max_speed_mps: ['enhanced_max_speed', 'max_speed'],
      avg_heart_rate_bpm: ['avg_heart_rate'],
      max_heart_rate_bpm: ['max_heart_rate'],
      avg_cadence_rpm: ['avg_cadence'],
      max_cadence_rpm: ['max_cadence'],
      avg_power_w: ['avg_power'],
      max_power_w: ['max_power'],
      total_ascent_m: ['total_ascent'],
      total_descent_m: ['total_descent'],
      total_calories_kcal: ['total_calories'],
      avg_step_length: ['avg_step_length'],
      avg_stance_time: ['avg_stance_time'],
      avg_vertical_oscillation: ['avg_vertical_oscillation'],
      avg_vertical_ratio: ['avg_vertical_ratio']
    }),
    laps: laps.slice(0, 40).map((lap, index) => ({
      lap: index + 1,
      ...pickNumericFields(lap, {
        distance_m: ['total_distance'],
        timer_time_s: ['total_timer_time'],
        elapsed_time_s: ['total_elapsed_time'],
        avg_speed_mps: ['enhanced_avg_speed', 'avg_speed'],
        max_speed_mps: ['enhanced_max_speed', 'max_speed'],
        avg_heart_rate_bpm: ['avg_heart_rate'],
        max_heart_rate_bpm: ['max_heart_rate'],
        avg_cadence_rpm: ['avg_cadence'],
        avg_power_w: ['avg_power'],
        max_power_w: ['max_power'],
        total_ascent_m: ['total_ascent'],
        total_descent_m: ['total_descent'],
        avg_step_length: ['avg_step_length'],
        avg_stance_time: ['avg_stance_time'],
        avg_vertical_oscillation: ['avg_vertical_oscillation'],
        avg_vertical_ratio: ['avg_vertical_ratio']
      })
    })),
    windows: buildRecordWindows(records, 10),
    record_count: records.length,
  };
}

function pickNumericFields(source, mapping) {
  const out = {};
  for (const [target, candidates] of Object.entries(mapping)) {
    for (const key of candidates) {
      const value = finiteNumber(source?.[key]);
      if (value !== null) {
        out[target] = value;
        break;
      }
    }
  }
  return out;
}

function buildRecordWindows(records, targetCount) {
  if (!records.length) return [];
  const count = Math.min(targetCount, records.length);
  const windows = [];

  for (let i = 0; i < count; i += 1) {
    const start = Math.floor((i * records.length) / count);
    const end = Math.floor(((i + 1) * records.length) / count);
    const slice = records.slice(start, Math.max(start + 1, end));

    const firstDistance = firstFinite(slice, ['distance']);
    const lastDistance = lastFinite(slice, ['distance']);

    windows.push(compactObject({
      window: i + 1,
      start_distance_m: firstDistance,
      end_distance_m: lastDistance,
      avg_speed_mps: avgFinite(slice, ['enhanced_speed', 'speed']),
      avg_heart_rate_bpm: avgFinite(slice, ['heart_rate']),
      avg_cadence_rpm: avgFinite(slice, ['cadence']),
      avg_power_w: avgFinite(slice, ['power']),
      avg_altitude_m: avgFinite(slice, ['enhanced_altitude', 'altitude']),
      avg_step_length: avgFinite(slice, ['step_length']),
      avg_stance_time: avgFinite(slice, ['stance_time']),
      avg_vertical_oscillation: avgFinite(slice, ['vertical_oscillation']),
      avg_vertical_ratio: avgFinite(slice, ['vertical_ratio'])
    }));
  }

  return windows;
}

function avgFinite(items, keys) {
  let total = 0;
  let count = 0;
  for (const item of items) {
    for (const key of keys) {
      const n = finiteNumber(item?.[key]);
      if (n !== null) { total += n; count += 1; break; }
    }
  }
  return count ? Number((total / count).toFixed(4)) : null;
}

function firstFinite(items, keys) {
  for (const item of items) {
    for (const key of keys) {
      const n = finiteNumber(item?.[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function lastFinite(items, keys) {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    for (const key of keys) {
      const n = finiteNumber(items[i]?.[key]);
      if (n !== null) return n;
    }
  }
  return null;
}

function compactObject(obj) {
  return Object.fromEntries(Object.entries(obj).filter(([, value]) => value !== null && value !== undefined));
}

function renderAiResult(analysis) {
  const positives = Array.isArray(analysis?.positives) ? analysis.positives : [];
  const cautions = Array.isArray(analysis?.cautions) ? analysis.cautions : [];
  const notes = Array.isArray(analysis?.data_notes) ? analysis.data_notes : [];

  els.aiResult.innerHTML = `
    <div class="ai-result-hero">
      <span class="ai-kicker">WORKOUT ANALYSIS</span>
      <h4>${escapeHtml(analysis?.headline || 'Activity analysis')}</h4>
      <p>${escapeHtml(analysis?.overall_assessment || '—')}</p>
    </div>
    <div class="ai-analysis-grid">
      ${aiTextCard('Pacing & Effort', analysis?.pacing_and_effort)}
      ${aiTextCard('Heart Rate', analysis?.heart_rate)}
      ${aiTextCard('Running Form', analysis?.running_form)}
      ${aiTextCard('Next Session', analysis?.next_session)}
    </div>
    <div class="ai-list-grid">
      ${aiListCard('What went well', positives)}
      ${aiListCard('Watch-outs', cautions)}
    </div>
    ${notes.length ? `<div class="ai-data-notes"><strong>Data notes:</strong> ${notes.map(escapeHtml).join(' • ')}</div>` : ''}
    <div class="ai-disclaimer">AI-generated workout analysis is informational and is not medical advice. FIT2CSV does not retain the original FIT file for this analysis.</div>
  `;
  els.aiResult.classList.remove('hidden');
}

function aiTextCard(title, text) {
  return `<article class="ai-analysis-card"><h5>${escapeHtml(title)}</h5><p>${escapeHtml(text || 'Not enough data to assess.')}</p></article>`;
}

function aiListCard(title, items) {
  const rows = items.length ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join('') : '<li>No specific item identified from the available data.</li>';
  return `<article class="ai-list-card"><h5>${escapeHtml(title)}</h5><ul>${rows}</ul></article>`;
}

function showAiStatus(type, message) {
  els.aiStatus.className = `ai-status ${type}`;
  els.aiStatus.textContent = message;
}

function resetAiPanel() {
  if (!els.aiStatus || !els.aiResult || !els.analyzeAiBtn) return;
  els.aiStatus.classList.add('hidden');
  els.aiResult.classList.add('hidden');
  els.aiResult.innerHTML = '';
  els.analyzeAiBtn.disabled = false;
}

function reset() {
  currentFile = null;
  parsedData = null;
  exportData = null;
  els.fileInput.value = '';
  els.fileRow.classList.add('hidden');
  els.summarySection.classList.add('hidden');
  els.status.classList.add('hidden');
  resetAiPanel();
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
  if (value === undefined || value === null) return '';

  let text;
  if (value instanceof Date) {
    text = value.toISOString();
  } else if (typeof value === 'bigint') {
    text = value.toString();
  } else if (ArrayBuffer.isView(value)) {
    text = JSON.stringify(Array.from(value));
  } else if (Array.isArray(value) || typeof value === 'object') {
    text = JSON.stringify(value, jsonReplacer);
  } else {
    text = String(value);
  }

  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function jsonReplacer(_key, value) {
  if (typeof value === 'bigint') return value.toString();
  if (ArrayBuffer.isView(value)) return Array.from(value);
  return value;
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function formatPaceFromMps(speedMps) {
  const speed = finiteNumber(speedMps);
  if (!speed || speed <= 0) return '—';
  const pace = 1000 / speed / 60;
  let minutes = Math.floor(pace);
  let seconds = Math.round((pace - minutes) * 60);
  if (seconds === 60) {
    minutes += 1;
    seconds = 0;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function formatDuration(seconds) {
  const value = finiteNumber(seconds);
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
  const n = finiteNumber(value);
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
