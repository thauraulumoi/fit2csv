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
  copyCsvBtn: $('copyCsvBtn'),
  analyzeAiBtn: $('analyzeAiBtn'),
  aiLanguage: $('aiLanguage'),
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

// Paste support: if the clipboard contains a real file object, accept the first .FIT file.
// This works when the source app/OS places the copied file itself on the clipboard.
// Plain-text filesystem paths are intentionally not opened because browsers cannot safely
// access arbitrary local paths from clipboard text.
document.addEventListener('paste', (event) => {
  const clipboard = event.clipboardData;
  if (!clipboard) return;

  const candidates = [];

  for (const file of Array.from(clipboard.files || [])) {
    candidates.push(file);
  }

  for (const item of Array.from(clipboard.items || [])) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile?.();
    if (file) candidates.push(file);
  }

  const fitFile = candidates.find((file) =>
    String(file?.name || '').toLowerCase().endsWith('.fit')
  );

  if (!fitFile) return;

  event.preventDefault();
  handleFile(fitFile);
});

els.analyzeAiBtn.addEventListener('click', analyzeWithAi);

els.downloadFullBtn.addEventListener('click', () => {
  if (!exportData || !currentFile) return;
  downloadCsv(`${baseName(currentFile.name)}_full.csv`, exportData.rows, exportData.columns);
});

els.copyCsvBtn.addEventListener('click', copyFullCsvToClipboard);

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

  const language = resolveAnalysisLanguage(els.aiLanguage?.value || 'auto');
  const payload = buildAiAnalysisPayload(parsedData);
  payload.analysis_language = language;

  els.analyzeAiBtn.disabled = true;
  if (els.aiLanguage) els.aiLanguage.disabled = true;
  els.aiResult.classList.add('hidden');
  showAiStatus('loading', 'Analyzing compact workout metrics with AI...');

  try {
    const response = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    let body = null;
    try { body = await response.json(); } catch {}

    if (!response.ok) {
      const ui = getAiUiText(language);
      const messages = {
        AI_SERVICE_QUOTA_EXCEEDED: ui.serviceQuota,
        AI_SERVICE_BUSY: ui.serviceBusy,
        AI_SERVICE_UNAVAILABLE: ui.serviceUnavailable,
      };
      const message = messages[body?.code] || body?.error || ui.serviceUnavailable;
      const requestError = new Error(message);
      requestError.code = body?.code;
      throw requestError;
    }

    renderAiResult(body.analysis, language);
    showAiStatus('success', getAiUiText(language).ready);
  } catch (error) {
    console.error(error);
    showAiStatus('error', String(error?.message || error));
  } finally {
    els.analyzeAiBtn.disabled = false;
    if (els.aiLanguage) els.aiLanguage.disabled = false;
  }
}


const SUPPORTED_ANALYSIS_LANGUAGES = new Set(['en', 'vi', 'es', 'de', 'fr', 'ja', 'ko', 'zh']);

function resolveAnalysisLanguage(selected) {
  if (selected && selected !== 'auto' && SUPPORTED_ANALYSIS_LANGUAGES.has(selected)) {
    return selected;
  }

  const browserLanguage = String(navigator.language || navigator.languages?.[0] || 'en').toLowerCase();
  const primary = browserLanguage.split('-')[0];
  if (primary === 'zh') return 'zh';
  return SUPPORTED_ANALYSIS_LANGUAGES.has(primary) ? primary : 'en';
}

