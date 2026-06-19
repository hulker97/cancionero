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
    roundTracks: [],     // las canciones que se usarán en esta partida (mezcladas)
    currentRoundIndex: 0,
    totalRounds: 10,
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
  // Empezar partida con una playlist concreta
  // ------------------------------------------------------------------
  async function startGameWithPlaylist(playlistId) {
    showScreen('screen-loading-game');
    document.getElementById('loading-game-text').textContent = 'Cargando canciones de tu lista…';

    try {
      const res = await fetch(`/api/tracks/${encodeURIComponent(playlistId)}`);
      const data = await res.json();

      if (!data.tracks || data.tracks.length < 4) {
        alert('Esta lista necesita al menos 4 canciones distintas para poder jugar. Elige otra.');
        await loadPlaylists();
        return;
      }

      state.allTracks = data.tracks;
      state.totalRounds = Math.min(10, data.tracks.length);
      state.roundTracks = pickRandom(data.tracks, state.totalRounds);
      state.currentRoundIndex = 0;
      state.score = 0;
      state.streak = 0;
      state.bestStreak = 0;

      document.getElementById('round-total').textContent = state.totalRounds;
      playRound();
    } catch (e) {
      alert('Ha ocurrido un error cargando las canciones. Vuelve a intentarlo.');
      await loadPlaylists();
    }
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

    const correctTrack = state.roundTracks[state.currentRoundIndex];

    // Generamos 4 opciones: la correcta + 3 distractores al azar del resto de la librería
    const distractorsPool = state.allTracks.filter((t) => t.id !== correctTrack.id);
    const distractors = pickRandom(distractorsPool, 3);
    const options = shuffle([correctTrack, ...distractors]);

    state.currentOptions = options;
    state.currentCorrectId = correctTrack.id;
    state.answered = false;

    // Buscamos el vídeo de YouTube correspondiente
    try {
      const res = await fetch(
        `/api/youtube-search?song=${encodeURIComponent(correctTrack.name)}&artist=${encodeURIComponent(correctTrack.artist)}`
      );
      if (!res.ok) throw new Error('No encontrado');
      const ytData = await res.json();
      correctTrack._videoId = ytData.videoId;
    } catch (e) {
      // Si no se encuentra el vídeo, saltamos esta ronda y vamos a la siguiente
      console.warn('No se encontró vídeo para', correctTrack.name, '- saltando ronda');
      advanceRound(true /* skip */);
      return;
    }

    renderRound(correctTrack, options);
    showScreen('screen-game');
  }

  function renderRound(correctTrack, options) {
    document.getElementById('round-current').textContent = state.currentRoundIndex + 1;
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

    state.ytPlayer.loadVideoById({
      videoId,
      startSeconds: state.fragmentStartSeconds,
    });

    // Algunos navegadores necesitan un playVideo() explícito tras loadVideoById
    // para no quedarse pausados en el primer frame.
    setTimeout(() => {
      if (state.ytPlayer && state.ytPlayer.playVideo) {
        state.ytPlayer.unMute();
        state.ytPlayer.playVideo();
      }
    }, 250);

    clearTimeout(state.fragmentTimer);
    state.fragmentTimer = setTimeout(() => {
      state.ytPlayer.pauseVideo();
      document.getElementById('vinyl').classList.remove('vinyl--spinning');
      playBtn.disabled = false;
      document.getElementById('play-label').textContent = 'Reproducir otra vez';
    }, 8000); // 8 segundos de fragmento
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

    document.getElementById('btn-next-round').onclick = () => advanceRound(false);
  }

  function advanceRound(skip) {
    state.currentRoundIndex += 1;
    if (state.currentRoundIndex >= state.roundTracks.length) {
      showResults();
    } else {
      playRound();
    }
  }

  // ------------------------------------------------------------------
  // Pantalla de resultados
  // ------------------------------------------------------------------
  function showResults() {
    document.getElementById('results-score').textContent = `${state.score} / ${state.totalRounds}`;
    document.getElementById('results-best-streak').textContent =
      state.bestStreak > 1 ? `Mejor racha: ${state.bestStreak} 🔥` : '';
    showScreen('screen-results');
  }

  // ------------------------------------------------------------------
  // Listeners de botones generales
  // ------------------------------------------------------------------
  document.getElementById('btn-logout').addEventListener('click', () => {
    window.location.href = '/logout';
  });

  document.getElementById('btn-quit-game').addEventListener('click', () => {
    clearTimeout(state.fragmentTimer);
    if (state.ytPlayer && state.ytPlayer.pauseVideo) state.ytPlayer.pauseVideo();
    loadPlaylists();
  });

  document.getElementById('btn-play-again').addEventListener('click', () => {
    state.roundTracks = pickRandom(state.allTracks, state.totalRounds);
    state.currentRoundIndex = 0;
    state.score = 0;
    state.streak = 0;
    state.bestStreak = 0;
    playRound();
  });

  document.getElementById('btn-change-playlist').addEventListener('click', loadPlaylists);

  init();
})();
