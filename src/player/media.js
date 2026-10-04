/* -------------------------------------------------------------------------
   HLS / DIRECT VIDEO INITIALISATION
   ------------------------------------------------------------------------- */
function isDirectVideoUrl(url) {
    if (url && url.startsWith('blob:')) return true;
    try {
        const path = new URL(url).pathname.toLowerCase();
        return /\.(mp4|webm|ogg|ogv|mov|mkv|avi|flv|m4v|ts|mts|m2ts)(\?|$)/.test(path);
    } catch (e) {
        return /\.(mp4|webm|ogg|ogv|mov|mkv|avi|flv|m4v|ts|mts|m2ts)(\?|$)/.test(url.toLowerCase());
    }
}

/* ---- Mirror domain fallback for direct video files ----
   Each pair below serves the same paths on both domains. If the URL is on
   one of these, swap to the other on error before giving up.
   - bigf.bigo.sg <-> bigf.imostatic.com
   - 1a-1791.com <-> hugh.cdn.rumble.cloud */
function getMirrorUrl(originalUrl) {
    if (originalUrl.includes('bigf.bigo.sg')) return originalUrl.replace('bigf.bigo.sg', 'chat.imostatic.com');
    if (originalUrl.includes('bigf.imostatic.com')) return originalUrl.replace('bigf.imostatic.com', 'chat.imostatic.com');
    if (originalUrl.includes('1a-1791.com')) return originalUrl.replace('1a-1791.com', 'hugh.cdn.rumble.cloud');
    if (originalUrl.includes('hugh.cdn.rumble.cloud')) return originalUrl.replace('hugh.cdn.rumble.cloud', '1a-1791.com');
    return null;
}

function getStreamPlaybackUrl(streamUrl, referer = 'https://embed.filmu.in/') {
    try {
        const parsed = new URL(streamUrl, window.location.href);
        const currentOrigin = window.location.origin;
        const isProxyUrl = parsed.pathname === '/proxy/stream' || parsed.pathname === '/proxy/any';
        const isExternal = parsed.origin !== currentOrigin;
                const origin = new URL(referer).origin;
        return isExternal && !isProxyUrl
            ? `/proxy/any?url=${encodeURIComponent(parsed.href)}` +
                            `&referer=${encodeURIComponent(referer)}` +
                            `&origin=${encodeURIComponent(origin)}`
            : streamUrl;
    } catch {
        return streamUrl;
    }
}

