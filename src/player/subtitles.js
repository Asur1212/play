/* -------------------------------------------------------------------------
   SUBTITLES FROM GITHUB subtitles.json
   ------------------------------------------------------------------------- */
const GITHUB_RAW = 'https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main';

const LANG_LABELS = {
    eng:'English', hin:'Hindi', ara:'Arabic', fra:'French', spa:'Spanish',
    por:'Portuguese', rus:'Russian', zho:'Chinese', jpn:'Japanese', kor:'Korean',
    ger:'German', ita:'Italian', tam:'Tamil', tel:'Telugu', mal:'Malayalam',
    ben:'Bengali', mar:'Marathi', urd:'Urdu', pol:'Polish', tur:'Turkish',
    nld:'Dutch', swe:'Swedish', nor:'Norwegian', dan:'Danish', fin:'Finnish',
    ind:'Indonesian', tha:'Thai', vie:'Vietnamese', ces:'Czech', hun:'Hungarian',
    ron:'Romanian', bul:'Bulgarian', hrv:'Croatian', srp:'Serbian', slk:'Slovak',
    ukr:'Ukrainian', heb:'Hebrew', fas:'Persian', msa:'Malay',
};

function langLabel(code) {
    return LANG_LABELS[code] || code.toUpperCase();
}

function srtToVtt(srt) {
    // Convert SRT subtitle format to WebVTT format (required by HTML5 <track>)
    // line:85% pushes cues above the controls bar, align:center keeps them centred
    let vtt = 'WEBVTT\n\n';
    const body = srt
        .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
        .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
        .trim();
    // Inject position cue settings on every timestamp line
    vtt += body.replace(
        /(\d{2}:\d{2}:\d{2}\.\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}\.\d{3})/g,
        '$1 line:85% position:50% align:center'
    );
    return vtt;
}

// Track blob URLs so we can revoke them when reloading
const _subtitleBlobUrls = [];

function _revokeAllSubtitleBlobs() {
    while (_subtitleBlobUrls.length) {
        URL.revokeObjectURL(_subtitleBlobUrls.pop());
    }
}

