// VidSave — frontend (HTML/CSS/JS puro, sem build).
//
// Cinco estados, guardados em #app[data-state]:
//   idle            à espera de um link
//   processing      a verificar o link (POST /api/resolve)
//   resolved        formatos disponíveis (e downloads em curso/concluídos)
//   resolve-error   a verificação falhou
//   download-error  um download falhou (a lista de formatos mantém-se)
(function () {
  'use strict';

  var cfg = window.VIDSAVE_CONFIG || {};

  var host = location.hostname;
  var isLocal =
    location.protocol === 'file:' ||
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '[::1]';

  // Em produção, API_BASE_URL tem de estar preenchido (frontend/config.js).
  // Só em desenvolvimento é que caímos para localhost.
  var API = String(cfg.API_BASE_URL || '').replace(/\/+$/, '');
  if (!API && isLocal) API = 'http://localhost:3000';

  // Acima disto, o download vai direto para o browser (sem passar pela
  // memória da página). Abaixo, passa pela página para termos progresso,
  // tratamento de erros e um nome de ficheiro com extensão.
  var BIG_FILE_BYTES = 200 * 1024 * 1024;
  // A Render (plano gratuito) adormece o backend e demora até ~1 min a acordar.
  var RESOLVE_TIMEOUT_MS = 70000;
  var SLOW_HINT_AFTER_MS = 6000;

  var app = document.getElementById('app');
  var form = document.getElementById('form');
  var urlInput = document.getElementById('url');
  var submitBtn = document.getElementById('submit');
  var statusEl = document.getElementById('status');
  var errorPanel = document.getElementById('errorPanel');
  var errorText = document.getElementById('errorText');
  var retryBtn = document.getElementById('retry');
  var resultPanel = document.getElementById('resultPanel');
  var mediaTitle = document.getElementById('mediaTitle');
  var mediaMeta = document.getElementById('mediaMeta');
  var formatsEl = document.getElementById('formats');
  var downloadErrorBox = document.getElementById('downloadError');
  var downloadErrorText = document.getElementById('downloadErrorText');
  var recheckBtn = document.getElementById('recheck');
  var bigFileNote = document.getElementById('bigFileNote');
  var healthEl = document.getElementById('health');
  var healthText = document.getElementById('healthText');
  var adSlot = document.getElementById('adSlot');

  var currentMedia = null;
  var lastUrl = '';
  var slowTimer = null;

  if (cfg.ADS_SLOT_VISIBLE) adSlot.hidden = false;

  // ------------------------------------------------------------------
  // Estado da interface
  // ------------------------------------------------------------------

  function setState(state) {
    app.setAttribute('data-state', state);

    var busy = state === 'processing';
    submitBtn.disabled = busy;
    submitBtn.textContent = busy ? 'A verificar…' : 'Verificar link';

    errorPanel.hidden = state !== 'resolve-error';
    resultPanel.hidden = !(state === 'resolved' || state === 'download-error');
    downloadErrorBox.hidden = state !== 'download-error';

    if (state !== 'processing') {
      clearTimeout(slowTimer);
      slowTimer = null;
    }
  }

  function setStatus(message) {
    statusEl.textContent = message || '';
  }

  function showResolveError(message, canRetry) {
    errorText.textContent = message;
    retryBtn.hidden = !canRetry;
    setStatus('');
    setState('resolve-error');
  }

  // ------------------------------------------------------------------
  // Formatação
  // ------------------------------------------------------------------

  function formatBytes(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
    var units = ['B', 'KB', 'MB', 'GB'];
    var value = bytes;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value /= 1024;
      i += 1;
    }
    var rounded = i === 0 ? String(Math.round(value)) : value.toFixed(1).replace('.', ',');
    return rounded + ' ' + units[i];
  }

  function formatDuration(seconds) {
    if (typeof seconds !== 'number' || !isFinite(seconds) || seconds <= 0) return '';
    var total = Math.round(seconds);
    var h = Math.floor(total / 3600);
    var m = Math.floor((total % 3600) / 60);
    var s = total % 60;
    var pad = function (n) { return n < 10 ? '0' + n : String(n); };
    return h > 0 ? h + ':' + pad(m) + ':' + pad(s) : m + ':' + pad(s);
  }

  // O nome sai só com ASCII: alguns browsers ignoram o atributo `download`
  // (e guardam o ficheiro como "download", sem extensão) quando o nome tem
  // acentos ou travessões. Por isso "Vídeo — Demo" vira "Video - Demo".
  function safeFilename(title, format) {
    var text = String(title || '');
    if (text.normalize) text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    var base = text
      .replace(/[\u2010-\u2015]/g, '-')
      .replace(/[^\x20-\x7e]/g, '')
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80)
      .trim() || 'vidsave';
    var ext = /^[a-z0-9]{1,6}$/i.test(String(format || '')) ? '.' + String(format).toLowerCase() : '';
    return base + ext;
  }

  // ------------------------------------------------------------------
  // Chamadas à API
  // ------------------------------------------------------------------

  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    var opts = Object.assign({}, options, { signal: controller.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  function readErrorMessage(response, fallback) {
    return response
      .json()
      .then(function (body) {
        return body && typeof body.error === 'string' ? body.error : fallback;
      })
      .catch(function () { return fallback; });
  }

  function messageForStatus(status) {
    if (status === 429) return 'Muitos pedidos seguidos. Espera um minuto e tenta outra vez.';
    if (status >= 500) return 'O servidor teve um problema. Tenta outra vez dentro de instantes.';
    return 'Não foi possível processar este link.';
  }

  // ------------------------------------------------------------------
  // Verificar link (POST /api/resolve)
  // ------------------------------------------------------------------

  function resolveLink(rawUrl) {
    var url = rawUrl.trim();
    if (!url) {
      urlInput.focus();
      showResolveError('Cola primeiro o link do vídeo.', false);
      return;
    }
    lastUrl = url;

    if (!API) {
      showResolveError(
        'O servidor ainda não está configurado neste site. Define API_BASE_URL em frontend/config.js.',
        false
      );
      return;
    }

    setState('processing');
    setStatus('A verificar o link…');
    slowTimer = setTimeout(function () {
      setStatus('O servidor estava a dormir e está a acordar. Pode demorar até um minuto.');
    }, SLOW_HINT_AFTER_MS);

    fetchWithTimeout(
      API + '/api/resolve',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url }),
      },
      RESOLVE_TIMEOUT_MS
    )
      .then(function (response) {
        if (!response.ok) {
          return readErrorMessage(response, messageForStatus(response.status)).then(function (message) {
            showResolveError(message, response.status >= 500 || response.status === 429);
          });
        }
        return response.json().then(function (body) {
          if (!body || !body.success || !body.data || !Array.isArray(body.data.formats)) {
            showResolveError('A resposta do servidor não é válida. Tenta outra vez.', true);
            return;
          }
          showResult(body.data);
        });
      })
      .catch(function (err) {
        if (err && err.name === 'AbortError') {
          showResolveError('O servidor demorou demasiado a responder. Tenta outra vez.', true);
        } else {
          // Inclui falhas de CORS: o browser não distingue "sem rede" de
          // "origem não permitida". Ver CORS_ORIGIN no backend.
          showResolveError(
            'Não foi possível ligar ao servidor. Verifica a ligação e tenta outra vez.',
            true
          );
        }
      });
  }

  // ------------------------------------------------------------------
  // Resultado
  // ------------------------------------------------------------------

  function showResult(media) {
    currentMedia = media;
    mediaTitle.textContent = String(media.title || 'Sem título');
    var duration = formatDuration(media.duration);
    mediaMeta.textContent = duration ? 'Duração: ' + duration : '';

    formatsEl.textContent = '';
    var hasBig = false;

    media.formats.forEach(function (format) {
      var li = document.createElement('li');

      var quality = document.createElement('span');
      quality.className = 'fmt-quality';
      quality.textContent = String(format.quality || 'Original');

      var detail = document.createElement('span');
      detail.className = 'fmt-detail';
      var parts = [String(format.format || '').toUpperCase(), formatBytes(format.sizeBytes)].filter(Boolean);
      detail.textContent = parts.join(', ');

      var button = document.createElement('button');
      button.type = 'button';
      button.className = 'dl';
      button.textContent = 'Descarregar';
      button.addEventListener('click', function () { startDownload(format, button); });

      if (format.sizeBytes > BIG_FILE_BYTES) hasBig = true;

      li.appendChild(quality);
      li.appendChild(detail);
      li.appendChild(button);
      formatsEl.appendChild(li);
    });

    bigFileNote.hidden = !hasBig;
    setStatus('Link verificado. Escolhe a qualidade.');
    setState('resolved');
  }

  // ------------------------------------------------------------------
  // Download (GET /api/download/:downloadId)
  // Cada downloadId só funciona uma vez; se falhar antes do fim, o
  // servidor liberta-o e dá para tentar outra vez.
  // ------------------------------------------------------------------

  function showDownloadError(message, expired) {
    downloadErrorText.textContent = message;
    recheckBtn.hidden = !expired;
    setState('download-error');
  }

  function resetButton(button) {
    button.disabled = false;
    button.removeAttribute('data-phase');
    button.style.removeProperty('--p');
    button.textContent = 'Tentar de novo';
  }

  function startDownload(format, button) {
    if (!API) return;
    var downloadUrl = API + '/api/download/' + encodeURIComponent(format.downloadId);

    // Ficheiros grandes: o browser faz o download diretamente.
    if (format.sizeBytes > BIG_FILE_BYTES) {
      var link = document.createElement('a');
      link.href = downloadUrl;
      link.rel = 'noopener';
      document.body.appendChild(link);
      link.click();
      link.remove();
      button.disabled = true;
      button.setAttribute('data-phase', 'done');
      button.textContent = 'Download iniciado';
      return;
    }

    button.disabled = true;
    button.setAttribute('data-phase', 'working');
    button.style.setProperty('--p', '0');
    button.textContent = 'A preparar…';
    setState('resolved');
    setStatus('');

    fetch(downloadUrl)
      .then(function (response) {
        if (!response.ok) {
          return readErrorMessage(response, messageForStatus(response.status)).then(function (message) {
            var expired = response.status === 404 || response.status === 410;
            resetButton(button);
            if (expired) {
              button.disabled = true;
              button.textContent = 'Expirado';
            }
            showDownloadError(
              expired ? 'Este download já foi usado ou expirou. Verifica o link outra vez.' : message,
              expired
            );
          });
        }

        var total = Number(response.headers.get('Content-Length')) || format.sizeBytes || 0;
        var contentType = response.headers.get('Content-Type') || 'application/octet-stream';
        var chunks = [];
        var received = 0;

        function finish() {
          var blob = new Blob(chunks, { type: contentType });
          var objectUrl = URL.createObjectURL(blob);
          var a = document.createElement('a');
          a.href = objectUrl;
          a.download = safeFilename(currentMedia && currentMedia.title, format.format);
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTimeout(function () { URL.revokeObjectURL(objectUrl); }, 60000);
          button.setAttribute('data-phase', 'done');
          button.textContent = 'Concluído';
          setState('resolved');
          setStatus('Download concluído.');
        }

        if (!response.body || !response.body.getReader) {
          return response.blob().then(function (blob) {
            chunks.push(blob);
            finish();
          });
        }

        var reader = response.body.getReader();
        function pump() {
          return reader.read().then(function (result) {
            if (result.done) {
              finish();
              return null;
            }
            chunks.push(result.value);
            received += result.value.length;
            var pct = total > 0 ? Math.min(99, Math.round((received / total) * 100)) : 0;
            button.style.setProperty('--p', String(pct));
            button.textContent = total > 0 ? pct + '%' : formatBytes(received);
            return pump();
          });
        }
        return pump();
      })
      .catch(function () {
        resetButton(button);
        showDownloadError('O download foi interrompido. Tenta outra vez.', false);
      });
  }

  // ------------------------------------------------------------------
  // Estado do servidor (rodapé). Tolera o arranque lento do plano
  // gratuito: tenta de novo durante ~90 s antes de dar o servidor como
  // inacessível.
  // ------------------------------------------------------------------

  function setHealth(kind, text) {
    healthEl.setAttribute('data-health', kind);
    healthText.textContent = text;
  }

  function checkHealth(attempt) {
    if (!API) {
      setHealth('down', 'Servidor por configurar');
      return;
    }
    fetchWithTimeout(API + '/api/health', {}, 8000)
      .then(function (response) {
        if (!response.ok) throw new Error('health not ok');
        setHealth('ok', 'Servidor ligado');
      })
      .catch(function () {
        if (attempt >= 15) {
          setHealth('down', 'Servidor inacessível. Tenta mais tarde.');
          return;
        }
        setHealth('waking', 'A ligar ao servidor…');
        setTimeout(function () { checkHealth(attempt + 1); }, 6000);
      });
  }

  // ------------------------------------------------------------------
  // Eventos
  // ------------------------------------------------------------------

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    resolveLink(urlInput.value);
  });

  retryBtn.addEventListener('click', function () {
    resolveLink(lastUrl || urlInput.value);
  });

  recheckBtn.addEventListener('click', function () {
    resolveLink(lastUrl || urlInput.value);
  });

  urlInput.addEventListener('input', function () {
    var state = app.getAttribute('data-state');
    if (state === 'resolve-error') {
      setState('idle');
      setStatus('');
    }
  });

  setState('idle');
  checkHealth(0);
})();
