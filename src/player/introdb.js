/* =========================================================================
   INTRODB â€” TIMESTAMPS  (skip intro / recap / credits / preview)
   =========================================================================

   Flow:
     1. loadIntrodbTimestamps() is called from playMovie() / playEpisode()
        once we know the TMDB ID (and season/episode for TV).
     2. It waits for video duration to be available, then fires the API
        request with duration_ms.
     3. On success, _introdbData is stored and seekbar markers are drawn.
     4. On every timeupdate the player checks whether currentTime falls
        inside any segment and shows/hides the skip prompt accordingly.
   ========================================================================= */

/**
 * Fetch timestamps for the current media item and initialise the skip UI.
 * @param {'movie'|'tv'} type
 * @param {string|number} tmdbId
 * @param {number} [season]
 * @param {number} [episode]
 */
async function loadIntrodbTimestamps(type, tmdbId, season, episode) {
    // Reset any previous state
    _introdbData        = null;
    _activeSkipSegment  = null;
    hideSkipPrompt();
    clearSeekbarMarkers();

    // We need the duration â€” wait until it's available
    const getDuration = () => new Promise(resolve => {
        if (video.duration && isFinite(video.duration)) {
            resolve(video.duration);
        } else {
            const handler = () => {
                if (video.duration && isFinite(video.duration)) {
                    video.removeEventListener('loadedmetadata', handler);
                    video.removeEventListener('durationchange', handler);
                    resolve(video.duration);
                }
            };
            video.addEventListener('loadedmetadata', handler);
            video.addEventListener('durationchange', handler);
        }
    });

    let duration;
    try {
        // Timeout after 10 s â€” don't block indefinitely
        duration = await Promise.race([
            getDuration(),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 10000))
        ]);
    } catch (e) {
        console.warn('[IntroDB] Could not get duration:', e.message);
        return;
    }

    const durationMs = Math.round(duration * 1000);

    // Build the request URL
    const params = new URLSearchParams({ tmdb_id: tmdbId, duration_ms: durationMs });
    if (type === 'tv' && season != null && episode != null) {
        params.set('season', season);
        params.set('episode', episode);
    }

    try {
        const res = await fetch(`${INTRODB_API}?${params.toString()}`, { cache: 'no-store' });
        if (!res.ok) {
            console.warn(`[IntroDB] API returned HTTP ${res.status}`);
            return;
        }
        const data = await res.json();
        _introdbData = data;
        console.info('[IntroDB] Timestamps loaded:', data);
        drawSeekbarMarkers();
    } catch (e) {
        console.warn('[IntroDB] Fetch failed:', e.message);
    }
}

/* ---- Seekbar marker rendering ---- */

const MARKER_TYPES = ['intro', 'recap', 'credits', 'preview'];

function clearSeekbarMarkers() {
    seekBar.querySelectorAll('.seekbar-marker').forEach(el => el.remove());
}

function drawSeekbarMarkers() {
    clearSeekbarMarkers();
    if (!_introdbData || !video.duration || !isFinite(video.duration)) return;

    const duration = video.duration * 1000; // ms

    MARKER_TYPES.forEach(type => {
        const segments = _introdbData[type];
        if (!Array.isArray(segments)) return;

        segments.forEach(seg => {
            const startMs = seg.start_ms ?? 0;
            const endMs   = seg.end_ms   ?? duration;
            if (startMs >= endMs) return;

            const leftPct  = (startMs / duration) * 100;
            const widthPct = ((endMs - startMs) / duration) * 100;

            const marker = document.createElement('div');
            marker.className = `seekbar-marker ${type}`;
            marker.style.left  = `${leftPct}%`;
            marker.style.width = `${widthPct}%`;
            marker.title = type.charAt(0).toUpperCase() + type.slice(1);
            // Insert behind progress/buffer layers
            seekBar.insertBefore(marker, seekBar.firstChild);
        });
    });
}

/* ---- Skip prompt show/hide ---- */

const skipPromptEl  = document.getElementById('skip-prompt');
const skipPromptBtn = document.getElementById('skip-prompt-btn');

const SKIP_LABELS = {
    intro:   'Skip Intro',
    recap:   'Skip Recap',
    credits: 'Skip Credits',
    preview: 'Skip Preview',
};

function showSkipPrompt(type, endMs) {
    _activeSkipSegment = { type, end_ms: endMs };
    skipPromptBtn.textContent = SKIP_LABELS[type] || 'Skip';
    skipPromptEl.classList.add('visible');
}

function hideSkipPrompt() {
    _activeSkipSegment = null;
    skipPromptEl.classList.remove('visible');
}

/** Called by the onclick on the skip button */
function skipPromptAction() {
    if (!_activeSkipSegment) return;
    const endSec = _activeSkipSegment.end_ms / 1000;
    // Clamp to valid range
    video.currentTime = Math.min(endSec, video.duration - 0.1);
    hideSkipPrompt();
    resetInactivityTimer();
}

/**
 * Called on every timeupdate. Checks whether currentTime sits inside
 * any known segment and updates the skip prompt accordingly.
 * Priority: intro > recap > credits > preview (first match wins).
 */
function checkIntrodbSegments() {
    if (!_introdbData || !video.duration || video.paused) {
        // Hide if paused (Netflix behaviour: prompt only while playing)
        if (video.paused && _activeSkipSegment) hideSkipPrompt();
        return;
    }

    const nowMs = video.currentTime * 1000;
    const totalMs = video.duration * 1000;

    for (const type of MARKER_TYPES) {
        const segments = _introdbData[type];
        if (!Array.isArray(segments)) continue;

        for (const seg of segments) {
            const startMs = seg.start_ms ?? 0;
            const endMs   = seg.end_ms   ?? totalMs;
            if (nowMs >= startMs && nowMs < endMs) {
                // We're inside this segment
                if (!_activeSkipSegment || _activeSkipSegment.type !== type) {
                    showSkipPrompt(type, endMs);
                }
                return;
            }
        }
    }

    // Not inside any segment
    if (_activeSkipSegment) hideSkipPrompt();
}

/* =========================================================================
   END INTRODB
   ========================================================================= */


