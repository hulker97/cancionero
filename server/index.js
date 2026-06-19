// server/index.js
// Servidor del juego "Cancionero".
// Se encarga de: 1) login con Spotify (OAuth), 2) leer playlists/canciones guardadas,
// 3) buscar el vídeo correspondiente en YouTube para poder reproducir un fragmento.

require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cookieSession = require('cookie-session');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8888;

const {
  SPOTIFY_CLIENT_ID,
  SPOTIFY_CLIENT_SECRET,
  SPOTIFY_REDIRECT_URI,
  YOUTUBE_API_KEY,
  SESSION_SECRET,
} = process.env;

// Avisos claros si falta configuración, para que sea fácil depurar.
if (!SPOTIFY_CLIENT_ID || !SPOTIFY_CLIENT_SECRET) {
  console.warn('[AVISO] Falta SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET en el .env');
}
if (!YOUTUBE_API_KEY) {
  console.warn('[AVISO] Falta YOUTUBE_API_KEY en el .env (la búsqueda de vídeos no funcionará)');
}

app.use(express.json());
app.use(
  cookieSession({
    name: 'cancionero_session',
    keys: [SESSION_SECRET || 'fallback-secret-no-usar-en-produccion'],
    maxAge: 24 * 60 * 60 * 1000, // 24 horas
    sameSite: 'lax',
  })
);

// Servimos los archivos estáticos del frontend (carpeta /public)
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// LOGIN CON SPOTIFY
// ---------------------------------------------------------------------------

const SPOTIFY_SCOPES = [
  'user-read-private',
  'playlist-read-private',
  'playlist-read-collaborative',
  'user-library-read',
].join(' ');

// Paso 1: el usuario hace clic en "Conectar con Spotify" -> le mandamos aquí
app.get('/login', (req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  req.session.oauthState = state;

  const params = new URLSearchParams({
    response_type: 'code',
    client_id: SPOTIFY_CLIENT_ID,
    scope: SPOTIFY_SCOPES,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    state,
  });

  res.redirect(`https://accounts.spotify.com/authorize?${params.toString()}`);
});

// Paso 2: Spotify redirige aquí de vuelta con un "code" que canjeamos por tokens
app.get('/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.redirect(`/?error=${encodeURIComponent(error)}`);
  }

  if (!state || state !== req.session.oauthState) {
    return res.redirect('/?error=estado_invalido');
  }

  try {
    const tokenResponse = await axios.post(
      'https://accounts.spotify.com/api/token',
      new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: SPOTIFY_REDIRECT_URI,
      }).toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
        },
      }
    );

    const { access_token, refresh_token, expires_in } = tokenResponse.data;

    req.session.spotifyAccessToken = access_token;
    req.session.spotifyRefreshToken = refresh_token;
    req.session.spotifyTokenExpiresAt = Date.now() + expires_in * 1000;

    res.redirect('/');
  } catch (err) {
    console.error('Error canjeando el código por token:', err.response?.data || err.message);
    res.redirect('/?error=fallo_login');
  }
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/');
});

// Refresca el access token de Spotify usando el refresh token guardado en sesión
async function refreshSpotifyToken(req) {
  if (!req.session.spotifyRefreshToken) return null;

  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: req.session.spotifyRefreshToken,
    }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );

  req.session.spotifyAccessToken = response.data.access_token;
  req.session.spotifyTokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  return response.data.access_token;
}

// Helper: obtiene un access token válido, refrescándolo si ha caducado
async function getValidAccessToken(req) {
  if (!req.session.spotifyAccessToken) return null;

  const isExpired =
    !req.session.spotifyTokenExpiresAt || Date.now() > req.session.spotifyTokenExpiresAt - 5000;

  if (isExpired) {
    return await refreshSpotifyToken(req);
  }
  return req.session.spotifyAccessToken;
}

// Middleware para rutas que requieren estar logueado
async function requireAuth(req, res, next) {
  const token = await getValidAccessToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No has iniciado sesión con Spotify' });
  }
  req.spotifyToken = token;
  next();
}

// ---------------------------------------------------------------------------
// API: estado de sesión
// ---------------------------------------------------------------------------

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const { data } = await axios.get('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${req.spotifyToken}` },
    });
    res.json({ id: data.id, name: data.display_name, image: data.images?.[0]?.url || null });
  } catch (err) {
    console.error('Error en /api/me:', err.response?.data || err.message);
    res.status(500).json({ error: 'No se ha podido obtener el perfil' });
  }
});

