(() => {
  'use strict';

  const STATUS_LABELS = {
    queued: 'В очереди',
    decoding: 'Подготовка',
    separating: 'Разделение',
    encoding: 'Сборка',
    done: 'Готово',
    error: 'Ошибка',
    cancelled: 'Отменено'
  };
  const ACTIVE_STATUSES = new Set(['decoding', 'separating', 'encoding']);
  const OUTPUT_LABELS = {
    speech: 'Речь',
    voice: 'Речь',
    vocals: 'Речь',
    dialogue: 'Речь',
    music: 'Музыка',
    effects: 'Эффекты',
    effect: 'Эффекты',
    sfx: 'Эффекты'
  };
  const OUTPUT_ORDER = ['Речь', 'Музыка', 'Эффекты'];
  const POLL_ONLINE_MS = 1600;
  const POLL_BUSY_MS = 850;
  const POLL_OFFLINE_MS = 2800;

  const app = document.getElementById('app');
  const fileInput = document.getElementById('file-input');
  const chooseButton = document.getElementById('choose-button');
  const dropZone = document.getElementById('drop-zone');
  const uploadProgressWrap = document.getElementById('upload-progress-wrap');
  const uploadProgress = document.getElementById('upload-progress');
  const uploadProgressValue = document.getElementById('upload-progress-value');
  const uploadProgressLabel = document.getElementById('upload-progress-label');
  const queueList = document.getElementById('queue-list');
  const queueCount = document.getElementById('queue-count');
  const saveAllAction = document.getElementById('save-all-action');
  const saveAllButton = document.getElementById('save-all-button');
  const saveAllStatus = document.getElementById('save-all-status');
  const fileSwitcher = document.getElementById('file-switcher');
  const previousFileButton = document.getElementById('previous-file');
  const nextFileButton = document.getElementById('next-file');
  const fileSelect = document.getElementById('file-select');
  const filePosition = document.getElementById('file-position');
  const emptyQueue = document.getElementById('empty-queue');
  const loadingCard = document.getElementById('loading-card');
  const offlineBanner = document.getElementById('offline-banner');
  const offlineMessage = document.getElementById('offline-message');
  const retryButton = document.getElementById('retry-button');
  const offlineRetryButton = document.getElementById('offline-retry-button');
  const shutdownButton = document.getElementById('shutdown-button');
  const shutdownOverlay = document.getElementById('shutdown-overlay');
  const shutdownMessage = document.getElementById('shutdown-message');
  const connectionState = document.getElementById('connection-state');
  const liveRegion = document.getElementById('live-region');
  const toast = document.getElementById('toast');
  const desktopBridge = window.mrxDesktop && window.mrxDesktop.isDesktop ? window.mrxDesktop : null;

  let state = { version: '1.0.0', jobs: [], busy: false };
  let initialLoading = true;
  let offline = false;
  let shutdownRequested = false;
  let uploadXhr = null;
  let localSubmitPending = false;
  let pollTimer = null;
  let pollInFlight = false;
  let toastTimer = null;
  let lastAnnouncement = '';
  const cancelling = new Set();
  const jobNodes = new Map();
  const jobRenderKeys = new Map();
  let activePreview = null;
  let selectedJobId = null;
  let fileSwitcherSignature = '';
  let fileSwitcherSyncPending = false;
  let saveAllPending = false;
  let saveAllSnapshotReadyCount = 0;
  let saveAllSnapshotJobIds = new Set();

  function createElement(tagName, className, text) {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = String(text);
    return element;
  }

  function isSubmitting() {
    return Boolean(uploadXhr) || localSubmitPending;
  }

  function clampProgress(value) {
    const number = Number(value);
    if (!Number.isFinite(number)) return 0;
    return Math.max(0, Math.min(100, Math.round(number)));
  }

  function normalizeState(payload) {
    if (!payload || !Array.isArray(payload.jobs)) {
      throw new Error('Сервер вернул неполное состояние очереди.');
    }

    return {
      version: typeof payload.version === 'string' ? payload.version : '1.0.0',
      busy: Boolean(payload.busy),
      jobs: payload.jobs.map((rawJob, index) => {
        const job = rawJob && typeof rawJob === 'object' ? rawJob : {};
        const outputs = Array.isArray(job.outputs) ? job.outputs : [];
        return {
          id: job.id === undefined || job.id === null ? `job-${index}` : String(job.id),
          name: typeof job.name === 'string' && job.name ? job.name : 'Без названия',
          status: STATUS_LABELS[job.status] ? job.status : 'queued',
          progress: clampProgress(job.progress),
          message: typeof job.message === 'string' ? job.message : '',
          outputs: outputs.map((output) => {
            const item = output && typeof output === 'object' ? output : {};
            return {
              label: typeof item.label === 'string' ? item.label : '',
              filename: typeof item.filename === 'string' ? item.filename : '',
              url: typeof item.url === 'string' ? item.url : '',
              previewUrl: typeof item.previewUrl === 'string' ? item.previewUrl : ''
            };
          }),
          zipUrl: typeof job.zipUrl === 'string' ? job.zipUrl : ''
        };
      })
    };
  }

  function activeJobCount() {
    return state.jobs.filter((job) => ACTIVE_STATUSES.has(job.status)).length;
  }

  function hasWorkingState() {
    return Boolean(state.busy) || activeJobCount() > 0;
  }

  function processingJobCount() {
    return state.jobs.filter((job) => job.status === 'queued' || ACTIVE_STATUSES.has(job.status)).length;
  }

  function readyJobCount() {
    return state.jobs.filter((job) => job.status === 'done').length;
  }

  function skippedJobCount() {
    return state.jobs.filter((job) => job.status === 'error' || job.status === 'cancelled').length;
  }

  function countLabel(count) {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return `${count} файл`;
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} файла`;
    return `${count} файлов`;
  }

  function addedLabel(count) {
    return `Добавлено файлов: ${count}`;
  }

  function updateSaveAllState() {
    if (!saveAllButton || !saveAllStatus || !saveAllAction) return;
    const ready = readyJobCount();
    const processing = processingJobCount();
    const busy = Boolean(state.busy);
    const skipped = skippedJobCount();
    saveAllAction.hidden = state.jobs.length === 0;

    if (saveAllPending) {
      const snapshot = saveAllSnapshotReadyCount || ready;
      saveAllStatus.textContent = snapshot > 0 ? `Готовим архив · ${snapshot} готово` : 'Готовим архив…';
    } else if (shutdownRequested) {
      saveAllStatus.textContent = 'Приложение закрывается';
    } else if (offline) {
      saveAllStatus.textContent = 'Нет связи с приложением';
    } else if (isSubmitting()) {
      saveAllStatus.textContent = 'Ожидаем завершение загрузки';
    } else if (processing > 0 || busy) {
      saveAllStatus.textContent = ready > 0
        ? `${ready} готово · ${processing || 1} в работе`
        : `${processing || 1} в обработке`;
    } else if (ready > 0) {
      saveAllStatus.textContent = skipped > 0
        ? `Готово: ${ready} · пропущено: ${skipped}`
        : `Готово файлов: ${ready}`;
    } else if (skipped > 0) {
      saveAllStatus.textContent = `Нет готовых · пропущено: ${skipped}`;
    } else {
      saveAllStatus.textContent = 'Нет готовых файлов';
    }

    saveAllButton.disabled = saveAllPending || shutdownRequested || offline || isSubmitting() || processing > 0 || busy || ready < 1;
    saveAllButton.setAttribute('aria-busy', saveAllPending ? 'true' : 'false');
  }

  function selectedJobIndex() {
    return state.jobs.findIndex((job) => job.id === selectedJobId);
  }

  function ensureSelectedJob() {
    if (!state.jobs.length) {
      selectedJobId = null;
      return;
    }
    if (selectedJobIndex() === -1) selectedJobId = state.jobs[0].id;
  }

  function fileOptionLabel(job) {
    return `${job.name} — ${STATUS_LABELS[job.status] || 'В очереди'}`;
  }

  function updateSelectedJobView() {
    Array.from(queueList.children).forEach((node) => {
      const selected = node.dataset.jobId === selectedJobId;
      node.hidden = !selected;
    });
  }

  function syncFileSwitcher(force = false) {
    if (!fileSwitcher || !fileSelect) return;
    if (state.jobs.length <= 1) {
      fileSwitcher.hidden = true;
      fileSwitcherSignature = '';
      fileSwitcherSyncPending = false;
      return;
    }
    if (!force && document.activeElement === fileSelect) {
      fileSwitcherSyncPending = true;
      return;
    }

    fileSwitcher.hidden = false;
    const signature = state.jobs.map((job) => `${job.id}\u0000${job.name}\u0000${job.status}`).join('\u0001');
    if (signature !== fileSwitcherSignature || fileSwitcherSyncPending) {
      const fragment = document.createDocumentFragment();
      state.jobs.forEach((job) => {
        const option = document.createElement('option');
        option.value = job.id;
        option.textContent = fileOptionLabel(job);
        option.title = job.name;
        fragment.append(option);
      });
      fileSelect.replaceChildren(fragment);
      fileSwitcherSignature = signature;
    }
    const index = selectedJobIndex();
    fileSelect.value = selectedJobId || '';
    filePosition.textContent = `${Math.max(0, index) + 1} из ${state.jobs.length}`;
    previousFileButton.disabled = index <= 0;
    nextFileButton.disabled = index < 0 || index >= state.jobs.length - 1;
    fileSwitcherSyncPending = false;
  }

  function selectJob(jobId, announce = true) {
    const nextJob = state.jobs.find((job) => job.id === String(jobId));
    if (!nextJob) return;
    if (selectedJobId !== nextJob.id) {
      pausePreview(activePreview);
      selectedJobId = nextJob.id;
    }
    updateSelectedJobView();
    syncFileSwitcher(true);
    if (announce) setLiveMessage(`Выбран файл: ${nextJob.name}.`);
  }

  function setLiveMessage(message) {
    const value = String(message || '');
    if (!value || value === lastAnnouncement) return;
    liveRegion.textContent = value;
    lastAnnouncement = value;
  }

  function setConnection(mode, message) {
    connectionState.classList.remove('is-online', 'is-offline', 'is-loading');
    if (mode === 'online') {
      connectionState.classList.add('is-online');
      connectionState.lastChild.textContent = 'Готово к работе';
    } else if (mode === 'offline') {
      connectionState.classList.add('is-offline');
      connectionState.lastChild.textContent = 'Нет связи';
    } else {
      connectionState.classList.add('is-loading');
      connectionState.lastChild.textContent = message || 'Проверяем связь…';
    }
  }

  function setView() {
    if (shutdownRequested) {
      app.dataset.view = 'shutdown';
    } else if (initialLoading) {
      app.dataset.view = 'loading';
    } else if (offline) {
      app.dataset.view = 'offline';
    } else if (isSubmitting()) {
      app.dataset.view = 'uploading';
    } else if (!state.jobs.length) {
      app.dataset.view = 'empty';
    } else {
      app.dataset.view = 'queue';
    }
  }

  function updateControls() {
    const canUpload = !shutdownRequested && !isSubmitting();
    chooseButton.disabled = !canUpload;
    fileInput.disabled = !canUpload;
    dropZone.setAttribute('aria-disabled', canUpload ? 'false' : 'true');
    shutdownButton.disabled = shutdownRequested || isSubmitting() || saveAllPending || hasWorkingState();
    retryButton.hidden = !offline || shutdownRequested;
    offlineRetryButton.disabled = pollInFlight || shutdownRequested;
    updateSaveAllState();
  }

  function safeDownloadUrl(value) {
    if (!value) return '';
    try {
      const parsed = new URL(value, window.location.href);
      if (parsed.origin !== window.location.origin) return '';
      return parsed.href;
    } catch (_error) {
      return '';
    }
  }

  function safePreviewUrl(value) {
    const href = safeDownloadUrl(value);
    if (!href) return '';
    try {
      const parsed = new URL(href);
      return parsed.pathname.startsWith('/api/preview/') ? href : '';
    } catch (_error) {
      return '';
    }
  }

  function formatPreviewTime(value) {
    const seconds = Number(value);
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
    const whole = Math.floor(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
  }

  function fileExtension(name) {
    const cleanName = String(name || '').split(/[\\/]/).pop() || '';
    const match = cleanName.match(/\.([a-z0-9]{1,8})$/i);
    return match ? match[1].toUpperCase() : 'FILE';
  }

  function statusMessage(job) {
    if (job.status === 'error') return 'Не удалось обработать файл';
    if (job.message) return job.message;
    if (job.status === 'queued') return 'Ожидает обработки';
    if (job.status === 'decoding') return 'Подготавливаем дорожки';
    if (job.status === 'separating') return 'Разделяем звук на источники';
    if (job.status === 'encoding') return 'Сохраняем результаты';
    if (job.status === 'done') return 'Все дорожки готовы';
    if (job.status === 'cancelled') return 'Обработка отменена';
    return '';
  }

  function errorDetail(job) {
    const detail = String(job.message || '').trim();
    return detail || 'Подробности ошибки недоступны.';
  }

  function normalizedOutputLabel(label, filename) {
    const source = String(label || '').trim();
    if (!source) return filename ? fileExtension(filename) : 'Файл';
    const key = source.toLowerCase().replace(/[\s_-]+/g, '');
    if (OUTPUT_LABELS[key]) return OUTPUT_LABELS[key];
    return source;
  }

  function outputSortValue(output) {
    const label = normalizedOutputLabel(output.label, output.filename);
    const index = OUTPUT_ORDER.indexOf(label);
    return index === -1 ? OUTPUT_ORDER.length : index;
  }

  function updatePreviewUi(controller) {
    const { audio, toggle, seek, current, duration } = controller;
    const hasDuration = Number.isFinite(audio.duration) && audio.duration > 0;
    const currentTime = Number.isFinite(audio.currentTime) ? audio.currentTime : 0;
    seek.disabled = !hasDuration || Boolean(controller.failed);
    if (hasDuration) {
      seek.max = String(audio.duration);
      seek.value = String(Math.min(audio.duration, currentTime));
    } else {
      seek.max = '1';
      seek.value = '0';
    }
    current.textContent = formatPreviewTime(currentTime);
    duration.textContent = formatPreviewTime(audio.duration);
    toggle.disabled = Boolean(controller.failed);
    toggle.textContent = audio.paused ? '▶' : 'Ⅱ';
    toggle.dataset.playing = audio.paused ? 'false' : 'true';
    toggle.setAttribute('aria-label', `${audio.paused ? 'Прослушать' : 'Поставить на паузу'} дорожку «${controller.label}»`);
  }

  function showPreviewError(controller, message = 'Предпрослушивание недоступно.') {
    controller.failed = true;
    controller.error.hidden = false;
    controller.error.textContent = message;
    updatePreviewUi(controller);
  }

  function pausePreview(controller) {
    if (!controller) return;
    controller.playAttempt += 1;
    controller.pendingPlayAttempt = 0;
    controller.audio.pause();
    updatePreviewUi(controller);
    if (activePreview === controller) activePreview = null;
  }

  function createPreviewControls(previewUrl, outputLabel, filename) {
    const controls = createElement('div', 'preview-controls');
    const toggle = createElement('button', 'preview-toggle', '▶');
    toggle.type = 'button';
    toggle.dataset.playing = 'false';
    const seek = document.createElement('input');
    seek.type = 'range';
    seek.min = '0';
    seek.max = '1';
    seek.step = '0.01';
    seek.value = '0';
    seek.className = 'preview-seek';
    seek.setAttribute('aria-label', `Позиция дорожки «${outputLabel}»`);
    const current = createElement('span', 'preview-time', '0:00');
    const separator = createElement('span', 'preview-time-separator', '/');
    const duration = createElement('span', 'preview-time', '0:00');
    const error = createElement('span', 'preview-error', 'Предпрослушивание недоступно.');
    error.hidden = true;
    const audio = document.createElement('audio');
    audio.className = 'preview-audio';
    audio.preload = 'metadata';
    audio.src = previewUrl;
    audio.setAttribute('aria-hidden', 'true');
    audio.tabIndex = -1;
    const controller = { audio, toggle, seek, current, duration, error, label: outputLabel, failed: false, playAttempt: 0, pendingPlayAttempt: 0 };

    const beginPlayback = () => {
      if (controller.failed) return;
      if (activePreview && activePreview !== controller) pausePreview(activePreview);
      activePreview = controller;
      const attempt = ++controller.playAttempt;
      controller.pendingPlayAttempt = attempt;
      const playResult = audio.play();
      if (playResult && typeof playResult.catch === 'function') {
        playResult.catch((error) => {
          if (attempt !== controller.playAttempt || error?.name === 'AbortError' || audio.paused) return;
          showPreviewError(controller, 'Не удалось воспроизвести эту дорожку.');
        });
      }
    };
    toggle.addEventListener('click', () => {
      if (audio.paused) beginPlayback();
      else pausePreview(controller);
    });
    seek.addEventListener('input', () => {
      if (Number.isFinite(audio.duration) && audio.duration > 0) audio.currentTime = Number(seek.value);
      updatePreviewUi(controller);
    });
    audio.addEventListener('play', () => {
      if (controller.pendingPlayAttempt !== controller.playAttempt) {
        audio.pause();
        updatePreviewUi(controller);
        return;
      }
      if (activePreview && activePreview !== controller) pausePreview(activePreview);
      activePreview = controller;
      updatePreviewUi(controller);
    });
    audio.addEventListener('pause', () => updatePreviewUi(controller));
    audio.addEventListener('ended', () => {
      if (activePreview === controller) activePreview = null;
      updatePreviewUi(controller);
    });
    audio.addEventListener('loadedmetadata', () => updatePreviewUi(controller));
    audio.addEventListener('durationchange', () => updatePreviewUi(controller));
    audio.addEventListener('timeupdate', () => updatePreviewUi(controller));
    audio.addEventListener('error', () => showPreviewError(controller));
    toggle.setAttribute('aria-label', `Прослушать дорожку «${outputLabel}»`);
    controls.append(toggle, seek, current, separator, duration, error, audio);
    updatePreviewUi(controller);
    return controls;
  }

  function buildOutputRow(output) {
    const row = createElement('div', 'output-row');
    const outputLabel = normalizedOutputLabel(output.label, output.filename);
    row.dataset.stem = outputLabel;
    const track = createElement('span', 'output-track');
    track.setAttribute('aria-hidden', 'true');
    const label = createElement('span', 'output-label', outputLabel);
    const filename = createElement('span', 'output-filename', output.filename || 'Файл готов');
    row.append(track, label, filename);

    const previewHref = safePreviewUrl(output.previewUrl);
    if (previewHref) {
      row.append(createPreviewControls(previewHref, outputLabel, output.filename));
    } else {
      row.append(createElement('span', 'preview-unavailable', 'Предпрослушивание недоступно'));
    }

    const href = safeDownloadUrl(output.url);
    if (href) {
      const link = createElement('a', '', desktopBridge ? 'Сохранить' : 'Скачать');
      link.href = href;
      link.setAttribute('download', output.filename || 'mrx-output');
      link.setAttribute('aria-label', `Скачать ${output.filename || normalizedOutputLabel(output.label, output.filename)}`);
      row.append(link);
    } else {
      const unavailable = createElement('span', 'output-filename', 'Ссылка появится после сохранения');
      row.append(unavailable);
    }
    return row;
  }

  function buildJobCard(job) {
    const item = createElement('li', 'job-card');
    item.dataset.status = job.status;
    item.dataset.jobId = job.id;

    const main = createElement('div', 'job-main');
    const glyph = createElement('span', 'file-glyph', fileExtension(job.name));
    glyph.setAttribute('aria-hidden', 'true');

    const heading = createElement('div', 'job-heading');
    heading.append(createElement('strong', 'job-name', job.name));
    if (job.status !== 'done') heading.append(createElement('span', 'job-message', statusMessage(job)));

    const status = createElement('span', 'status-pill', STATUS_LABELS[job.status]);
    status.dataset.status = job.status;
    status.setAttribute('aria-label', `Статус: ${STATUS_LABELS[job.status]}`);
    main.append(glyph, heading, status);
    item.append(main);

    if (ACTIVE_STATUSES.has(job.status)) {
      const progressWrap = createElement('div', 'job-progress');
      const progress = document.createElement('progress');
      progress.max = 100;
      progress.value = job.progress;
      progress.setAttribute('aria-label', `Прогресс обработки файла ${job.name}`);
      progressWrap.append(progress, createElement('span', 'job-progress-value tabular', `${progress.value}%`));
      item.append(progressWrap);
    }

    if (job.status === 'queued' || ACTIVE_STATUSES.has(job.status)) {
      const actions = createElement('div', 'job-actions');
      const cancel = createElement('button', 'button button-quiet job-action', cancelling.has(job.id) ? 'Отменяем…' : 'Отменить');
      cancel.type = 'button';
      cancel.dataset.cancelId = job.id;
      cancel.disabled = cancelling.has(job.id);
      cancel.setAttribute('aria-label', `Отменить обработку файла ${job.name}`);
      actions.append(cancel);
      item.append(actions);
    }

    if (job.status === 'done' && job.outputs.length) {
      const outputWrap = createElement('div', 'job-output-wrap');
      outputWrap.append(createElement('div', 'output-heading', 'Готовые дорожки'));
      const list = createElement('div', 'output-list');
      job.outputs.slice().sort((a, b) => outputSortValue(a) - outputSortValue(b)).forEach((output) => list.append(buildOutputRow(output)));
      outputWrap.append(list);
      const zipHref = safeDownloadUrl(job.zipUrl);
      if (zipHref) {
        const zipRow = createElement('div', 'zip-row');
        zipRow.append(createElement('span', '', 'Все дорожки одним архивом:'), (() => {
          const link = createElement('a', '', desktopBridge ? 'Сохранить ZIP' : 'Скачать ZIP');
          link.href = zipHref;
          link.setAttribute('download', `${job.name.replace(/\.[^/.]+$/, '') || 'mrx-output'}.zip`);
          return link;
        })());
        outputWrap.append(zipRow);
      }
      if (desktopBridge) {
        const folderRow = createElement('div', 'output-folder-row');
        const folderButton = createElement('button', 'button button-quiet job-action output-folder-button', 'Открыть папку');
        folderButton.type = 'button';
        folderButton.dataset.openFolderId = job.id;
        folderButton.setAttribute('aria-label', `Открыть папку результатов файла ${job.name}`);
        folderRow.append(folderButton);
        outputWrap.append(folderRow);
      }
      item.append(outputWrap);
    }

    if (job.status === 'error') {
      const error = createElement('p', 'job-error', errorDetail(job));
      item.append(error);
    }

    return item;
  }

  function jobRenderKey(job) {
    return JSON.stringify({
      status: job.status,
      name: job.name,
      outputs: job.outputs.map((output) => ({
        label: output.label,
        filename: output.filename,
        url: output.url,
        previewUrl: output.previewUrl
      })),
      zipUrl: job.zipUrl
    });
  }

  function updateJobNode(node, job) {
    node.dataset.status = job.status;
    const message = node.querySelector('.job-message');
    if (message) message.textContent = statusMessage(job);
    const errorDetailNode = node.querySelector('.job-error');
    if (errorDetailNode && job.status === 'error') errorDetailNode.textContent = errorDetail(job);
    const progress = node.querySelector('.job-progress progress');
    const progressValue = node.querySelector('.job-progress-value');
    if (progress) progress.value = job.progress;
    if (progressValue && progress) progressValue.textContent = `${progress.value}%`;
    const cancel = node.querySelector('[data-cancel-id]');
    if (cancel) {
      cancel.disabled = cancelling.has(job.id);
      cancel.textContent = cancelling.has(job.id) ? 'Отменяем…' : 'Отменить';
    }
  }

  function removeJobNode(jobId, node) {
    if (activePreview && node && node.contains(activePreview.audio)) pausePreview(activePreview);
    node?.remove();
    jobNodes.delete(jobId);
    jobRenderKeys.delete(jobId);
  }

  async function openJobFolder(id) {
    if (!desktopBridge || !id) return;
    try {
      await desktopBridge.openJobFolder(id);
      setLiveMessage('Папка результатов открыта.');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось открыть папку результатов.';
      showToast(message, 'error');
      setLiveMessage(message);
    }
  }

  function renderJobs() {
    const desiredNodes = [];
    const desiredIds = new Set();
    state.jobs.forEach((job) => {
      desiredIds.add(job.id);
      const key = jobRenderKey(job);
      let node = jobNodes.get(job.id);
      if (!node || jobRenderKeys.get(job.id) !== key) {
        const freshNode = buildJobCard(job);
        if (node) {
          if (activePreview && node.contains(activePreview.audio)) pausePreview(activePreview);
          node.replaceChildren(...Array.from(freshNode.childNodes));
          node.dataset.status = freshNode.dataset.status;
          node.dataset.jobId = freshNode.dataset.jobId;
        }
        node = node || freshNode;
        jobNodes.set(job.id, node);
        jobRenderKeys.set(job.id, key);
      } else {
        updateJobNode(node, job);
      }
      desiredNodes.push(node);
    });
    for (let index = 0; index < desiredNodes.length; index += 1) {
      const node = desiredNodes[index];
      if (queueList.children[index] !== node) queueList.insertBefore(node, queueList.children[index] || null);
    }
    Array.from(queueList.children).forEach((node) => {
      if (!desiredIds.has(node.dataset.jobId)) removeJobNode(node.dataset.jobId, node);
    });
    ensureSelectedJob();
    updateSelectedJobView();
    syncFileSwitcher();
    queueCount.textContent = countLabel(state.jobs.length);
    const showEmpty = !initialLoading && !offline && !isSubmitting() && state.jobs.length === 0 && !shutdownRequested;
    emptyQueue.hidden = !showEmpty;
    loadingCard.hidden = !initialLoading || shutdownRequested;
    offlineBanner.hidden = !offline || shutdownRequested;
    updateControls();
    setView();
  }

  function applyState(nextState, announce) {
    state = normalizeState(nextState);
    initialLoading = false;
    offline = false;
    setConnection('online');
    offlineMessage.textContent = 'Проверьте, запущено ли локальное приложение.';
    if (announce) setLiveMessage(announce);
    renderJobs();
    schedulePoll();
  }

  function showToast(message, tone) {
    window.clearTimeout(toastTimer);
    toast.textContent = String(message || '');
    toast.dataset.tone = tone || '';
    toast.hidden = !message;
    if (message) {
      toastTimer = window.setTimeout(() => {
        toast.hidden = true;
      }, 5200);
    }
  }

  function setOffline(message) {
    offline = true;
    initialLoading = false;
    setConnection('offline');
    offlineMessage.textContent = message || 'Проверьте, запущено ли локальное приложение.';
    renderJobs();
    setLiveMessage('Нет связи с локальным приложением.');
    schedulePoll();
  }

  async function readResponse(response) {
    const text = await response.text();
    let payload = {};
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch (_error) {
        payload = { error: text };
      }
    }
    if (!response.ok) {
      const message = payload && typeof payload.error === 'string' ? payload.error : `Сервер ответил с кодом ${response.status}.`;
      throw new Error(message);
    }
    return payload;
  }

  async function saveAll() {
    if (!saveAllButton || saveAllPending || saveAllButton.disabled) return;
    const snapshotReadyCount = readyJobCount();
    if (snapshotReadyCount < 1) return;
    saveAllPending = true;
    saveAllSnapshotReadyCount = snapshotReadyCount;
    saveAllSnapshotJobIds = new Set(state.jobs.map((job) => job.id));
    updateControls();
    const pendingMessage = `Готовим общий архив: ${countLabel(snapshotReadyCount)}.`;
    showToast(pendingMessage, 'success');
    setLiveMessage(pendingMessage);
    try {
      const response = await fetch('/api/exports', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const payload = await readResponse(response);
      const href = safeDownloadUrl(payload && payload.url);
      if (!href) throw new Error('Сервер не вернул ссылку на общий архив.');

      const anchor = document.createElement('a');
      anchor.href = href;
      anchor.download = payload && typeof payload.filename === 'string' && payload.filename ? payload.filename : 'MRX stems.zip';
      anchor.rel = 'noopener';
      anchor.style.display = 'none';
      document.body.append(anchor);
      anchor.click();
      anchor.remove();

      const reportedJobs = Number(payload && payload.jobCount);
      const reportedSkipped = Number(payload && payload.skippedCount);
      const exportedCount = Number.isFinite(reportedJobs) && reportedJobs > 0 ? Math.round(reportedJobs) : snapshotReadyCount;
      const skippedCount = Number.isFinite(reportedSkipped) && reportedSkipped >= 0 ? Math.round(reportedSkipped) : skippedJobCount();
      let message = `Общий архив готов: ${countLabel(exportedCount)}.`;
      if (skippedCount > 0) message += ` Пропущено: ${skippedCount}.`;
      if (state.jobs.some((job) => !saveAllSnapshotJobIds.has(job.id))) message += ' Новые файлы не вошли в этот архив.';
      showToast(message, 'success');
      setLiveMessage(message);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось подготовить общий архив.';
      showToast(message, 'error');
      setLiveMessage(message);
      if (/network|failed|fetch|связ/i.test(message)) setOffline('Не удалось подготовить архив: нет связи с приложением.');
    } finally {
      saveAllPending = false;
      saveAllSnapshotReadyCount = 0;
      saveAllSnapshotJobIds = new Set();
      updateControls();
    }
  }

  async function fetchState() {
    const response = await fetch('/api/state', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' }
    });
    return readResponse(response);
  }

  function schedulePoll() {
    if (shutdownRequested) return;
    window.clearTimeout(pollTimer);
    const delay = offline ? POLL_OFFLINE_MS : (hasWorkingState() ? POLL_BUSY_MS : POLL_ONLINE_MS);
    pollTimer = window.setTimeout(pollState, delay);
  }

  async function pollState() {
    if (shutdownRequested || pollInFlight) return;
    pollInFlight = true;
    updateControls();
    try {
      const payload = await fetchState();
      applyState(payload);
    } catch (error) {
      setOffline(error instanceof Error ? error.message : 'Не удалось получить состояние очереди.');
    } finally {
      pollInFlight = false;
      updateControls();
      if (!shutdownRequested && !pollTimer) schedulePoll();
    }
  }

  function resetUploadUi() {
    uploadXhr = null;
    dropZone.dataset.state = 'idle';
    uploadProgressWrap.hidden = true;
    uploadProgress.value = 0;
    uploadProgressValue.textContent = '0%';
    uploadProgressLabel.textContent = 'Загрузка файлов';
    renderJobs();
  }

  // In the desktop app every picked or dropped file has a path on disk, so it
  // is processed in place instead of being copied through an upload.
  function localFilePaths(files) {
    if (!desktopBridge || typeof desktopBridge.pathForFile !== 'function') return null;
    const paths = files.map((file) => desktopBridge.pathForFile(file));
    return paths.every((value) => typeof value === 'string' && value) ? paths : null;
  }

  async function submitLocalPaths(paths) {
    localSubmitPending = true;
    offline = false;
    setConnection('loading', 'Добавляем файлы…');
    dropZone.dataset.state = 'uploading';
    setLiveMessage(`Добавляем: ${countLabel(paths.length)}.`);
    updateControls();
    setView();
    try {
      const response = await fetch('/api/jobs/local', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths })
      });
      const payload = await readResponse(response);
      localSubmitPending = false;
      dropZone.dataset.state = 'idle';
      applyState(payload, addedLabel(paths.length));
      showToast(`${addedLabel(paths.length)} в очередь.`, 'success');
    } catch (error) {
      localSubmitPending = false;
      dropZone.dataset.state = 'idle';
      const message = error instanceof Error ? error.message : 'Не удалось добавить файлы.';
      showToast(message, 'error');
      setLiveMessage(message);
      if (/network|failed|fetch/i.test(message)) {
        setOffline('Не удалось добавить файлы: нет связи с приложением.');
      } else {
        setConnection('online');
        renderJobs();
      }
    }
  }

  function uploadFiles(fileList) {
    const files = Array.from(fileList || []).filter((file) => file && typeof file.name === 'string');
    if (!files.length) return;
    if (shutdownRequested) {
      showToast('Приложение уже закрывается.', 'error');
      return;
    }
    if (isSubmitting()) {
      showToast('Дождитесь окончания текущей загрузки.', 'error');
      return;
    }
    const localPaths = localFilePaths(files);
    if (localPaths) {
      submitLocalPaths(localPaths);
      return;
    }

    const formData = new FormData();
    files.forEach((file) => formData.append('files', file, file.name));
    const xhr = new XMLHttpRequest();
    uploadXhr = xhr;
    offline = false;
    setConnection('loading', 'Загружаем файлы…');
    dropZone.dataset.state = 'uploading';
    uploadProgressWrap.hidden = false;
    uploadProgressLabel.textContent = files.length === 1 ? 'Загрузка файла' : `Загрузка ${files.length} файлов`;
    uploadProgress.value = 0;
    uploadProgressValue.textContent = '0%';
    setLiveMessage(`Началась загрузка: ${countLabel(files.length)}.`);
    updateControls();
    setView();

    xhr.open('POST', '/api/jobs', true);
    xhr.withCredentials = true;
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable) return;
      const progress = clampProgress((event.loaded / event.total) * 100);
      uploadProgress.value = progress;
      uploadProgressValue.textContent = `${progress}%`;
    });
    xhr.addEventListener('load', () => {
      const responseText = xhr.responseText || '';
      let payload = {};
      try {
        payload = responseText ? JSON.parse(responseText) : {};
      } catch (_error) {
        payload = { error: responseText };
      }
      uploadXhr = null;
      if (xhr.status < 200 || xhr.status >= 300 || (payload && payload.error)) {
        const message = payload && typeof payload.error === 'string' ? payload.error : `Не удалось добавить файлы (код ${xhr.status}).`;
        resetUploadUi();
        setConnection(offline ? 'offline' : 'online');
        showToast(message, 'error');
        setLiveMessage(message);
        return;
      }
      uploadProgress.value = 100;
      uploadProgressValue.textContent = '100%';
      uploadProgressLabel.textContent = 'Файлы добавлены';
      try {
        applyState(payload, addedLabel(files.length));
        showToast(`${addedLabel(files.length)} в очередь.`, 'success');
      } catch (error) {
        resetUploadUi();
        showToast(error instanceof Error ? error.message : 'Состояние очереди не распознано.', 'error');
      }
      window.setTimeout(resetUploadUi, 420);
    });
    xhr.addEventListener('error', () => {
      uploadXhr = null;
      resetUploadUi();
      setOffline('Загрузка не завершилась. Проверьте локальное приложение и повторите попытку.');
      showToast('Не удалось отправить файлы.', 'error');
    });
    xhr.addEventListener('abort', () => {
      uploadXhr = null;
      resetUploadUi();
      showToast('Загрузка отменена.', 'error');
    });
    xhr.send(formData);
  }

  async function cancelJob(id) {
    if (cancelling.has(id)) return;
    cancelling.add(id);
    renderJobs();
    try {
      const response = await fetch(`/api/jobs/${encodeURIComponent(id)}/cancel`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const payload = await readResponse(response);
      if (payload && Array.isArray(payload.jobs)) {
        applyState(payload, 'Обработка отменена.');
      } else {
        await pollState();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось отменить обработку.';
      showToast(message, 'error');
      if (/network|failed|fetch|связ/i.test(message)) setOffline('Не удалось отменить файл: нет связи с приложением.');
    } finally {
      cancelling.delete(id);
      renderJobs();
    }
  }

  async function shutdown() {
    if (shutdownRequested || saveAllPending || shutdownButton.disabled) return;
    shutdownRequested = true;
    window.clearTimeout(pollTimer);
    pollTimer = null;
    setConnection('loading', 'Закрываем приложение…');
    setLiveMessage('Закрываем приложение.');
    updateControls();
    try {
      const response = await fetch('/api/shutdown', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' }
      });
      const payload = await readResponse(response);
      shutdownMessage.textContent = payload && (payload.message || payload.relaunch)
        ? String(payload.message || payload.relaunch)
        : (desktopBridge
          ? 'MRX завершает работу. Это окно закроется автоматически.'
          : 'Можно закрыть это окно. Чтобы запустить MRX снова, откройте файл запуска ещё раз.');
      shutdownOverlay.hidden = false;
      app.dataset.view = 'shutdown';
    } catch (error) {
      shutdownRequested = false;
      const message = error instanceof Error ? error.message : 'Не удалось закрыть приложение.';
      showToast(message, 'error');
      setConnection('online');
      renderJobs();
    }
  }

  chooseButton.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const files = fileInput.files;
    uploadFiles(files);
    fileInput.value = '';
  });
  dropZone.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    if (!isSubmitting() && !shutdownRequested) fileInput.click();
  });
  dropZone.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    if (!isSubmitting() && !shutdownRequested) fileInput.click();
  });
  dropZone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    if (!isSubmitting() && !shutdownRequested) dropZone.dataset.state = 'dragover';
  });
  dropZone.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
    if (!isSubmitting() && !shutdownRequested) dropZone.dataset.state = 'dragover';
  });
  dropZone.addEventListener('dragleave', () => {
    if (!isSubmitting()) dropZone.dataset.state = 'idle';
  });
  dropZone.addEventListener('drop', (event) => {
    event.preventDefault();
    dropZone.dataset.state = 'idle';
    if (isSubmitting() || shutdownRequested) {
      showToast('Дождитесь окончания текущего действия.', 'error');
      return;
    }
    uploadFiles(event.dataTransfer && event.dataTransfer.files);
  });
  queueList.addEventListener('click', (event) => {
    const folderButton = event.target.closest('[data-open-folder-id]');
    if (folderButton) {
      openJobFolder(folderButton.dataset.openFolderId);
      return;
    }
    const button = event.target.closest('[data-cancel-id]');
    if (button) cancelJob(button.dataset.cancelId);
  });
  previousFileButton.addEventListener('click', () => {
    const index = selectedJobIndex();
    if (index > 0) selectJob(state.jobs[index - 1].id);
  });
  nextFileButton.addEventListener('click', () => {
    const index = selectedJobIndex();
    if (index >= 0 && index < state.jobs.length - 1) selectJob(state.jobs[index + 1].id);
  });
  fileSelect.addEventListener('change', () => selectJob(fileSelect.value));
  fileSelect.addEventListener('blur', () => {
    if (fileSwitcherSyncPending) syncFileSwitcher(true);
  });
  saveAllButton.addEventListener('click', saveAll);
  retryButton.addEventListener('click', () => pollState());
  offlineRetryButton.addEventListener('click', () => pollState());
  shutdownButton.addEventListener('click', shutdown);
  // MRX talks only to its own loopback server, so the browser's network
  // "offline" event says nothing about it; polling detects a lost server.
  window.addEventListener('online', () => pollState());

  renderJobs();
  pollState();
})();
