/* =========================================================================
   NETFLIX-STYLE CUSTOM SUBTITLE RENDERER
   - Uses mode:'hidden' so browser parses cues but never renders natively
   - Listens to cuechange on the active track and renders into #player-timedtext
   ========================================================================= */
(function() {
    const timedtext = document.getElementById('player-timedtext');
    let _activeTrack   = null;
    let _cueListener   = null;

    function clearSubtitle() {
        timedtext.innerHTML = '';
    }

    function renderCue(track) {
        timedtext.innerHTML = '';
        if (!track || !track.activeCues || track.activeCues.length === 0) return;

        // Collect all active cue texts (usually just one, but handle multiples)
        const lines = [];
        for (let i = 0; i < track.activeCues.length; i++) {
            const cue = track.activeCues[i];
            // Strip VTT tags like <b>, <i>, <c.color>, <00:00:00.000> timestamp tags
            const text = cue.text
                .replace(/<\d{2}:\d{2}:\d{2}\.\d{3}>/g, '')  // timestamp tags
                .replace(/<[^>]+>/g, '')                        // all other tags
                .replace(/&amp;/g, '&')
                .replace(/&lt;/g, '<')
                .replace(/&gt;/g, '>')
                .replace(/&nbsp;/g, '\u00a0')
                .trim();
            if (text) lines.push(text);
        }
        if (!lines.length) return;

        const combined = lines.join('\n');

        // Build exact Netflix DOM structure with inline styles
        const container = document.createElement('div');
        container.className = 'player-timedtext-text-container';
        // Netflix-style: left is set to (position - ~10)% to visually center the block
        // We'll insert, measure, then reposition â€” but set an initial estimate
        const subtitleBottom =
        bottomOverlay.classList.contains('controls-hidden')
        ? '10%'
        : '14%';

        container.style.cssText =`display:block;white-space:nowrap;text-align:center;position:absolute;left:50%;bottom:${subtitleBottom};transform:translateX(-50%);`;

        const outer = document.createElement('span');
        outer.style.cssText = 'display:inline-block;text-align:center';

        const inner = document.createElement('span');
        inner.style.cssText = 'font-size: 4.8vh;line-height:normal;font-weight:normal;color:#ffffff;text-shadow:#000000 0px 0px 7px;font-family:Netflix Sans,Helvetica Neue,Helvetica,Arial,sans-serif;font-weight:bolder';

        // Handle newlines â€” render as <br>
        combined.split('\n').forEach((line, idx, arr) => {
            inner.appendChild(document.createTextNode(line));
            if (idx < arr.length - 1) inner.appendChild(document.createElement('br'));
        });

        outer.appendChild(inner);
        container.appendChild(outer);
        timedtext.appendChild(container);
    }

    function detachTrack() {
        if (_activeTrack && _cueListener) {
            _activeTrack.removeEventListener('cuechange', _cueListener);
        }
        _activeTrack  = null;
        _cueListener  = null;
        clearSubtitle();
    }

    function attachTrack(track) {
        detachTrack();
        if (!track) return;
        _activeTrack = track;
        _cueListener = () => renderCue(track);
        track.addEventListener('cuechange', _cueListener);
        // Render any already-active cues immediately (e.g. seek into a cue)
        renderCue(track);
    }

    // Watch for changes to which track is active (mode:'hidden' = active for us)
    function syncActiveTrack() {
        const video = document.getElementById('video');
        if (!video || !video.textTracks) return;
        const subs = Array.from(video.textTracks)
            .filter(t => t.kind === 'subtitles' || t.kind === 'captions');
        const active = subs.find(t => t.mode === 'hidden') || null;
        if (active === _activeTrack) return;
        attachTrack(active);
    }

    // Poll textTracks for mode changes (fired by handleTrackSelection, keyboard, etc.)
    // Also listen to addtrack so newly injected tracks are caught
    function initRenderer() {
        const video = document.getElementById('video');
        if (!video) return;

        // Observe textTracks list changes
        video.textTracks.addEventListener('addtrack',    syncActiveTrack);
        video.textTracks.addEventListener('removetrack', syncActiveTrack);
        video.textTracks.addEventListener('change',      syncActiveTrack);

        // Initial sync in case tracks already exist
        syncActiveTrack();
    }

    // Wait until video element is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initRenderer);
    } else {
        initRenderer();
    }

    // Expose so handleTrackSelection can nudge the renderer after track switches
    window._subtitleRendererSync = syncActiveTrack;
})();