app.get('/api/auth-status', (req, res) => {
  res.json({ loggedIn: !!req.session.spotifyAccessToken });
});

// ---------------------------------------------------------------------------
// API: listar playlists del usuario
// ---------------------------------------------------------------------------

app.get('/api/playlists', requireAuth, async (req, res) => {
  try {
    let playlists = [];
    let url = 'https://api.spotify.com/v1/me/playlists?limit=50';

    while (url) {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${req.spotifyToken}` },
      });
      playlists = playlists.concat(
        data.items
          .filter((p) => p && p.tracks?.total > 0)
          .map((p) => ({
            id: p.id,
            name: p.name,
            image: p.images?.[0]?.url || null,
            trackCount: p.tracks.total,
            owner: p.owner?.display_name,
          }))
      );
      url = data.next;
    }

    // Añadimos también "Tus canciones guardadas" como opción especial
    res.json({
      playlists,
      special: [{ id: 'liked', name: 'Tus canciones guardadas', image: null }],
    });
  } catch (err) {
    console.error('Error en /api/playlists:', err.response?.data || err.message);
    res.status(500).json({ error: 'No se han podido cargar las playlists' });
  }
});

// ---------------------------------------------------------------------------
// API: obtener las canciones de una playlist (o de "liked songs")
// ---------------------------------------------------------------------------

app.get('/api/tracks/:playlistId', requireAuth, async (req, res) => {
  const { playlistId } = req.params;
  try {
    let tracks = [];
    let url;

    if (playlistId === 'liked') {
      url = 'https://api.spotify.com/v1/me/tracks?limit=50';
    } else {
      url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
    }

    while (url) {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${req.spotifyToken}` },
      });

      const items = data.items
        .map((item) => item.track)
        .filter((t) => t && t.id && t.name) // descarta vídeos/episodios borrados o locales
        .map((t) => ({
          id: t.id,
          name: t.name,
          artist: t.artists.map((a) => a.name).join(', '),
          album: t.album?.name,
          durationMs: t.duration_ms,
          image: t.album?.images?.[0]?.url || null,
        }));

      tracks = tracks.concat(items);
      url = data.next;
    }

    // Quitamos duplicados (misma canción puede aparecer varias veces)
    const seen = new Set();
    tracks = tracks.filter((t) => {
      const key = `${t.name.toLowerCase()}-${t.artist.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ tracks });
  } catch (err) {
    console.error('Error en /api/tracks:', err.response?.data || err.message);
    res.status(500).json({ error: 'No se han podido cargar las canciones' });
  }
});

// ---------------------------------------------------------------------------
// API: buscar el vídeo de YouTube correspondiente a una canción
// ---------------------------------------------------------------------------

// Caché simple en memoria para no repetir búsquedas de la misma canción
const youtubeCache = new Map();

app.get('/api/youtube-search', async (req, res) => {
  const { song, artist } = req.query;
  if (!song || !artist) {
    return res.status(400).json({ error: 'Faltan parámetros song y artist' });
  }
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'El servidor no tiene configurada YOUTUBE_API_KEY' });
  }

  const cacheKey = `${artist.toLowerCase()}-${song.toLowerCase()}`;
  if (youtubeCache.has(cacheKey)) {
    return res.json(youtubeCache.get(cacheKey));
  }

  try {
    const query = `${artist} - ${song} audio`;
    const { data } = await axios.get('https://www.googleapis.com/youtube/v3/search', {
      params: {
        key: YOUTUBE_API_KEY,
        q: query,
        part: 'snippet',
        type: 'video',
        maxResults: 1,
        videoEmbeddable: 'true',
      },
    });

    const video = data.items?.[0];
    if (!video) {
      return res.status(404).json({ error: 'No se ha encontrado vídeo' });
    }

    const result = {
      videoId: video.id.videoId,
      title: video.snippet.title,
    };

    youtubeCache.set(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error('Error en /api/youtube-search:', err.response?.data || err.message);
    res.status(500).json({ error: 'Fallo buscando en YouTube' });
  }
});

// Cualquier otra ruta -> servimos el index.html (SPA simple)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Cancionero corriendo en http://127.0.0.1:${PORT}`);
});
