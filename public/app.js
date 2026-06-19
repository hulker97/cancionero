// public/app.js
// Lógica del juego "Cancionero": cargar playlists, elegir canciones al azar,
// buscar el vídeo en YouTube, saltar a un fragmento y gestionar las preguntas.

(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Estado global del juego
  // ------------------------------------------------------------------
  const state = {
    allTracks: [],      // todas las canciones de la playlist elegida
    roundNumber: 0,      // ronda actual (sube indefinidamente, no hay límite)
    currentTrack: null,  // canción de la ronda actual
    lastTrackId: null,   // para evitar que salga la misma canción dos veces seguidas
    score: 0,
    streak: 0,
    bestStreak: 0,
    currentOptions: [],
    currentCorrectId: null,
    ytPlayerReady: false,
    ytPlayer: null,
    fragmentStartSeconds: 0,
    fragmentTimer: null,
    answered: false,
  };

  // ------------------------------------------------------------------
  // Utilidades de navegación entre pantallas
  // ------------------------------------------------------------------
  function showScreen(id) {
    document.querySelectorAll('.screen').forEach((el) => el.classList.remove('screen--active'));
    document.getElementById(id).classList.add('screen--active');
  }

  function shuffle(array) {
    const arr = array.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function pickRandom(array, n) {
    return shuffle(array).slice(0, n);
  }

  // ------------------------------------------------------------------
  // Arranque: comprobar si ya hay sesión iniciada
  // ------------------------------------------------------------------
  async function init() {
    const params = new URLSearchParams(window.location.search);
    const error = params.get('error');
    if (error) {
      const errEl = document.getElementById('login-error');
      errEl.hidden = false;
      errEl.textContent = 'No se ha podido conectar con Spotify. Inténtalo de nuevo.';
    }

    try {
      const res = await fetch('/api/auth-status');
      const data = await res.json();
      if (data.loggedIn) {
        await loadPlaylists();
      } else {
        showScreen('screen-login');
      }
    } catch (e) {
      showScreen('screen-login');
    }
  }

  // ------------------------------------------------------------------
  // Cargar playlists del usuario
  // ------------------------------------------------------------------
  async function loadPlaylists() {
    showScreen('screen-playlists');
    const loadingEl = document.getElementById('playlists-loading');
    const gridEl = document.getElementById('playlists-grid');
    loadingEl.hidden = false;
    gridEl.hidden = true;

    try {
      const res = await fetch('/api/playlists');
      if (res.status === 401) {
        showScreen('screen-login');
        return;
      }
      const data = await res.json();
      const all = [...data.special, ...data.playlists];

      gridEl.innerHTML = '';
      all.forEach((p) => {
        const card = document.createElement('button');
        card.className = 'playlist-card';
        card.innerHTML = `
          ${p.image
            ? `<img src="${p.image}" alt="">`
            : `<div class="playlist-card__placeholder">♪</div>`}
          <span class="playlist-card__name">${escapeHtml(p.name)}</span>
          <span class="playlist-card__count">${p.trackCount ? p.trackCount + ' canciones' : ''}</span>
        `;
        card.addEventListener('click', () => startGameWithPlaylist(p.id));
        gridEl.appendChild(card);
      });

      loadingEl.hidden = true;
      gridEl.hidden = false;
    } catch (e) {
      loadingEl.textContent = 'No se han podido cargar tus listas. Intenta recargar la página.';
    }
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ------------------------------------------------------------------
  // Caché ligera en localStorage: evita volver a pedir las mismas
  // canciones o las mismas búsquedas de YouTube. Persiste aunque cierres
  // la app del todo (a diferencia de sessionStorage), hasta que limpies
  // datos del navegador o expire por tiempo (solo aplica a playlists).
  // ------------------------------------------------------------------
  const CACHE_PREFIX = 'cancionero_cache_';
  const TRACKS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutos

  function getCache(key) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + key);
      if (!raw) return null;
      const { value, expiresAt } = JSON.parse(raw);
      if (expiresAt && Date.now() > expiresAt) {
        localStorage.removeItem(CACHE_PREFIX + key);
        return null;
      }
      return value;
    } catch (e) {
      return null;
    }
  }

  function setCache(key, value, ttlMs) {
    try {
      const entry = { value, expiresAt: ttlMs ? Date.now() + ttlMs : null };
      localStorage.setItem(CACHE_PREFIX + key, JSON.stringify(entry));
    } catch (e) {
      // Si localStorage está lleno o no disponible, simplemente no cacheamos.
    }
  }

  // ------------------------------------------------------------------
  // Empezar partida con una playlist concreta
  // ------------------------------------------------------------------
  async function startGameWithPlaylist(playlistId) {
    showScreen('screen-loading-game');

    const cacheKey = `tracks_${playlistId}`;
    const cached = getCache(cacheKey);

    let tracks;
    if (cached) {
      tracks = cached;
    } else {
      document.getElementById('loading-game-text').textContent = 'Cargando canciones de tu lista…';
      try {
        const res = await fetch(`/api/tracks/${encodeURIComponent(playlistId)}`);
        const data = await res.json();
        tracks = data.tracks;
        if (tracks && tracks.length >= 4) {
          setCache(cacheKey, tracks, TRACKS_CACHE_TTL_MS);
        }
      } catch (e) {
        alert('Ha ocurrido un error cargando las canciones. Vuelve a intentarlo.');
        await loadPlaylists();
        return;
      }
    }

    if (!tracks || tracks.length < 4) {
      alert('Esta lista necesita al menos 4 canciones distintas para poder jugar. Elige otra.');
      await loadPlaylists();
      return;
    }

    state.allTracks = tracks;
    state.roundNumber = 0;
    state.lastTrackId = null;
    state.score = 0;
    state.streak = 0;
    state.bestStreak = 0;

    playRound();
  }

  // ------------------------------------------------------------------
  // Reproductor de YouTube (API oficial embebida)
  // ------------------------------------------------------------------
  window.onYouTubeIframeAPIReady = function () {
    state.ytPlayer = new YT.Player('yt-player', {
      height: '1',
      width: '1',
      playerVars: { autoplay: 0, controls: 0, playsinline: 1 },
      events: {
        onReady: (event) => {
          state.ytPlayerReady = true;
          // Forzamos volumen al máximo y desmuteado por si el navegador
          // lo inicializa silenciado por defecto.
          event.target.setVolume(100);
          event.target.unMute();
        },
        onError: (event) => {
          console.warn('Error del reproductor de YouTube, código:', event.data);
        },
      },
    });
  };

  // ------------------------------------------------------------------
  // Jugar una ronda
  // ------------------------------------------------------------------
  async function playRound() {
    showScreen('screen-loading-game');
    document.getElementById('loading-game-text').textContent = 'Buscando la canción…';

    // Elegimos una canción al azar de toda la librería, evitando repetir
    // la misma que justo en la ronda anterior (si hay más de una canción disponible).
    let candidates = state.allTracks;
    if (state.lastTrackId && state.allTracks.length > 1) {
      candidates = state.allTracks.filter((t) => t.id !== state.lastTrackId);
    }
    const correctTrack = candidates[Math.floor(Math.random() * candidates.length)];
    state.lastTrackId = correctTrack.id;
    state.roundNumber += 1;

    // Generamos 4 opciones: la correcta + 3 distractores al azar del resto de la librería
    const distractorsPool = state.allTracks.filter((t) => t.id !== correctTrack.id);
    const distractors = pickRandom(distractorsPool, 3);
    const options = shuffle([correctTrack, ...distractors]);

    state.currentOptions = options;
    state.currentCorrectId = correctTrack.id;
    state.currentTrack = correctTrack;
    state.answered = false;

    // Buscamos el vídeo de YouTube correspondiente (con caché en el navegador,
    // para no repetir la búsqueda si esta canción ya salió antes en la sesión)
    const ytCacheKey = `yt_${correctTrack.artist}_${correctTrack.name}`.toLowerCase();
    const cachedYt = getCache(ytCacheKey);

    if (cachedYt) {
      correctTrack._videoId = cachedYt.videoId;
    } else {
      try {
        const res = await fetch(
          `/api/youtube-search?song=${encodeURIComponent(correctTrack.name)}&artist=${encodeURIComponent(correctTrack.artist)}`
        );
        if (!res.ok) throw new Error('No encontrado');
        const ytData = await res.json();
        correctTrack._videoId = ytData.videoId;
        setCache(ytCacheKey, ytData, null); // sin expiración: el vídeo de una canción no cambia
      } catch (e) {
        // Si no se encuentra el vídeo, saltamos esta ronda y vamos a la siguiente
        console.warn('No se encontró vídeo para', correctTrack.name, '- saltando ronda');
        playRound();
        return;
      }
    }

    renderRound(correctTrack, options);
    showScreen('screen-game');
  }

  function renderRound(correctTrack, options) {
    document.getElementById('round-current').textContent = state.roundNumber;
    document.getElementById('streak-count').textContent = state.streak;

    const optionsGrid = document.getElementById('options-grid');
    optionsGrid.innerHTML = '';
    options.forEach((opt) => {
      const btn = document.createElement('button');
      btn.className = 'option-btn';
      btn.innerHTML = `
        <span class="option-btn__song">${escapeHtml(opt.name)}</span>
        <span class="option-btn__artist">${escapeHtml(opt.artist)}</span>
      `;
      btn.addEventListener('click', () => handleAnswer(opt.id, btn));
      optionsGrid.appendChild(btn);
    });

    document.getElementById('feedback').hidden = true;
    document.getElementById('hint-text').hidden = true;
    document.getElementById('vinyl').classList.remove('vinyl--spinning');

    const playBtn = document.getElementById('btn-play-fragment');
    playBtn.disabled = false;
    document.getElementById('play-label').textContent = 'Reproducir fragmento';
    document.getElementById('play-icon').textContent = '▶';

    // Calculamos en qué segundo empezar: entre el 35% y el 55% de la duración,
    // que suele caer cerca de estribillo/parte reconocible sin ser el principio.
    const durationSeconds = (correctTrack.durationMs || 180000) / 1000;
    const startPercent = 0.35 + Math.random() * 0.2;
    state.fragmentStartSeconds = Math.floor(durationSeconds * startPercent);

    playBtn.onclick = () => playFragment(correctTrack._videoId);
  }

  // Cuánto dura el fragmento que se escucha, y cuánto tiempo de margen se da
  // antes de empezar a contar, para compensar el delay de carga de YouTube.
  const FRAGMENT_DURATION_MS = 14000; // 14 segundos de fragmento
  const LOAD_DELAY_MS = 1500; // margen antes de empezar a contar

  function playFragment(videoId) {
    if (!state.ytPlayerReady) {
      alert('El reproductor todavía se está cargando, espera un segundo e inténtalo de nuevo.');
      return;
    }

    const playBtn = document.getElementById('btn-play-fragment');
    playBtn.disabled = true;
    document.getElementById('play-label').textContent = 'Sonando…';
    document.getElementById('vinyl').classList.add('vinyl--spinning');

    // Forzamos sonido justo en el clic del usuario: es el momento que los
    // navegadores de escritorio consideran "interacción válida" para permitir audio.
    state.ytPlayer.unMute();
    state.ytPlayer.setVolume(100);

    // Sobrescribimos lo que Android/Chrome muestra en la notificación de
    // "reproduciendo audio" con un título genérico, para que no se vea el
    // nombre real de la canción (si no, sería trampa al jugar).
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: 'Cancionero',
        artist: '¿Qué canción es?',
        album: '🎵 Ronda en curso',
      });
      navigator.mediaSession.playbackState = 'playing';
      // Desactivamos los botones de "siguiente/anterior" de la notificación,
      // que no tienen sentido aquí y podrían confundir.
      try {
        navigator.mediaSession.setActionHandler('previoustrack', null);
        navigator.mediaSession.setActionHandler('nexttrack', null);
      } catch (e) {
        // Algunos navegadores no soportan desactivar estas acciones; no pasa nada.
      }
    }

    state.ytPlayer.loadVideoById({
      videoId,
      startSeconds: state.fragmentStartSeconds,
    });

    // Algunos navegadores necesitan un playVideo() explícito tras loadVideoById
    // para no quedarse pausados en el primer frame. Aprovechamos este mismo
    // margen (LOAD_DELAY_MS) como "tiempo de carga" antes de empezar a contar
    // los segundos de fragmento, así el usuario siempre oye los 14s completos.
    setTimeout(() => {
      if (state.ytPlayer && state.ytPlayer.playVideo) {
        state.ytPlayer.unMute();
        state.ytPlayer.playVideo();
        // Reforzamos el título genérico otra vez aquí, porque algunos
        // navegadores reaplican los metadatos del iframe al empezar a sonar.
        if ('mediaSession' in navigator) {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Cancionero',
            artist: '¿Qué canción es?',
            album: '🎵 Ronda en curso',
          });
        }
      }
    }, 250);

    clearTimeout(state.fragmentTimer);
    state.fragmentTimer = setTimeout(() => {
      state.ytPlayer.pauseVideo();
      document.getElementById('vinyl').classList.remove('vinyl--spinning');
      playBtn.disabled = false;
      document.getElementById('play-label').textContent = 'Reproducir otra vez';
      if ('mediaSession' in navigator) {
        navigator.mediaSession.playbackState = 'paused';
      }
    }, LOAD_DELAY_MS + FRAGMENT_DURATION_MS);
  }

  // ------------------------------------------------------------------
  // Gestionar respuesta del usuario
  // ------------------------------------------------------------------
  function handleAnswer(chosenId, btnEl) {
    if (state.answered) return;
    state.answered = true;

    clearTimeout(state.fragmentTimer);
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
    document.getElementById('vinyl').classList.remove('vinyl--spinning');

    const isCorrect = chosenId === state.currentCorrectId;
    const allButtons = document.querySelectorAll('.option-btn');
    allButtons.forEach((b) => (b.disabled = true));

    if (isCorrect) {
      btnEl.classList.add('option-btn--correct');
      state.score += 1;
      state.streak += 1;
      state.bestStreak = Math.max(state.bestStreak, state.streak);
    } else {
      btnEl.classList.add('option-btn--wrong');
      state.streak = 0;
      // Resaltamos también cuál era la correcta
      allButtons.forEach((b) => {
        if (b.querySelector('.option-btn__song').textContent ===
            state.currentOptions.find(o => o.id === state.currentCorrectId).name) {
          b.classList.add('option-btn--correct');
        }
      });
    }

    document.getElementById('streak-count').textContent = state.streak;

    const feedback = document.getElementById('feedback');
    document.getElementById('feedback-text').textContent = isCorrect
      ? '¡Acertaste! 🎉'
      : 'Fallaste, ¡a por la siguiente!';
    feedback.hidden = false;

    document.getElementById('btn-next-round').onclick = () => advanceRound();
  }

  function advanceRound() {
    playRound();
  }

  // ------------------------------------------------------------------
  // Pantalla de resumen (se muestra al pulsar "Salir" durante una partida)
  // ------------------------------------------------------------------
  function showResults() {
    document.getElementById('results-score').textContent =
      `${state.score} aciertos en ${state.roundNumber} rondas`;
    document.getElementById('results-best-streak').textContent =
      state.bestStreak > 1 ? `Mejor racha: ${state.bestStreak} 🔥` : '';
    showScreen('screen-results');
  }

  function stopPlaybackAndClearMediaSession() {
    clearTimeout(state.fragmentTimer);
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
    document.getElementById('vinyl').classList.remove('vinyl--spinning');
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = 'none';
    }
  }

  // ------------------------------------------------------------------
  // Listeners de botones generales
  // ------------------------------------------------------------------
  document.getElementById('btn-logout').addEventListener('click', () => {
    window.location.href = '/logout';
  });

  document.getElementById('btn-quit-game').addEventListener('click', () => {
    stopPlaybackAndClearMediaSession();
    showResults();
  });

  document.getElementById('btn-play-again').addEventListener('click', () => {
    state.roundNumber = 0;
    state.lastTrackId = null;
    state.score = 0;
    state.streak = 0;
    state.bestStreak = 0;
    playRound();
  });

  document.getElementById('btn-change-playlist').addEventListener('click', loadPlaylists);

  init();
})();