function initHlsPlayer(url, referer = 'https://embed.filmu.in/') {
    // Flush progress for the current episode before switching.
    // Must happen before resolvedUrl / videoStorageKey are overwritten.
    saveVideoProgress();
    if (saveProgressInterval) {
        clearInterval(saveProgressInterval);
        saveProgressInterval = null;
    }

    // Tear down any existing HLS instance cleanly before starting a new one.
    // This prevents the old instance from firing fatal error events mid-swap.
    stopProgressSaving();
    hasRestoredPosition = false;
    if (hlsInstance) {
        hlsInstance.destroy();
        hlsInstance = null;
    }
    _subtitleSelectionMade = false;
    // Remove injected subtitle tracks from previous episode
    Array.from(video.querySelectorAll('track[data-github], track[data-wyzie], track[data-urlset]')).forEach(t => t.remove());
    errorMessageDiv.classList.add('hidden');

    // Reset per-episode progress state so the new episode starts fresh.
    hasRestoredPosition = false;
    _audioAutoApplied = false;

    resolvedUrl     = url;
    videoStorageKey = generateStorageKey(url);

    // Start the Cloudflare country lookup immediately so it can run in
    // parallel with the HLS manifest request.
    getUserCountry();

    /* ---- Direct video file (MP4, WebM, etc.) ---- */
    if (isDirectVideoUrl(url)) {
        isHlsJsMode = false;
        showLoader();

        let _mirrorTried = false;

        const onLoadedMetadata = async () => {
            // Safari/iOS native HLS path: select the country-preferred track
            // through the browser's native audioTracks API before autoplay.
            await getUserCountry();

            if (video.audioTracks && video.audioTracks.length && !_audioAutoApplied) {
                const tracks = Array.from(video.audioTracks);
                const country = _userCountry;
                const preferences = getPreferredAudioLanguages(country);

                let selectedIndex = -1;
                for (const preferred of preferences) {
                    selectedIndex = tracks.findIndex(track => {
                        const lang = getAudioTrackLanguage(track);
                        const name = String(track?.label || track?.language || '').toLowerCase();
                        return lang === normalizeAudioLanguage(preferred) ||
                               name.includes(String(preferred).toLowerCase());
                    });
                    if (selectedIndex !== -1) break;
                }

                if (selectedIndex === -1) {
                    selectedIndex = tracks.findIndex(track => getAudioTrackLanguage(track) === 'en');
                }
                if (selectedIndex === -1) selectedIndex = 0;

                tracks.forEach((track, i) => { track.enabled = i === selectedIndex; });
                _audioAutoApplied = true;

                console.log(
                    `[Location Audio] ${country || 'unknown'} â†’ ${getAudioTrackLanguage(tracks[selectedIndex]) || 'unknown'}`
                );
            }

            video.removeEventListener('error', onVideoError);
            renderTracksMenu(); hideLoader(); setupInactivityDetection();
            restoreVideoProgress(); startProgressSaving();
            video.play().catch(() => {});
        };

        const onVideoError = () => {
            if (video.currentTime > 0 || video.readyState >= 2) return;

            const mirrorUrl = !_mirrorTried && getMirrorUrl(url);
            if (mirrorUrl) {
                _mirrorTried = true;
                console.warn(`[Mirror Fallback] Trying opposite domain: ${mirrorUrl}`);
                video.src = mirrorUrl;
                return;
            }

            video.removeEventListener('error', onVideoError);
            displayError('Failed to load video: ' + (video.error ? video.error.message : 'unknown error'));
            hideLoader();
        };

        video.addEventListener('loadedmetadata', onLoadedMetadata, {once:true});
        // Not {once:true} â€” needs to stay attached in case the mirror retry
        // also fails; removes itself on success or on final failure above.
        video.addEventListener('error', onVideoError);

        video.src = url;
        return;
    }

    const playbackUrl = getStreamPlaybackUrl(url, referer);

    /* ---- HLS stream (.m3u8) ---- */
    if (Hls.isSupported()) {
        isHlsJsMode = true;
        showLoader();
        const h = new Hls({
            renderTextTracksNatively: true,
            subtitleDisplay: true,
        });
        hlsInstance = h;

        h.on(Hls.Events.MEDIA_ATTACHED, () => h.loadSource(playbackUrl));
        h.on(Hls.Events.MANIFEST_PARSED, async () => {
            // Do the location lookup and language selection before autoplay.
            // This prevents the normal "first audio track" choice from being
            // the final selection.
            await applyLocationBasedAudio(h);
            applyDefaultEnglishSubtitle();
            renderTracksMenu();
            renderQualityList();
        });
        h.on(Hls.Events.AUDIO_TRACK_SWITCHED, renderTracksMenu);
        h.on(Hls.Events.SUBTITLE_TRACK_SWITCHED, renderTracksMenu);
        h.on(Hls.Events.LEVEL_SWITCHED, () => { if (!speedQualityMenu.classList.contains('hidden')) renderQualityList(); });
        h.on(Hls.Events.ERROR, (event, data) => {
            console.log(data);

            if (!data.fatal) return;

            switch (data.type) {
                case Hls.ErrorTypes.NETWORK_ERROR:
                    // Manifest/level 404s (or similar) are not recoverable by retrying â€”
                    // retrying just loops forever on a dead URL.
                    if (
                        data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR ||
                        data.details === Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT ||
                        data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR ||
                        data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT
                    ) {
                        console.error("Stream not found / unreachable:", data);
                        displayError("Stream not found (404)");
                        h.destroy();
                        hideLoader();
                        break;
                    }
                    console.warn("Network error, retrying...");
                    h.startLoad();
                    break;

                case Hls.ErrorTypes.MEDIA_ERROR:
                    console.warn("Media error, recovering...");
                    h.recoverMediaError();
                    break;

                default:
                    console.error("Unrecoverable error:", data);
                    displayError("Fatal HLS error");
                    h.destroy();
                    hideLoader();
                    break;
            }
        });
        h.attachMedia(video);

        video.addEventListener('loadedmetadata', () => restoreVideoProgress(), {once:true});
        video.addEventListener('canplay', async () => {
            // canplay may arrive before/alongside MANIFEST_PARSED on some
            // versions of HLS.js, so enforce the selection once more here.
            await applyLocationBasedAudio(h);
            hideLoader();
            setupInactivityDetection();
            startProgressSaving();
            video.play().catch(() => {});
        }, {once:true});
    }
    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        isHlsJsMode = false;
        showLoader();
        video.src = playbackUrl;
        video.addEventListener('loadedmetadata', async () => {
            // Safari/iOS native HLS path: select the country-preferred track
            // through the browser's native audioTracks API before autoplay.
            await getUserCountry();

            if (video.audioTracks && video.audioTracks.length && !_audioAutoApplied) {
                const tracks = Array.from(video.audioTracks);
                const country = _userCountry;
                const preferences = getPreferredAudioLanguages(country);

                let selectedIndex = -1;
                for (const preferred of preferences) {
                    selectedIndex = tracks.findIndex(track => {
                        const lang = getAudioTrackLanguage(track);
                        const name = String(track?.label || track?.language || '').toLowerCase();
                        return lang === normalizeAudioLanguage(preferred) ||
                               name.includes(String(preferred).toLowerCase());
                    });
                    if (selectedIndex !== -1) break;
                }

                if (selectedIndex === -1) {
                    selectedIndex = tracks.findIndex(track => getAudioTrackLanguage(track) === 'en');
                }
                if (selectedIndex === -1) selectedIndex = 0;

                tracks.forEach((track, i) => { track.enabled = i === selectedIndex; });
                _audioAutoApplied = true;

                console.log(
                    `[Location Audio] ${country || 'unknown'} â†’ ${getAudioTrackLanguage(tracks[selectedIndex]) || 'unknown'}`
                );
            }

            applyDefaultEnglishSubtitle();
            renderTracksMenu(); hideLoader(); setupInactivityDetection();
            restoreVideoProgress(); startProgressSaving();
            video.play().catch(() => {});
        }, {once:true});
        video.addEventListener('error', () => {
            if (video.currentTime > 0 && !video.paused) return;
            displayError('Failed to load stream: ' + (video.error ? video.error.message : 'unknown error'));
            hideLoader();
        }, {once:true});
    }
    else {
        displayError('Browser does not support HLS');
        hideLoader();
    }
}