async function loadSubtitlesFromGithub(type, id, season, episode) {
    // 2-letter codes derived from languageCodeMap
    const twoLetterCodes = Object.entries(languageCodeMap)
        .filter(([code]) => code.length === 2)
        .map(([code]) => code);

    // Shared inject helper
    const injectTracks = (validTracks) => {
        const allBefore = Array.from(video.textTracks)
            .filter(t => t.kind === 'subtitles' || t.kind === 'captions');
        const showingBefore = allBefore.findIndex(t => t.mode === 'hidden');

        Array.from(video.querySelectorAll('track[data-github]')).forEach(t => t.remove());

        validTracks.forEach(({ label, blobUrl, srclang }) => {
            const track = document.createElement('track');
            track.kind    = 'subtitles';
            track.label   = label;
            track.srclang = srclang;
            track.src     = blobUrl;
            track.setAttribute('data-github', '1');
            track.default = false;
            video.appendChild(track);
        });

        if (showingBefore !== -1) {
            const allAfter = Array.from(video.textTracks)
                .filter(t => t.kind === 'subtitles' || t.kind === 'captions');
            allAfter.forEach((t, i) => {
                t.mode = (i === showingBefore) ? 'hidden' : 'disabled';
            });
        }

        applyDefaultEnglishSubtitle();
        renderTracksMenu();
    };

    const scheduleInject = (validTracks) => {
        if (!validTracks.length) return;
        if (video.readyState >= 1) {
            injectTracks(validTracks);
        } else {
            video.addEventListener('loadedmetadata', () => injectTracks(validTracks), { once: true });
        }
    };

    try {
        // â”€â”€ TV: episode endpoints â†’ season endpoint â†’ subtitles.json â”€â”€â”€â”€â”€â”€â”€â”€â”€
        if (type === 'tv') {
            // 1. Episode-specific endpoint:
            //    sub/tv/{id}/{season}/endpoints.json
            //    Its value already contains the complete subtitle filename stem
            //    ending in a dot, so only the language + .srt are appended.
            try {
                const episodeEndpoint = `${GITHUB_RAW}/sub/tv/${id}/${season}/endpoints.json`;
                const episodeRes = await fetch(episodeEndpoint, { cache: 'no-store' });

                if (episodeRes.ok) {
                    const endpoints = await episodeRes.json();
                    const episodeBase = endpoints?.[String(episode)];

                    if (typeof episodeBase === 'string' && episodeBase.trim()) {
                        const trackData = await Promise.all(twoLetterCodes.map(async (code) => {
                            try {
                                const url = `${episodeBase.trim()}.${code}.srt`;
                                const res = await fetch(url, { cache: 'no-store' });
        
                                if (!res.ok) return null;

                                const srtText = await res.text();
                                const vttText = srtToVtt(srtText);
                                const blob = new Blob(
                                    [vttText],
                                    { type: 'text/vtt;charset=utf-8' }
                                );
                                const blobUrl = URL.createObjectURL(blob);

                                _subtitleBlobUrls.push(blobUrl);
        
                                const label = languageCodeMap[code] || code.toUpperCase();

                                return {
                                    label,
                                    blobUrl,
                                    srclang: code
                                };
                            } catch (err) {
                                return null;
                            }
                        }));

                        const validTracks = trackData.filter(Boolean);

                        if (validTracks.length) {
                            scheduleInject(validTracks);
                            return; // New endpoints.json succeeded
                        }
                    } else {
                        console.warn(
                            `No subtitle endpoint found for episode ${episode} in endpoints.json.`
                        );
                    }
                }
            } catch (e) {
                console.warn('Episode endpoint subtitle fetch failed, trying season endpoint:', e.message);
            }

            // 2. Existing season-wide endpoint fallback:
            //    sub/tv/{id}/{season}/endpoint
            //    Its value is a base URL, so the episode number is inserted.
            try {
                const seasonEndpoint = `${GITHUB_RAW}/sub/tv/${id}/${season}/endpoint`;
                const baseRes = await fetch(seasonEndpoint, { cache: 'no-store' });

                if (baseRes.ok) {
                    const cloudinaryBase = (await baseRes.text()).trim();

                    // Fetch all language VTTs in parallel: {base}{episode}.{langCode}.vtt
                    const trackData = await Promise.all(twoLetterCodes.map(async (code) => {
                        try {
                            const url = `${cloudinaryBase}${episode}.${code}.vtt`;
                            const res = await fetch(url, { cache: 'no-store' });
                            if (!res.ok) return null;
                            const vttText = await res.text();
                            const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
                            const blobUrl = URL.createObjectURL(blob);
                            _subtitleBlobUrls.push(blobUrl);
                            const label = languageCodeMap[code] || code.toUpperCase();
                            return { label, blobUrl, srclang: code };
                        } catch (err) {
                            return null;
                        }
                    }));

                    const validTracks = trackData.filter(Boolean);
                    if (validTracks.length) {
                        scheduleInject(validTracks);
                        return; // Season endpoint succeeded â€” skip subtitles.json
                    }
                }
            } catch (e) {
                console.warn('Season endpoint subtitle fetch failed, falling back to subtitles.json:', e.message);
            }
        }

        // â”€â”€ Fallback: subtitles.json (movies + TV fallback) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        const jsonPath = type === 'movie'
            ? `${GITHUB_RAW}/sub/movie/${id}/subtitles.json`
            : `${GITHUB_RAW}/sub/tv/${id}/${season}/${episode}/subtitles.json`;

        try {
            const res = await fetch(jsonPath, { cache: 'no-store' });
            if (!res.ok) return;

            const data = await res.json();
            const subs = data.subtitles || {};
            const langs = Object.keys(subs);
            if (!langs.length) return;

            const trackData = await Promise.all(langs.map(async (lang) => {
                try {
                    const srtRes = await fetch(subs[lang], { cache: 'no-store' });
                    if (!srtRes.ok) return null;
                    const srtText = await srtRes.text();
                    const vttText = srtToVtt(srtText);
                    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
                    const blobUrl = URL.createObjectURL(blob);
                    _subtitleBlobUrls.push(blobUrl);
                    return { label: langLabel(lang), blobUrl, srclang: lang };
                } catch (err) {
                    console.warn(`Failed to load subtitle for ${lang}:`, err.message);
                    return null;
                }
            }));

            scheduleInject(trackData.filter(Boolean));

        } catch (e) {
            console.warn('Could not load subtitles.json:', e.message);
        }
    } catch (e) {
        console.warn('loadSubtitlesFromGithub failed:', e.message);
    }
}

/* -------------------------------------------------------------------------
   SUBTITLES FROM WYZIE (OpenSubtitles proxy)
   Priority order in menu: HLS â†’ GitHub â†’ Wyzie

   LAZY LOADING: Only the Wyzie search API is called on page load to get
   the track list. Actual SRT files are only fetched when the user clicks
   a Wyzie subtitle. This avoids downloading 10â€“20 subtitle files upfront
   and makes tracks appear in the menu immediately.
   ------------------------------------------------------------------------- */
