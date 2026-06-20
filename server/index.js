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
    maxAge: 24 * 60 * 60 * 1000,
    sameSite: 'lax',
  })
);

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

async function getValidAccessToken(req) {
  if (!req.session.spotifyAccessToken) return null;

  const isExpired =
    !req.session.spotifyTokenExpiresAt || Date.now() > req.session.spotifyTokenExpiresAt - 5000;

  if (isExpired) {
    return await refreshSpotifyToken(req);
  }
  return req.session.spotifyAccessToken;
}

async function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    req.spotifyToken = authHeader.slice('Bearer '.length);
    return next();
  }

  const token = await getValidAccessToken(req);
  if (!token) {
    return res.status(401).json({ error: 'No has iniciado sesión con Spotify' });
  }
  req.spotifyToken = token;
  next();
}

// ---------------------------------------------------------------------------
// Client Credentials de Spotify: token "de la app", sin usuario.
// Solo sirve para leer datos PÚBLICOS (como una playlist pública por su ID),
// nunca para datos privados de una cuenta concreta. Así cualquiera puede
// pegar el link de una playlist pública sin tener que iniciar sesión.
// ---------------------------------------------------------------------------
let appAccessToken = null;
let appAccessTokenExpiresAt = 0;

async function getAppAccessToken() {
  if (appAccessToken && Date.now() < appAccessTokenExpiresAt - 5000) {
    return appAccessToken;
  }
  const response = await axios.post(
    'https://accounts.spotify.com/api/token',
    new URLSearchParams({ grant_type: 'client_credentials' }).toString(),
    {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' +
          Buffer.from(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`).toString('base64'),
      },
    }
  );
  appAccessToken = response.data.access_token;
  appAccessTokenExpiresAt = Date.now() + response.data.expires_in * 1000;
  return appAccessToken;
}

function extractSpotifyPlaylistId(input) {
  const trimmed = input.trim();
  const urlMatch = trimmed.match(/playlist[/:]([a-zA-Z0-9]+)/);
  if (urlMatch) return urlMatch[1];
  if (/^[a-zA-Z0-9]{10,}$/.test(trimmed)) return trimmed;
  return null;
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
    const isLiked = playlistId === 'liked';
    const MAX_PAGES_LIKED = 3;

    if (isLiked) {
      url = 'https://api.spotify.com/v1/me/tracks?limit=50';
    } else {
      url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;
    }

    let pageCount = 0;
    while (url) {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${req.spotifyToken}` },
      });

      const items = data.items
        .map((item) => item.track)
        .filter((t) => t && t.id && t.name)
        .map((t) => ({
          id: t.id,
          name: t.name,
          artist: t.artists.map((a) => a.name).join(', '),
          album: t.album?.name,
          durationMs: t.duration_ms,
          image: t.album?.images?.[0]?.url || null,
        }));

      tracks = tracks.concat(items);
      pageCount += 1;
      url = data.next;

      if (isLiked && pageCount >= MAX_PAGES_LIKED) {
        url = null;
      }
    }

    const seen = new Set();
    tracks = tracks.filter((t) => {
      const key = `${t.name.toLowerCase()}-${t.artist.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ tracks });
  } catch (err) {
    console.error('Error en /api/tracks:', err.response?.status, err.response?.data || err.message);
    res.status(500).json({
      error: 'No se han podido cargar las canciones',
      debug: err.response?.data || err.message,
      status: err.response?.status,
    });
  }
});

// ---------------------------------------------------------------------------
// API: leer una playlist PÚBLICA de Spotify a partir de su link, sin login.
// Usa Client Credentials (token de la app, no de un usuario concreto).
// ---------------------------------------------------------------------------

app.get('/api/public-spotify-tracks', async (req, res) => {
  const { url: playlistUrl } = req.query;
  if (!playlistUrl) {
    return res.status(400).json({ error: 'Falta el parámetro url' });
  }

  const playlistId = extractSpotifyPlaylistId(playlistUrl);
  if (!playlistId) {
    return res.status(400).json({ error: 'No se ha reconocido un ID de playlist de Spotify en ese link' });
  }

  try {
    const token = await getAppAccessToken();
    let tracks = [];
    let url = `https://api.spotify.com/v1/playlists/${playlistId}/tracks?limit=100`;

    while (url) {
      const { data } = await axios.get(url, {
        headers: { Authorization: `Bearer ${token}` },
      });

      const items = data.items
        .map((item) => item.track)
        .filter((t) => t && t.id && t.name)
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

    const seen = new Set();
    tracks = tracks.filter((t) => {
      const key = `${t.name.toLowerCase()}-${t.artist.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    res.json({ tracks });
  } catch (err) {
    console.error('Error en /api/public-spotify-tracks:', err.response?.data || err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'No se ha encontrado esa playlist. ¿Es pública?' });
    }
    res.status(500).json({ error: 'No se han podido cargar las canciones de esa playlist' });
  }
});

// ---------------------------------------------------------------------------
// API: leer una playlist de YouTube o YouTube Music a partir de su link.
// No requiere login, solo la API key del servidor.
// ---------------------------------------------------------------------------

function extractYoutubePlaylistId(input) {
  const trimmed = input.trim();
  const match = trimmed.match(/[?&]list=([a-zA-Z0-9_-]+)/);
  if (match) return match[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(trimmed)) return trimmed;
  return null;
}

app.get('/api/youtube-playlist-tracks', async (req, res) => {
  const { url: playlistUrl } = req.query;
  if (!playlistUrl) {
    return res.status(400).json({ error: 'Falta el parámetro url' });
  }
  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'El servidor no tiene configurada YOUTUBE_API_KEY' });
  }

  const playlistId = extractYoutubePlaylistId(playlistUrl);
  if (!playlistId) {
    return res.status(400).json({ error: 'No se ha reconocido un ID de playlist de YouTube en ese link' });
  }

  try {
    let tracks = [];
    let pageToken = '';

    do {
      const { data } = await axios.get('https://www.googleapis.com/youtube/v3/playlistItems', {
        params: {
          key: YOUTUBE_API_KEY,
          playlistId,
          part: 'snippet,contentDetails',
          maxResults: 50,
          pageToken: pageToken || undefined,
        },
      });

      const items = (data.items || [])
        .filter((item) => item.contentDetails?.videoId && item.snippet?.title !== 'Deleted video' && item.snippet?.title !== 'Private video')
        .map((item) => {
          const rawTitle = item.snippet.title;
          const channelTitle = item.snippet.videoOwnerChannelTitle || item.snippet.channelTitle || '';
          let name = rawTitle;
          let artist = channelTitle.replace(/\s*-\s*Topic$/i, '').trim();

          const dashSplit = rawTitle.split(' - ');
          if (dashSplit.length >= 2) {
            artist = dashSplit[0].trim();
            name = dashSplit.slice(1).join(' - ').trim();
          }

          return {
            id: item.contentDetails.videoId,
            name,
            artist: artist || 'Desconocido',
            durationMs: null,
            image: item.snippet.thumbnails?.high?.url || item.snippet.thumbnails?.default?.url || null,
            _videoId: item.contentDetails.videoId,
          };
        });

      tracks = tracks.concat(items);
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    if (tracks.length === 0) {
      return res.status(404).json({ error: 'No se han encontrado canciones en esa playlist. ¿Es pública?' });
    }

    res.json({ tracks });
  } catch (err) {
    console.error('Error en /api/youtube-playlist-tracks:', err.response?.data || err.message);
    if (err.response?.status === 404) {
      return res.status(404).json({ error: 'No se ha encontrado esa playlist. ¿Es pública?' });
    }
    res.status(500).json({ error: 'No se han podido cargar las canciones de esa playlist' });
  }
});

// ---------------------------------------------------------------------------
// API: buscar el vídeo de YouTube correspondiente a una canción
// ---------------------------------------------------------------------------

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

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Cancionero corriendo en http://127.0.0.1:${PORT}`);
});