const STREAM_API_URL = 'https://filmu.onrender.com/api/stream';
const BACKUP_STREAM_API_URL = 'https://vidzy-wtgr.onrender.com/api/stream';
const MAIN_STREAM_REFERER = 'https://embed.filmu.in/';
const BACKUP_STREAM_REFERER = 'https://player.vidzee.wtf/';

async function fetchStreamApi(type, id, season, episode) {
    const params = new URLSearchParams({ tmdb: String(id) });
    if (type === 'tv') {
        params.set('s', String(season));
        params.set('e', String(episode));
    } else {
        params.set('type', type);
    }

    let mainError;
    try {
        const response = await fetch(`${STREAM_API_URL}?${params}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Main stream API HTTP ${response.status}`);

        const data = await response.json();
        const sourceUrl = data?.sources?.find(source => source?.url)?.url
            || (data?.m3u8_path && data?._base ? new URL(data.m3u8_path, `${data._base}/`).href : null);
        if (data?.available !== false && sourceUrl) {
            return { data, sourceUrl, referer: MAIN_STREAM_REFERER };
        }
        mainError = new Error(data?.error || 'Main stream API returned no playable source');
    } catch (error) {
        mainError = error;
    }

    const backupParams = new URLSearchParams({ type, tmdb: String(id) });
    if (type === 'tv') {
        backupParams.set('s', String(season));
        backupParams.set('e', String(episode));
    }

    try {
        const response = await fetch(`${BACKUP_STREAM_API_URL}?${backupParams}`, { cache: 'no-store' });
        if (!response.ok) throw new Error(`Backup stream API HTTP ${response.status}`);

        const data = await response.json();
        const sourceUrl = data?.m3u8 || data?.sources?.find(source => source?.url)?.url;
        if (data?.available === false || !sourceUrl) {
            throw new Error(data?.error || 'Backup stream API returned no playable source');
        }
        return { data, sourceUrl, referer: BACKUP_STREAM_REFERER };
    } catch (backupError) {
        throw new Error(`Main stream unavailable (${mainError.message}); backup failed (${backupError.message})`);
    }
}

/* -------------------------------------------------------------------------
   PLAY MOVIE  â€“  /movie/{tmdbId}
   ------------------------------------------------------------------------- */
async function playMovie(movieId) {
    _revokeAllSubtitleBlobs();
    showLoader();

    try {
        const { sourceUrl, referer } = await fetchStreamApi('movie', movieId);
        initHlsPlayer(sourceUrl, referer);
        loadSubtitlesFromUrlset(sourceUrl, referer);
        loadSubtitlesFromGithub('movie', movieId);
        loadSubtitlesFromWyzie('movie', movieId);
        fetchAndSetTitle('movie', movieId);
        loadIntrodbTimestamps('movie', movieId);
    } catch (err) {
        displayError(`Failed to fetch movie stream: ${err.message}`);
        hideLoader();
    }
}

/* -------------------------------------------------------------------------
   PLAY EPISODE  â€“  /tv/{tmdbId}/S{season}/E{episode}
   ------------------------------------------------------------------------- */