const WYZIE_API    = 'https://subs.videasy.to/search';

async function fetchAndActivateWyzieTrack(trackEl) {
    const lazyUrl = trackEl.getAttribute('data-lazy-url');
    if (!lazyUrl) return true; // already loaded

    try {
        const srtRes = await fetch(lazyUrl, { cache: 'no-store' });
        if (!srtRes.ok) throw new Error(`HTTP ${srtRes.status}`);
        const srtText = await srtRes.text();
        const vttText = srtToVtt(srtText);
        const blob    = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
        const blobUrl = URL.createObjectURL(blob);
        _subtitleBlobUrls.push(blobUrl);
        trackEl.src = blobUrl;
        trackEl.removeAttribute('data-lazy-url');
        return true;
    } catch (err) {
        console.warn('Wyzie lazy fetch failed:', err.message);
        return false;
    }
}

let _wyzieLoading = false;

// Fetch IMDb ID from TMDB external_ids endpoint (needed by Wyzie/OpenSubtitles)
async function fetchImdbId(type, tmdbId) {
    try {
        const endpoint = type === 'movie'
            ? `${TMDB_PROXY}/movie/${tmdbId}/external_ids`
            : `${TMDB_PROXY}/tv/${tmdbId}/external_ids`;
        const res = await fetch(endpoint, { cache: 'force-cache' });
        if (!res.ok) return null;
        const data = await res.json();
        return data.imdb_id || null;
    } catch (e) {
        console.warn('fetchImdbId failed:', e.message);
        return null;
    }
}

async function loadSubtitlesFromWyzie(type, id, season, episode) {
    _wyzieLoading = true;
    renderTracksMenu(); // immediately show loading state in menu if already open
    try {
        // Wyzie/OpenSubtitles requires an IMDb ID, not a TMDB ID â€” resolve it first
        const imdbId = await fetchImdbId(type, id);
        if (!imdbId) { _wyzieLoading = false; renderTracksMenu(); return; }

        // Build query URL â€” metadata only, SRT files fetched lazily on selection
        let apiUrl = `${WYZIE_API}?id=${imdbId}`;
        if (type === 'tv') {
            apiUrl += `&season=${season}&episode=${episode}`;
        }

        const res = await fetch(apiUrl, { cache: 'no-store' });
        if (!res.ok) { _wyzieLoading = false; renderTracksMenu(); return; }

        const tracks = await res.json();
        if (!Array.isArray(tracks) || !tracks.length) { _wyzieLoading = false; renderTracksMenu(); return; }

        // Inject placeholder <track> elements immediately â€” no SRT fetch yet.
        // The actual SRT is downloaded only when the user selects a track.
        const inject = () => {
            // Remove previously injected Wyzie tracks before re-injecting
            Array.from(video.querySelectorAll('track[data-wyzie]')).forEach(t => t.remove());

            tracks.forEach((track) => {
                const el = document.createElement('track');
                el.kind    = 'subtitles';
                el.label   = (track.display || track.language) + (track.isHearingImpaired ? ' [CC]' : '');
                el.srclang = track.language;
                // Do NOT set el.src â€” store the SRT URL for lazy loading on selection
                el.setAttribute('data-wyzie', '1');
                el.setAttribute('data-lazy-url', track.url);
                el.default = false;
                video.appendChild(el);
            });

            // Tracks have no src so the browser won't auto-activate them,
            // but defensively mark any that slipped through as disabled.
            Array.from(video.textTracks)
                .filter(t => t.kind === 'subtitles' || t.kind === 'captions')
                .forEach(t => {
                    const el = Array.from(video.querySelectorAll('track[data-wyzie]'))
                        .find(el => el.track === t);
                    if (el && el.hasAttribute('data-lazy-url')) t.mode = 'disabled';
                });

            // Re-render menu so Wyzie tracks appear immediately after GitHub tracks
            _wyzieLoading = false;
            applyDefaultEnglishSubtitle();
            renderTracksMenu();
        };

        if (video.readyState >= 1) {
            inject();
        } else {
            video.addEventListener('loadedmetadata', inject, { once: true });
        }

    } catch (e) {
        _wyzieLoading = false;
        renderTracksMenu();
        console.warn('Wyzie subtitle load failed:', e.message);
    }
}
/* -------------------------------------------------------------------------
   SUBTITLES FROM URLSET (AceK CDN Pattern Extraction)
   Stream: https://{host}/{srv}/hls3/{prefix}/{folderId}/{filePrefix}_,l,n,h,.urlset/master.txt
   Sub:    https://{srv.toLowerCase()}.acek-cdn.com/vtt/{prefix}/{folderId}/{filePrefix}{langCode}.vtt
   ------------------------------------------------------------------------- */