function getAiUiText(language) {
  const labels = {
    en: {
      kicker: 'WORKOUT ANALYSIS',
      fallbackHeadline: 'Activity analysis',
      pacing: 'Pacing & Effort',
      heartRate: 'Heart Rate',
      runningForm: 'Running Form',
      nextSession: 'Next Session',
      positives: 'What went well',
      cautions: 'Watch-outs',
      dataNotes: 'Data notes',
      noData: 'Not enough data to assess.',
      noItem: 'No specific item identified from the available data.',
      disclaimer: 'AI-generated workout analysis is informational and is not medical advice. FIT2CSV does not retain the original FIT file for this analysis.',
      ready: 'AI analysis ready.',
      dailyLimit: 'Daily AI analysis limit reached. Each IP can analyze up to 3 activities per day. Please try again tomorrow.',
      serviceQuota: 'AI analysis is temporarily unavailable because the service usage limit has been reached. Please try again later.',
      serviceBusy: 'AI is busy right now. Please wait a moment and try again.',
      serviceUnavailable: 'AI analysis is temporarily unavailable. Please try again later.'
    },
    vi: {
      kicker: 'PHÂN TÍCH BUỔI TẬP',
      fallbackHeadline: 'Phân tích hoạt động',
      pacing: 'Pace & Cường độ',
      heartRate: 'Nhịp tim',
      runningForm: 'Kỹ thuật chạy',
      nextSession: 'Buổi tập tiếp theo',
      positives: 'Điểm làm tốt',
      cautions: 'Điểm cần lưu ý',
      dataNotes: 'Ghi chú dữ liệu',
      noData: 'Không đủ dữ liệu để đánh giá.',
      noItem: 'Không xác định được điểm cụ thể từ dữ liệu hiện có.',
      disclaimer: 'Phân tích do AI tạo chỉ mang tính tham khảo và không phải tư vấn y tế. FIT2CSV không lưu file FIT gốc cho lần phân tích này.',
      ready: 'Phân tích AI đã sẵn sàng.',
      dailyLimit: 'Đã đạt giới hạn phân tích AI trong ngày. Mỗi IP được phân tích tối đa 3 hoạt động mỗi ngày. Vui lòng thử lại vào ngày mai.',
      serviceQuota: 'Phân tích AI tạm thời không khả dụng vì dịch vụ đã đạt giới hạn sử dụng. Vui lòng thử lại sau.',
      serviceBusy: 'AI hiện đang bận. Vui lòng đợi một chút rồi thử lại.',
      serviceUnavailable: 'Phân tích AI tạm thời không khả dụng. Vui lòng thử lại sau.'
    },
    es: {
      kicker: 'ANÁLISIS DEL ENTRENAMIENTO',
      fallbackHeadline: 'Análisis de la actividad',
      pacing: 'Ritmo y esfuerzo',
      heartRate: 'Frecuencia cardíaca',
      runningForm: 'Técnica de carrera',
      nextSession: 'Próxima sesión',
      positives: 'Lo que salió bien',
      cautions: 'Aspectos a vigilar',
      dataNotes: 'Notas de datos',
      noData: 'No hay suficientes datos para evaluar.',
      noItem: 'No se identificó ningún punto específico con los datos disponibles.',
      disclaimer: 'El análisis generado por IA es informativo y no constituye consejo médico. FIT2CSV no conserva el archivo FIT original para este análisis.',
      ready: 'Análisis de IA listo.',
      dailyLimit: 'Se alcanzó el límite diario de análisis con IA. Cada IP puede analizar hasta 3 actividades al día. Inténtalo de nuevo mañana.',
      serviceQuota: 'El análisis con IA no está disponible temporalmente porque se alcanzó el límite de uso del servicio. Inténtalo más tarde.',
      serviceBusy: 'La IA está ocupada en este momento. Espera un momento e inténtalo de nuevo.',
      serviceUnavailable: 'El análisis con IA no está disponible temporalmente. Inténtalo más tarde.'
    },
    de: {
      kicker: 'TRAININGSANALYSE',
      fallbackHeadline: 'Aktivitätsanalyse',
      pacing: 'Tempo & Belastung',
      heartRate: 'Herzfrequenz',
      runningForm: 'Laufform',
      nextSession: 'Nächste Einheit',
      positives: 'Was gut lief',
      cautions: 'Worauf achten',
      dataNotes: 'Datenhinweise',
      noData: 'Nicht genügend Daten für eine Bewertung.',
      noItem: 'Aus den verfügbaren Daten wurde kein konkreter Punkt erkannt.',
      disclaimer: 'Die KI-generierte Trainingsanalyse dient nur zur Information und ist keine medizinische Beratung. FIT2CSV speichert die ursprüngliche FIT-Datei für diese Analyse nicht.',
      ready: 'KI-Analyse ist fertig.',
      dailyLimit: 'Das tägliche KI-Analyselimit wurde erreicht. Pro IP sind maximal 3 Analysen pro Tag möglich. Bitte morgen erneut versuchen.',
      serviceQuota: 'Die KI-Analyse ist vorübergehend nicht verfügbar, da das Nutzungslimit des Dienstes erreicht wurde. Bitte später erneut versuchen.',
      serviceBusy: 'Die KI ist derzeit ausgelastet. Bitte kurz warten und erneut versuchen.',
      serviceUnavailable: 'Die KI-Analyse ist vorübergehend nicht verfügbar. Bitte später erneut versuchen.'
    },
    fr: {
      kicker: 'ANALYSE DE LA SÉANCE',
      fallbackHeadline: "Analyse de l’activité",
      pacing: 'Allure & effort',
      heartRate: 'Fréquence cardiaque',
      runningForm: 'Technique de course',
      nextSession: 'Prochaine séance',
      positives: 'Points positifs',
      cautions: 'Points à surveiller',
      dataNotes: 'Notes sur les données',
      noData: 'Données insuffisantes pour évaluer.',
      noItem: 'Aucun élément précis identifié à partir des données disponibles.',
      disclaimer: "L’analyse générée par l’IA est fournie à titre informatif et ne constitue pas un avis médical. FIT2CSV ne conserve pas le fichier FIT d’origine pour cette analyse.",
      ready: 'Analyse IA prête.',
      dailyLimit: 'La limite quotidienne d’analyse IA est atteinte. Chaque IP peut analyser jusqu’à 3 activités par jour. Réessayez demain.',
      serviceQuota: 'L’analyse IA est temporairement indisponible car la limite d’utilisation du service a été atteinte. Réessayez plus tard.',
      serviceBusy: 'L’IA est occupée pour le moment. Patientez un instant puis réessayez.',
      serviceUnavailable: 'L’analyse IA est temporairement indisponible. Réessayez plus tard.'
    },
    ja: {
      kicker: 'ワークアウト分析',
      fallbackHeadline: 'アクティビティ分析',
      pacing: 'ペースと強度',
      heartRate: '心拍数',
      runningForm: 'ランニングフォーム',
      nextSession: '次回セッション',
      positives: '良かった点',
      cautions: '注意点',
      dataNotes: 'データ注記',
      noData: '評価するためのデータが不足しています。',
      noItem: '利用可能なデータから特定の項目は確認できませんでした。',
      disclaimer: 'AIによるワークアウト分析は参考情報であり、医療上の助言ではありません。FIT2CSVはこの分析のために元のFITファイルを保持しません。',
      ready: 'AI分析が完了しました。',
      dailyLimit: '1日のAI分析上限に達しました。1つのIPにつき1日3回まで分析できます。明日もう一度お試しください。',
      serviceQuota: 'サービスの利用上限に達したため、AI分析は一時的に利用できません。後でもう一度お試しください。',
      serviceBusy: 'AIが混み合っています。少し待ってからもう一度お試しください。',
      serviceUnavailable: 'AI分析は一時的に利用できません。後でもう一度お試しください。'
    },
    ko: {
      kicker: '운동 분석',
      fallbackHeadline: '활동 분석',
      pacing: '페이스 및 강도',
      heartRate: '심박수',
      runningForm: '러닝 폼',
      nextSession: '다음 세션',
      positives: '잘된 점',
      cautions: '주의할 점',
      dataNotes: '데이터 참고',
      noData: '평가할 데이터가 충분하지 않습니다.',
      noItem: '사용 가능한 데이터에서 특정 항목을 확인하지 못했습니다.',
      disclaimer: 'AI 운동 분석은 참고용이며 의료 조언이 아닙니다. FIT2CSV는 이 분석을 위해 원본 FIT 파일을 보관하지 않습니다.',
      ready: 'AI 분석이 완료되었습니다.',
      dailyLimit: '일일 AI 분석 한도에 도달했습니다. IP당 하루 최대 3개의 활동을 분석할 수 있습니다. 내일 다시 시도해 주세요.',
      serviceQuota: '서비스 사용 한도에 도달하여 AI 분석을 일시적으로 사용할 수 없습니다. 나중에 다시 시도해 주세요.',
      serviceBusy: '현재 AI 요청이 많습니다. 잠시 후 다시 시도해 주세요.',
      serviceUnavailable: 'AI 분석을 일시적으로 사용할 수 없습니다. 나중에 다시 시도해 주세요.'
    },
    zh: {
      kicker: '训练分析',
      fallbackHeadline: '活动分析',
      pacing: '配速与强度',
      heartRate: '心率',
      runningForm: '跑步姿态',
      nextSession: '下一次训练',
      positives: '表现良好',
      cautions: '需要注意',
      dataNotes: '数据说明',
      noData: '数据不足，无法评估。',
      noItem: '未能从现有数据中识别出具体项目。',
      disclaimer: 'AI 生成的训练分析仅供参考，不构成医疗建议。FIT2CSV 不会为此次分析保留原始 FIT 文件。',
      ready: 'AI 分析已完成。',
      dailyLimit: '已达到每日 AI 分析上限。每个 IP 每天最多可分析 3 个活动，请明天再试。',
      serviceQuota: '由于 AI 服务已达到使用上限，分析暂时不可用，请稍后再试。',
      serviceBusy: 'AI 当前较忙，请稍等片刻后重试。',
      serviceUnavailable: 'AI 分析暂时不可用，请稍后再试。'
    }
  };
  return labels[language] || labels.en;
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

function renderAiResult(analysis, language = 'en') {
  const ui = getAiUiText(language);
  const positives = Array.isArray(analysis?.positives) ? analysis.positives : [];
  const cautions = Array.isArray(analysis?.cautions) ? analysis.cautions : [];
  const notes = Array.isArray(analysis?.data_notes) ? analysis.data_notes : [];

  els.aiResult.innerHTML = `
    <div class="ai-result-hero">
      <span class="ai-kicker">${escapeHtml(ui.kicker)}</span>
      <h4>${escapeHtml(analysis?.headline || ui.fallbackHeadline)}</h4>
      <p>${escapeHtml(analysis?.overall_assessment || '—')}</p>
    </div>
    <div class="ai-analysis-grid">
      ${aiTextCard(ui.pacing, analysis?.pacing_and_effort, ui.noData)}
      ${aiTextCard(ui.heartRate, analysis?.heart_rate, ui.noData)}
      ${aiTextCard(ui.runningForm, analysis?.running_form, ui.noData)}
      ${aiTextCard(ui.nextSession, analysis?.next_session, ui.noData)}
    </div>
    <div class="ai-list-grid">
      ${aiListCard(ui.positives, positives, ui.noItem)}
      ${aiListCard(ui.cautions, cautions, ui.noItem)}
    </div>
    ${notes.length ? `<div class="ai-data-notes"><strong>${escapeHtml(ui.dataNotes)}:</strong> ${notes.map(escapeHtml).join(' • ')}</div>` : ''}
    <div class="ai-disclaimer">${escapeHtml(ui.disclaimer)}</div>
  `;
  els.aiResult.classList.remove('hidden');
}

function aiTextCard(title, text, fallback = 'Not enough data to assess.') {
  return `<article class="ai-analysis-card"><h5>${escapeHtml(title)}</h5><p>${escapeHtml(text || fallback)}</p></article>`;
}

function aiListCard(title, items, fallback = 'No specific item identified from the available data.') {
  const rows = items.length ? items.map((item) => `<li>${escapeHtml(item)}</li>`).join('') : `<li>${escapeHtml(fallback)}</li>`;
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
  if (els.aiLanguage) els.aiLanguage.disabled = false;
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

async function copyFullCsvToClipboard() {
  if (!exportData) return;

  const csv = toCsv(exportData.rows, exportData.columns);

  if (!navigator.clipboard?.writeText) {
    showStatus('error', 'Clipboard copy is not supported by this browser. Please use Download Full CSV instead.');
    return;
  }

  els.copyCsvBtn.disabled = true;

  try {
    await navigator.clipboard.writeText(csv);
    showStatus('success', `CSV copied to clipboard: ${exportData.rows.length.toLocaleString('en-US')} decoded FIT messages.`);
    const original = els.copyCsvBtn.querySelector('span')?.textContent;
    const label = els.copyCsvBtn.querySelector('span');
    if (label) label.textContent = 'Copied!';
    window.setTimeout(() => {
      if (label) label.textContent = original || 'Copy CSV';
    }, 1600);
  } catch (error) {
    console.error('Copy CSV failed:', error);
    showStatus('error', 'Could not copy CSV to the clipboard. Please use Download Full CSV instead.');
  } finally {
    els.copyCsvBtn.disabled = false;
  }
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