async function playEpisode(seriesId, seasonNumber, episodeNumber) {
    _revokeAllSubtitleBlobs();
    // Keep episode panel state in sync
    _epPlayingSeason  = Number(seasonNumber);
    _epPlayingEpisode = Number(episodeNumber);
    _epCurrentSeason  = Number(seasonNumber); // reset panel view to playing season
    if (String(seriesId) !== _epSeriesId) {
        _epSeriesId    = String(seriesId);
        _epSeasonCache = {};
        _epLoadedSeason = null;
    }
    const expectedPath = `/tv/${seriesId}/S${seasonNumber}/E${episodeNumber}`;
    if (window.location.pathname !== expectedPath) {
        history.replaceState(null, '', expectedPath);
    }

    showLoader();

    try {
        const { sourceUrl, referer } = await fetchStreamApi('tv', seriesId, seasonNumber, episodeNumber);
        initHlsPlayer(sourceUrl, referer);
        loadSubtitlesFromUrlset(sourceUrl, referer);
        loadSubtitlesFromGithub('tv', seriesId, seasonNumber, episodeNumber);
        loadSubtitlesFromWyzie('tv', seriesId, seasonNumber, episodeNumber);
        fetchAndSetTitle('tv', seriesId, seasonNumber, episodeNumber);
        loadIntrodbTimestamps('tv', seriesId, seasonNumber, episodeNumber);
    } catch (err) {
        displayError(`Failed to fetch episode stream: ${err.message}`);
        hideLoader();
    }
}

/* -------------------------------------------------------------------------
   START  â€“  Route dispatcher
             Movie:    /movie/{tmdbId}
             TV:       /tv/{tmdbId}/S{season}/E{episode}
             Fallback: ?url=  or hardcoded default
   ------------------------------------------------------------------------- */
async function resolveAndPlay() {
    const path = window.location.pathname;

    const movieMatch = path.match(/\/movie\/(\d+)/i);
    if (movieMatch) {
        return playMovie(movieMatch[1]);
    }

    const tvMatch = path.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i)
                 || path.match(/\/tv\/(\d+)\/(\d+)\/(\d+)/);
    if (tvMatch) {
        return playEpisode(tvMatch[1], tvMatch[2], tvMatch[3]);
    }

    // IMDb movie route: /movie/tt1234567
    const movieImdbMatch = path.match(/\/movie\/(tt\d+)/i);
    if (movieImdbMatch) {
        return playMovieByImdb(movieImdbMatch[1]);
    }

    // IMDb TV route: /tv/tt1234567/S1/E1  (also accepts /tv/tt1234567/1/1)
    const tvImdbMatch = path.match(/\/tv\/(tt\d+)\/S(\d+)\/E(\d+)/i)
                      || path.match(/\/tv\/(tt\d+)\/(\d+)\/(\d+)/i);
    if (tvImdbMatch) {
        return playEpisodeByImdb(tvImdbMatch[1], tvImdbMatch[2], tvImdbMatch[3]);
    }

    const tmdbId = urlParams.get('tmdb');
    const mediaType = urlParams.get('type');
    if (/^\d+$/.test(tmdbId || '') && mediaType === 'movie') {
        return playMovie(tmdbId);
    }
    if (/^\d+$/.test(tmdbId || '') && mediaType === 'tv') {
        return playEpisode(tmdbId, urlParams.get('s') || '1', urlParams.get('e') || '1');
    }

    /* Test route: /testurl?url=<master> or /testurl=<master> */
    if (/^\/testurl(?:=|$)/i.test(path)) {
        const pathUrl = path.slice('/testurl='.length);
        const hlsUrl = urlParams.get('url') || decodeURIComponent(pathUrl);
        if (hlsUrl) {
            initHlsPlayer(hlsUrl);
            return;
        }
    }

    /* Fallback: ?url= query param or hardcoded default */
    const hlsUrl =
        urlParams.get('url') ||
        'https://files.vidstack.io/sprite-fight/hls/stream.m3u8';

    initHlsPlayer(hlsUrl);
}

/* -------------------------------------------------------------------------
   TMDB TITLE FETCHING
   ------------------------------------------------------------------------- */
const TMDB_PROXY = '/api/tmdb';

/* -------------------------------------------------------------------------
   IMDB â†’ TMDB RESOLUTION
   Everything downstream (playMovie/playEpisode, subtitles, intro timestamps,
   title fetching, the GitHub HLS lookup, etc.) is keyed on TMDB ids, so an
   IMDb id in the URL is resolved to its TMDB id first, the URL is rewritten
   to the canonical /movie/{tmdbId} or /tv/{tmdbId}/S{s}/E{e} form, and then
   the normal TMDB-based flow takes over.
   ------------------------------------------------------------------------- */