async function loadThumbnailPlaylist(streamUrl, referer) {
    const sourceUrl = new URL(streamUrl);
    const playlistUrl = new URL('tiles.m3u8', sourceUrl);
    sourceUrl.searchParams.forEach((value, key) => playlistUrl.searchParams.set(key, value));

    const playbackUrl = new URL(getStreamPlaybackUrl(playlistUrl.href, referer), window.location.href).href;
    const response = await fetch(playbackUrl, { cache: 'no-store' });
    if (!response.ok) return false;

    const lines = (await response.text()).split(/\r?\n/);
    const cues = [];
    let start = 0;
    let segmentDuration = null;

    for (const line of lines) {
        const duration = line.match(/^#EXTINF:([\d.]+)/);
        if (duration) {
            segmentDuration = Number(duration[1]);
            continue;
        }
        if (!line.trim() || line.startsWith('#') || segmentDuration === null) continue;

        cues.push({ start, end: start + segmentDuration, x: 0, y: 0 });
        start += segmentDuration;
        segmentDuration = null;
    }

    if (!cues.length) return false;
    setThumbnailVideoSource(playbackUrl, cues);
    return true;
}

async function loadSubtitlesFromUrlset(streamUrl, referer) {
    if (!streamUrl) return;

    if (!streamUrl.includes('/hls3/')) {
        try {
            await loadThumbnailPlaylist(streamUrl, referer);
        } catch (err) {
            console.warn('[ThumbnailPlaylist] Failed to load thumbnails:', err.message);
        }
        return;
    }

    try {
        const parsedUrl = new URL(streamUrl);
        const pathname = parsedUrl.pathname;

        // Extract: srv, prefix, folderId, filePrefix
        // Supports two URL shapes:
        //   old: {filePrefix}_,l,n,h,.urlset/master.txt
        //   new: {filePrefix}_n/master.txt  (or _h/, _l/ â€” quality variants)
        const match = pathname.match(/\/([^\/]+)\/hls3\/([^\/]+)\/([^\/]+)\/([^\/]+)_(?:,|[nhl]\/)/);
        if (!match) return;

        const [, srv, prefix, folderId, filePrefix] = match;

        setThumbnailSprite(`https://pixibay.cc/${filePrefix}0000.jpg`);

        // Supported CDN domains to try
        const cdnDomains = ['acek-cdn.com', 'dramiyos-cdn.com'];

        // Languages to check
        const langCodes = [
            'eng', 'hin', 'spa', 'fre', 'ger', 'ita', 'por', 'rus', 
            'zho', 'ara', 'kor', 'jpn', 'tam', 'tel', 'kan', 'mal'
        ];

        // Fetch tracks in parallel across supported CDNs
        const trackData = await Promise.all(langCodes.map(async (code) => {
            for (const domain of cdnDomains) {
                try {
                    const cdnHost = `https://${srv.toLowerCase()}.${domain}`;
                    const vttUrl = `${cdnHost}/vtt/${prefix}/${folderId}/${filePrefix}_${code}.vtt`;
                    const res = await fetch(vttUrl, { cache: 'no-store' });
                    if (!res.ok) continue;

                    const vttText = await res.text();
                    if (!vttText.includes('WEBVTT')) continue;

                    const blob = new Blob([vttText], { type: 'text/vtt;charset=utf-8' });
                    const blobUrl = URL.createObjectURL(blob);
                    _subtitleBlobUrls.push(blobUrl);

                    const label = getFullLanguageName(code) || code.toUpperCase();
                    return { label, blobUrl, srclang: code };
                } catch (e) {
                    // Try next CDN domain
                }
            }
            return null;
        }));

        const validTracks = trackData.filter(Boolean);
        if (!validTracks.length) return;

        const inject = () => {
            Array.from(video.querySelectorAll('track[data-urlset]')).forEach(t => t.remove());

            validTracks.forEach(({ label, blobUrl, srclang }) => {
                const track = document.createElement('track');
                track.kind = 'subtitles';
                track.label = label;
                track.srclang = srclang;
                track.src = blobUrl;
                track.setAttribute('data-urlset', '1');
                track.default = false;
                video.appendChild(track);
            });

            applyDefaultEnglishSubtitle();
            renderTracksMenu();
        };

        if (video.readyState >= 1) {
            inject();
        } else {
            video.addEventListener('loadedmetadata', inject, { once: true });
        }

    } catch (err) {
        console.warn('[UrlsetSubtitles] Extraction failed:', err.message);
    }
}