async function resolveImdbToTmdbId(imdbId, mediaType) {
    try {
        const res = await fetch(`${TMDB_PROXY}/find/${imdbId}?external_source=imdb_id`);
        if (!res.ok) return null;
        const data = await res.json();
        const results = mediaType === 'movie' ? data.movie_results : data.tv_results;
        return (results && results[0] && results[0].id) ? results[0].id : null;
    } catch (e) {
        console.warn('resolveImdbToTmdbId failed:', e.message);
        return null;
    }
}

async function playMovieByImdb(imdbId) {
    showLoader();
    const tmdbId = await resolveImdbToTmdbId(imdbId, 'movie');
    if (!tmdbId) {
        displayError(`Could not find a movie for IMDb ID ${imdbId}.`);
        hideLoader();
        return;
    }
    history.replaceState(null, '', `/movie/${tmdbId}`);
    return playMovie(tmdbId);
}

async function playEpisodeByImdb(imdbId, seasonNumber, episodeNumber) {
    showLoader();
    const tmdbId = await resolveImdbToTmdbId(imdbId, 'tv');
    if (!tmdbId) {
        displayError(`Could not find a TV show for IMDb ID ${imdbId}.`);
        hideLoader();
        return;
    }
    history.replaceState(null, '', `/tv/${tmdbId}/S${seasonNumber}/E${episodeNumber}`);
    return playEpisode(tmdbId, seasonNumber, episodeNumber);
}

async function fetchAndSetTitle(type, id, season, episode) {
    try {
        if (type === 'movie') {
            const res = await fetch(`${TMDB_PROXY}/movie/${id}`);
            if (!res.ok) return;
            const data = await res.json();
            const title = data.title || '';
            document.getElementById('title-main-text').textContent = title;
            document.getElementById('mobile-title-main').textContent = title;
            document.title = title || document.title;

            // Evidence overlay
            document.getElementById('ev-title').textContent = title;
            document.getElementById('ev-season').style.display = 'none';
            document.getElementById('ev-episode').style.display = 'none';
            const synEl = document.getElementById('ev-synopsis');
            const synopsis = data.overview || '';
            if (synopsis) { synEl.textContent = synopsis; synEl.style.display = 'block'; }
            else synEl.style.display = 'none';

        } else if (type === 'tv') {
            const [seriesRes, epRes] = await Promise.all([
                fetch(`${TMDB_PROXY}/tv/${id}`),
                fetch(`${TMDB_PROXY}/tv/${id}/season/${season}/episode/${episode}`)
            ]);
            const series = seriesRes.ok ? await seriesRes.json() : {};
            const ep     = epRes.ok     ? await epRes.json()     : {};
            const seriesName = series.name || '';
            const epName     = ep.name    || '';
            const label      = `S${season}:E${episode}`;
            const fullTitle  = [seriesName, label, epName].filter(Boolean).join(' ');
            const mobileTitle = `${label} "${epName || seriesName}"`;
            document.getElementById('title-main-text').textContent = fullTitle;
            document.getElementById('mobile-title-main').textContent = mobileTitle;
            document.title = fullTitle || document.title;

            // Evidence overlay
            document.getElementById('ev-title').textContent = seriesName;

            // Season label â€” "Limited Series" if miniseries/single season, else "Season N"
            const seasonEl = document.getElementById('ev-season');
            const seasonType = series.type || '';
            let seasonLabel = '';
            if (seasonType === 'Miniseries' || Number(series.number_of_seasons) === 1) {
                seasonLabel = 'Limited Series';
            } else {
                const seasonData = (series.seasons || []).find(s => s.season_number === Number(season));
                seasonLabel = seasonData ? seasonData.name : `Season ${season}`;
            }
            if (seasonLabel) { seasonEl.textContent = seasonLabel; seasonEl.style.display = 'block'; }
            else seasonEl.style.display = 'none';

            // Episode title
            const epEl = document.getElementById('ev-episode');
            if (epName) { epEl.textContent = `Episode ${episode}: ${epName}`; epEl.style.display = 'block'; }
            else epEl.style.display = 'none';

            // Synopsis
            const synEl = document.getElementById('ev-synopsis');
            const synopsis = ep.overview || '';
            if (synopsis) { synEl.textContent = synopsis; synEl.style.display = 'block'; }
            else synEl.style.display = 'none';
        }
    } catch (e) {
        /* Silently ignore â€” title is non-critical */
        console.warn('fetchAndSetTitle failed:', e.message);
    }
}

