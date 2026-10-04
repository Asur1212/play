/* -------------------------------------------------------------------------
   UI HELPERS
   ------------------------------------------------------------------------- */
function displayError(msg) {
    const detail = String(msg || 'Unknown playback error.');
    console.error('[Player error]', detail, { url: resolvedUrl, path: window.location.pathname });
    const title = document.getElementById('error-title');
    const detailEl = document.getElementById('error-detail');
    if (title) title.textContent = /404|not found|unreachable/i.test(detail)
        ? 'Stream unavailable'
        : 'Playback problem';
    if (detailEl) detailEl.textContent = detail;
    else errorMessageDiv.textContent = detail;
    errorMessageDiv.classList.remove('hidden');
    hideLoader();
}

document.getElementById('error-dismiss')?.addEventListener('click', () => {
    errorMessageDiv.classList.add('hidden');
});

document.getElementById('error-retry')?.addEventListener('click', () => {
    errorMessageDiv.classList.add('hidden');
    if (resolvedUrl) initHlsPlayer(resolvedUrl);
    else resolveAndPlay();
});
function showLoader() {
    loadingIndicator.classList.remove('hidden');
    centerPlayPauseOverlay.classList.remove('opacity-100','pointer-events-auto');
    centerPlayPauseOverlay.classList.add('opacity-0','pointer-events-none');
}
function hideLoader() {
    loadingIndicator.classList.add('hidden');
    resetInactivityTimer();
}
function formatTime(totalSec) {
    if (isNaN(totalSec) || totalSec < 0) return '0:00';
    const sec = Math.floor(totalSec % 60);
    const min = Math.floor(totalSec / 60) % 60;
    const hrs = Math.floor(totalSec / 3600);
    const pad = n => n.toString().padStart(2,'0');
    return hrs ? `${hrs}:${pad(min)}:${pad(sec)}` : `${min}:${pad(sec)}`;
}
function updateBufferProgress() {
    if (!video.duration || video.duration === Infinity) return;
    const buffered = video.buffered;
    if (buffered.length === 0) { bufferIndicator.style.width = '0%'; return; }
    let furthest = 0;
    for (let i = 0; i < buffered.length; i++) furthest = Math.max(furthest, buffered.end(i));
    bufferIndicator.style.width = `${Math.min(100, (furthest / video.duration) * 100)}%`;
}
function updateProgress() {
    if (!video.duration || isSeeking) return;
    const pct = (video.currentTime / video.duration) * 100;
    progressIndicator.style.width = `${pct}%`;
    seekThumb.style.left = `calc(${pct}% - 3px)`;
    remainingTimeDisplay.textContent = `${formatTime(video.duration - video.currentTime)}`;
}
function showControls() {
    if (!loadingIndicator.classList.contains('hidden')) {
        bottomOverlay.classList.remove('controls-hidden');
        bottomOverlay.classList.add('controls-visible');
        return;
    }
    bottomOverlay.classList.remove('controls-hidden');
    bottomOverlay.classList.add('controls-visible');
    centerPlayPauseOverlay.classList.remove('opacity-0','pointer-events-none');
    centerPlayPauseOverlay.classList.add('opacity-100','pointer-events-auto');
    document.querySelectorAll('.player-timedtext-text-container')
        .forEach(el => el.style.bottom = '14%');
    // Hide evidence overlay when controls appear
    const evOverlay = document.getElementById('evidence-overlay');
    if (evOverlay) {
        clearTimeout(window._evTimer);
        evOverlay.style.opacity = '0';
        setTimeout(() => { if (!video.paused || window.innerWidth < 1000) evOverlay.style.display = 'none'; }, 400);
    }
}
function hideControls() {
    if (audioSubtitleMenu.classList.contains('hidden') && speedQualityMenu.classList.contains('hidden')) {
        bottomOverlay.classList.remove('controls-visible');
        bottomOverlay.classList.add('controls-hidden');
        centerPlayPauseOverlay.classList.remove('opacity-100','pointer-events-auto');
        centerPlayPauseOverlay.classList.add('opacity-0','pointer-events-none');
        document.querySelectorAll('.player-timedtext-text-container')
        .forEach(el => el.style.bottom = '10%');
        // Restart evidence overlay timer if video is still paused
        if (video.paused && typeof window.showEvidenceOverlayTimer === 'function') {
            window.showEvidenceOverlayTimer();
        }
    }
}
function updateBottomPlayPauseIcon(paused) {
    if (paused) { playIcon.classList.remove('hidden'); pauseIcon.classList.add('hidden'); }
    else        { playIcon.classList.add('hidden'); pauseIcon.classList.remove('hidden'); }
}
function updateCenterPlayPauseIcon(paused) {
    centerPlayPauseButton.classList.remove('hidden');
    if (paused) { centerPlayIcon.classList.remove('hidden'); centerPauseIcon.classList.add('hidden'); }
    else        { centerPlayIcon.classList.add('hidden'); centerPauseIcon.classList.remove('hidden'); }
}
function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    showControls();
    if (!isSeeking && audioSubtitleMenu.classList.contains('hidden') &&
        speedQualityMenu.classList.contains('hidden') && loadingIndicator.classList.contains('hidden')) {
        inactivityTimer = setTimeout(hideControls, INACTIVITY_TIMEOUT);
    }
}
function updateMuteIcon() {
    const muted = video.muted || video.volume === 0;
    const vol = video.muted ? 0 : video.volume;
    volumeOffIcon.classList.toggle('hidden', !muted);
    volumeLowIcon.classList.toggle('hidden',   muted || vol > 0.33);
    volumeMediumIcon.classList.toggle('hidden', muted || vol <= 0.33 || vol > 0.66);
    volumeHighIcon.classList.toggle('hidden',   muted || vol <= 0.66);
}
function updateVolumeSlider() {
    const vol = video.muted ? 0 : video.volume;
    volumeLevel.style.height = `${vol * 100}%`;
    volumeThumbControl.style.bottom = `calc(${vol * 100}% - 8px)`;
    updateMuteIcon();
}
function toggleMute() {
    if (video.muted) {
        video.volume = lastKnownVolume > 0 ? lastKnownVolume : 0.5;
        video.muted = false;
    } else {
        lastKnownVolume = video.volume;
        video.muted = true;
    }
    updateVolumeSlider();
    resetInactivityTimer();
}
function toggleVideoPlayPause() {
    if (audioSubtitleMenu.classList.contains('hidden') && speedQualityMenu.classList.contains('hidden') && loadingIndicator.classList.contains('hidden')) {
        if (video.paused || video.ended) {
            video.play().catch(e => displayError('Play failed: ' + e.message));
        } else {
            video.pause();
        }
    }
}

/* -------------------------------------------------------------------------
   SEEKING
   ------------------------------------------------------------------------- */
function calculateNewTime(clientX) {
    const rect = seekBar.getBoundingClientRect();
    let pos = clientX - rect.left;
    pos = Math.max(0, Math.min(pos, rect.width));
    return video.duration * (pos / rect.width);
}
function handleSeek(clientX) {
    if (!video.duration || video.duration === Infinity) return;
    const newTime = calculateNewTime(clientX);
    const pct = (newTime / video.duration) * 100;
    progressIndicator.style.width = `${pct}%`;
    seekThumb.style.left = `calc(${pct}% - 3px)`;
    remainingTimeDisplay.textContent = `-${formatTime(video.duration - newTime)}`;
    showSeekTooltip(clientX, newTime);
}
function startSeeking(e) {
    if (!video.duration || video.duration === Infinity) return;

    isSeeking = true;
    seekingPointerId = e.pointerId;
    showControls();
    seekThumb.classList.add('scale-100');

    // Keep this exact touch/mouse pointer tied to the seek bar.
    // This prevents unrelated swipes elsewhere on the player from seeking.
    try {
        seekBar.setPointerCapture(e.pointerId);
    } catch (_) {}

    handleSeek(e.clientX);
    if (e.cancelable) e.preventDefault();
}

function moveSeeking(e) {
    if (!isSeeking || e.pointerId !== seekingPointerId) return;
    handleSeek(e.clientX);
    if (e.cancelable) e.preventDefault();
}

function endSeeking(e) {
    if (!isSeeking || e.pointerId !== seekingPointerId) return;

    video.currentTime = calculateNewTime(e.clientX);
    isSeeking = false;

    try {
        if (seekBar.hasPointerCapture(e.pointerId)) {
            seekBar.releasePointerCapture(e.pointerId);
        }
    } catch (_) {}

    seekingPointerId = null;
    hideSeekTooltip();
    seekThumb.classList.remove('scale-100');
    resetInactivityTimer();
}

/* -------------------------------------------------------------------------
   FULLSCREEN
   ------------------------------------------------------------------------- */
function isMobileDevice() {
    return /Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent) ||
           (navigator.maxTouchPoints > 1 && window.innerWidth <= 1024);
}

function lockLandscape() {
    try {
        if (screen.orientation && screen.orientation.lock) {
            screen.orientation.lock('landscape').catch(() => {});
        }
    } catch (e) {}
}

function unlockOrientation() {
    try {
        if (screen.orientation && screen.orientation.unlock) {
            screen.orientation.unlock();
        }
    } catch (e) {}
}

function isInFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || video.webkitDisplayingFullscreen);
}

function toggleFullscreen() {
    // iOS Safari: only <video> supports native fullscreen via webkitEnterFullscreen
    if (video.webkitEnterFullscreen && !document.fullscreenElement && !document.webkitFullscreenElement) {
        video.webkitEnterFullscreen();
        return;
    }
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        const exit = document.exitFullscreen || document.webkitExitFullscreen;
        if (exit) exit.call(document);
        if (isMobileDevice()) unlockOrientation();
    } else {
        const req = videoContainer.requestFullscreen || videoContainer.webkitRequestFullscreen;
        if (req) {
            req.call(videoContainer, { navigationUI: 'hide' })
                .then(() => { if (isMobileDevice()) lockLandscape(); })
                .catch(err => displayError('Fullscreen error: ' + err.message));
        }
    }
}
function updateFullscreenIcon() {
    const inFs = isInFullscreen();
    fullscreenEnterIcon.classList.toggle('hidden', inFs);
    fullscreenExitIcon.classList.toggle('hidden', !inFs);
    if (!inFs && isMobileDevice()) unlockOrientation();
}

/* -------------------------------------------------------------------------
   AUDIO / SUBTITLE MENU
   ------------------------------------------------------------------------- */
function toggleAudioSubtitleMenu() {
    const hidden = audioSubtitleMenu.classList.contains('hidden');
    // Close speed-quality menu if open
    speedQualityMenu.classList.add('hidden');
    if (hidden) {
        renderTracksMenu();
        audioSubtitleMenu.classList.remove('hidden');
        clearTimeout(inactivityTimer);
        showControls();
    } else {
        audioSubtitleMenu.classList.add('hidden');
        resetInactivityTimer();
    }
}
function handleDocumentClick(e) {
    if (!audioSubtitleMenu.classList.contains('hidden') &&
        !audioSubtitleMenu.contains(e.target) &&
        !audioSubtitleToggle.contains(e.target) &&
        window.innerWidth >= 1000) {
        audioSubtitleMenu.classList.add('hidden');
        resetInactivityTimer();
    }
    if (!speedQualityMenu.classList.contains('hidden') &&
        !speedQualityMenu.contains(e.target) &&
        !speedButton.contains(e.target) &&
        window.innerWidth >= 1000) {
        speedQualityMenu.classList.add('hidden');
        resetInactivityTimer();
    }
    if (episodePanel && episodePanel.classList.contains('open') &&
        !episodePanel.contains(e.target) &&
        !episodePanelButton.contains(e.target) &&
        e.target !== episodePanelBackdrop &&
        window.innerWidth >= 1000) {
        closeEpisodePanel();
    }
}
let _subtitleSelectionMade = false;

function isEnglishSubtitleTrack(track) {
    const language = String(track?.language || track?.lang || '').trim().toLowerCase().split(/[-_]/)[0];
    const label = String(track?.label || track?.name || '').trim();
    return language === 'en' || language === 'eng' || /\benglish\b/i.test(label);
}

function applyDefaultEnglishSubtitle() {
    if (_subtitleSelectionMade) return false;

    const subtitleTracks = video.textTracks
        ? Array.from(video.textTracks).filter(track => track.kind === 'subtitles' || track.kind === 'captions')
        : [];
    const hlsTracks = isHlsJsMode && hlsInstance ? hlsInstance.subtitleTracks : [];
    const englishTextIndex = subtitleTracks.findIndex(isEnglishSubtitleTrack);

    if (englishTextIndex !== -1) {
        const selectedTrack = subtitleTracks[englishTextIndex];
        const language = String(selectedTrack.language || '').trim().toLowerCase().split(/[-_]/)[0];
        const label = String(selectedTrack.label || '').trim().toLowerCase();
        const hlsIndex = hlsTracks.findIndex(track => {
            const hlsLanguage = String(track.lang || '').trim().toLowerCase().split(/[-_]/)[0];
            return (language && hlsLanguage === language) ||
                (label && String(track.name || '').trim().toLowerCase() === label) ||
                isEnglishSubtitleTrack(track);
        });
        handleTrackSelection('subtitle', englishTextIndex, hlsIndex);
        return true;
    }

    const englishHlsIndex = hlsTracks.findIndex(isEnglishSubtitleTrack);
    if (englishHlsIndex === -1) return false;

    hlsInstance.subtitleTrack = englishHlsIndex;
    _subtitleSelectionMade = true;
    return true;
}

function renderTracksMenu() {
    audioList.innerHTML = '';
    subtitleList.innerHTML = '';

    const getDisplayName = (track, isHls) => {
        const raw = isHls ? track.lang : track.language;
        const primary = String((isHls ? track.name : track.label) || '')
            .replace(/^\s*\d+\s*[.)-]\s*/, '')
            .replace(/\s*\(\d+\)\s*/g, ' ')
            .trim();
        let name = raw ? getFullLanguageName(raw) : '';
        if (primary) {
            const l = primary.toLowerCase();
            if (languageCodeMap[l]) name = languageCodeMap[l];
            else if (!name || name.toLowerCase() === 'undefined' || name.toLowerCase() === raw?.toLowerCase())
                name = primary;
        }
        return name || `Track ${track.id ?? track.groupId ?? ''}`;
    };

    const audioTracks = isHlsJsMode ? hlsInstance.audioTracks : (video.audioTracks ? Array.from(video.audioTracks) : []);
    const curAudioIdx = isHlsJsMode ? hlsInstance.audioTrack : (video.audioTracks ? Array.from(video.audioTracks).findIndex(t=>t.enabled) : -1);

    if (!audioTracks.length) {
        audioList.innerHTML = '<li class="text-gray-400">No alternate audio tracks found.</li>';
    } else {
        audioTracks.forEach((track, i) => {
            const selected = isHlsJsMode ? (i === curAudioIdx) : track.enabled;
            const li = document.createElement('li');
            li.className = `track-selector cursor-pointer flex items-center gap-2 ${selected?'font-bold text-white':'text-gray-400'}`;
            const check = document.createElement('span');
            check.style.cssText = `visibility:${selected?'visible':'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
            check.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
            const label = document.createElement('span');
            label.textContent = getDisplayName(track, isHlsJsMode);
            li.appendChild(check);
            li.appendChild(label);
            li.dataset.index = i;
            li.dataset.type  = 'audio';
            li.addEventListener('click', () => handleTrackSelection('audio', i));
            audioList.appendChild(li);
        });
    }

    // Read all subtitle/caption tracks from video.textTracks
    // They come from three sources: HLS (no data-* attr), GitHub (data-github), Wyzie (data-wyzie)
    // We display them in order: HLS â†’ GitHub â†’ Wyzie
    const allTextTracks = video.textTracks
        ? Array.from(video.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions')
        : [];

    // Map each textTrack to its source by cross-referencing <track> elements
    const trackElements = Array.from(video.querySelectorAll('track'));
    function getTrackSource(textTrack) {
        // Use the native HTMLTrackElement.track reference instead of matching by
        // label+srclang â€” two different sources (e.g. Wyzie + Cloudinary) can both
        // be "English"/"en", and label/srclang matching would always resolve to
        // whichever <track> element happens to be first in the DOM, mislabeling both.
        const el = trackElements.find(el => el.track === textTrack);
        if (!el) return 'hls';
        if (el.hasAttribute('data-urlset')) return 'urlset';
        if (el.hasAttribute('data-wyzie'))  return 'wyzie';
        if (el.hasAttribute('data-github')) return 'github';
        return 'hls';
    }

    const hlsSubTracks    = (isHlsJsMode && hlsInstance) ? hlsInstance.subtitleTracks : [];

    // Sort: HLS first, Urlset second, GitHub third, Wyzie fourth
    const SOURCE_ORDER = { hls: 0, urlset: 1, github: 2, wyzie: 3 };
    const sortedTracks = allTextTracks
        .map((t, i) => ({ track: t, originalIdx: i, source: getTrackSource(t) }))
        .sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
    const uniqueTracks = [];
    const trackIndexesByLanguage = new Map();
    sortedTracks.forEach(item => {
        const rawLanguage = String(item.track.language || '')
            .toLowerCase()
            .replace(/\([^)]*\)|\[[^\]]*\]/g, '')
            .split(/[-_.]/)[0];
        const displayLanguage = getDisplayName(item.track, false)
            .replace(/\[[^\]]*\]|\([^)]*\)/g, '')
            .replace(/^\s*\d+\s*[.)-]\s*/, '')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        const language = rawLanguage && !['und', 'undefined'].includes(rawLanguage)
            ? rawLanguage
            : displayLanguage;
        if (!language) {
            uniqueTracks.push(item);
            return;
        }

        const existingIndex = trackIndexesByLanguage.get(language);
        if (existingIndex === undefined) {
            trackIndexesByLanguage.set(language, uniqueTracks.length);
            uniqueTracks.push(item);
        } else if (item.track.mode === 'hidden' && uniqueTracks[existingIndex].track.mode !== 'hidden') {
            uniqueTracks[existingIndex] = item;
        }
    });

    const curSubIdx = allTextTracks.findIndex(t => t.mode === 'hidden');

    // Off button
    const offLi = document.createElement('li');
    offLi.className = `track-selector cursor-pointer flex items-center gap-2 ${curSubIdx === -1 ? 'font-bold text-white' : 'text-gray-400'}`;
    const offCheck = document.createElement('span');
    offCheck.textContent = 'âœ“';
    offCheck.style.cssText = `visibility:${curSubIdx === -1 ?'visible':'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
    offCheck.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
    const offLabel = document.createElement('span');
    offLabel.textContent = 'Off';
    offLi.appendChild(offCheck);
    offLi.appendChild(offLabel);
    offLi.dataset.index = -1;
    offLi.dataset.type  = 'subtitle';
    offLi.addEventListener('click', () => handleTrackSelection('subtitle', -1));
    subtitleList.appendChild(offLi);

    if (!uniqueTracks.length) {
        if (_wyzieLoading) {
            // Wyzie still pending and no tracks from any source yet â€” show spinner only
            const li = document.createElement('li');
            li.className = 'text-gray-400 flex items-center gap-2';
            li.style.cssText = 'padding: 6px 10px; font-size: 0.85em;';
            li.innerHTML = `<svg style="flex-shrink:0;animation:spin 1s linear infinite" width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path opacity="0.3" d="M12 2a10 10 0 1 0 10 10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg> Loading subtitlesâ€¦`;
            subtitleList.appendChild(li);
        } else {
            // Wyzie done and still nothing â€” safe to say no subtitles
            subtitleList.innerHTML += '<li class="text-gray-400">No subtitle tracks found.</li>';
        }
    } else {
        uniqueTracks.forEach(({ track, originalIdx, source }) => {
            const selected = track.mode === 'hidden';

            const hlsIdx = hlsSubTracks.findIndex(h => h.name === track.label || h.lang === track.language);
            const isHlsManaged = source === 'hls' && hlsIdx !== -1;

            const li = document.createElement('li');
            li.className = `track-selector cursor-pointer flex items-center gap-2 ${selected ? 'font-bold text-white' : 'text-gray-400'}`;
            const check = document.createElement('span');
            check.style.cssText = `visibility:${selected?'visible':'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
            check.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
            const label = document.createElement('span');
            const rawDisplayName = getDisplayName(track, false);
            const displayName = rawDisplayName
                .replace(/\s*\(\d+\)\s*/g, ' ')
                .replace(/(?:\s*\[CC\])+/gi, '')
                .replace(/\s+/g, ' ')
                .trim();
            // [CC] = HLS or GitHub original, lazy Wyzie tracks get no suffix until loaded
            const hasCaptionsLabel = /\[CC\]/i.test(rawDisplayName);
            const labelText = (source === 'hls' || source === 'github' || source === 'urlset' || hasCaptionsLabel)
                ? `${displayName} [CC]`
                : displayName;
            label.textContent = labelText;
            li.appendChild(check);
            li.appendChild(label);
            li.dataset.index  = originalIdx;
            li.dataset.type   = 'subtitle';
            li.dataset.hlsIdx = isHlsManaged ? hlsIdx : '';
            li.addEventListener('click', () => handleTrackSelection('subtitle', originalIdx, isHlsManaged ? hlsIdx : -2));
            subtitleList.appendChild(li);

            // Use a flag to avoid attaching duplicate listeners across re-renders
            if (!track._menuListenerAttached) {
                track._menuListenerAttached = true;
                track.addEventListener('change', renderTracksMenu);
            }
        });

        // HLS/GitHub tracks exist but Wyzie still loading â€” show spinner at the bottom
        const hasWyzieTracks = uniqueTracks.some(t => t.source === 'wyzie');
        if (_wyzieLoading && !hasWyzieTracks) {
            const li = document.createElement('li');
            li.className = 'text-gray-400 flex items-center gap-2';
            li.style.cssText = 'padding: 6px 10px; font-size: 0.85em;';
            li.innerHTML = `<svg style="flex-shrink:0;animation:spin 1s linear infinite" width="13" height="13" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path opacity="0.3" d="M12 2a10 10 0 1 0 10 10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/><path d="M12 2a10 10 0 0 1 10 10" stroke="#fff" stroke-width="2.5" stroke-linecap="round"/></svg> Loading subtitlesâ€¦`;
            subtitleList.appendChild(li);
        }
    }
}
function handleTrackSelection(type, idx, hlsIdx) {
    if (type === 'audio') {
        if (isHlsJsMode && hlsInstance) hlsInstance.audioTrack = idx;
        else if (video.audioTracks) {
            for (let i=0;i<video.audioTracks.length;i++) video.audioTracks[i].enabled = (i===idx);
        }
        audioSubtitleMenu.classList.add('hidden');
        renderTracksMenu();
        resetInactivityTimer();
        return;
    }

    if (type !== 'subtitle') return;
    _subtitleSelectionMade = true;

    const subs = video.textTracks
        ? Array.from(video.textTracks).filter(t => t.kind === 'subtitles' || t.kind === 'captions')
        : [];

    // Turn off â€” no async needed
    if (idx === -1) {
        if (isHlsJsMode && hlsInstance) hlsInstance.subtitleTrack = -1;
        subs.forEach(t => t.mode = 'disabled');
        audioSubtitleMenu.classList.add('hidden');
        renderTracksMenu();
        resetInactivityTimer();
        if (window._subtitleRendererSync) window._subtitleRendererSync();
        return;
    }

    // Check if selected track is a lazy (not-yet-loaded) Wyzie track
    const trackElements = Array.from(video.querySelectorAll('track'));
    const targetTextTrack = subs[idx];
    const matchingEl = targetTextTrack
        ? trackElements.find(el =>
            el.hasAttribute('data-wyzie') &&
            el.hasAttribute('data-lazy-url') &&
            el.track === targetTextTrack)
        : null;

    if (matchingEl) {
        // Wyzie lazy track â€” disable all others first so nothing overlaps during fetch
        if (isHlsJsMode && hlsInstance) hlsInstance.subtitleTrack = -1;
        subs.forEach(t => { t.mode = 'disabled'; });

        // Show a loading indicator on the menu item (keep menu open)
        const menuItems = document.querySelectorAll('#subtitle-list .track-selector');
        menuItems.forEach((li, i) => {
            // +1 because index 0 is the "Off" item
            if (parseInt(li.dataset.index) === idx) {
                li.style.opacity = '0.5';
                li.style.pointerEvents = 'none';
                const lbl = li.querySelector('span:last-child');
                if (lbl) lbl.textContent += ' (loadingâ€¦)';
            }
        });

        // Fetch the SRT file now that the user has actually asked for it
        fetchAndActivateWyzieTrack(matchingEl).then(ok => {
            if (ok) {
                // Now that the <track> has a real src, activate its textTrack
                const freshSubs = Array.from(video.textTracks)
                    .filter(t => t.kind === 'subtitles' || t.kind === 'captions');
                freshSubs.forEach((t, i) => { t.mode = (i === idx) ? 'hidden' : 'disabled'; });
                // Safety check
                const showing = freshSubs.filter(t => t.mode === 'hidden');
                if (showing.length > 1) showing.slice(1).forEach(t => { t.mode = 'disabled'; });
            }
            audioSubtitleMenu.classList.add('hidden');
            renderTracksMenu();
            resetInactivityTimer();
            if (window._subtitleRendererSync) window._subtitleRendererSync();
        });
        return; // exit â€” async path handles the rest
    }

    // HLS-managed track
    if (hlsIdx !== undefined && hlsIdx >= 0) {
        if (isHlsJsMode && hlsInstance) hlsInstance.subtitleTrack = hlsIdx;
        subs.forEach((t, i) => { t.mode = (i === idx) ? 'hidden' : 'disabled'; });
    } else {
        // GitHub or already-loaded Wyzie track
        if (isHlsJsMode && hlsInstance) hlsInstance.subtitleTrack = -1;
        subs.forEach((t, i) => { t.mode = (i === idx) ? 'hidden' : 'disabled'; });
    }

    // Safety: ensure no two tracks are simultaneously showing
    const showingTracks = subs.filter(t => t.mode === 'hidden');
    if (showingTracks.length > 1) showingTracks.slice(1).forEach(t => { t.mode = 'disabled'; });

    audioSubtitleMenu.classList.add('hidden');
    renderTracksMenu();
    resetInactivityTimer();
    if (window._subtitleRendererSync) window._subtitleRendererSync();
}

/* -------------------------------------------------------------------------
   SPEED & QUALITY COMBINED MENU
   ------------------------------------------------------------------------- */
const speedQualityMenu = document.getElementById('speed-quality-menu');
const qualityList      = document.getElementById('quality-list');

function renderSpeedList() {
    speedList.innerHTML = '';
    SPEED_OPTIONS.forEach(opt => {
        const selected = video.playbackRate === opt.value;
        const li = document.createElement('li');
        li.className = `track-selector cursor-pointer flex items-center gap-2 ${selected ? 'font-bold text-white' : 'text-gray-400'}`;
        const check = document.createElement('span');
        check.style.cssText = `visibility:${selected ? 'visible' : 'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
        check.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
        const label = document.createElement('span');
        label.textContent = opt.label;
        li.appendChild(check);
        li.appendChild(label);
        li.addEventListener('click', () => {
            video.playbackRate = opt.value;
            renderSpeedList();
            resetInactivityTimer();
        });
        speedList.appendChild(li);
    });
}

function renderQualityList() {
    qualityList.innerHTML = '';

    const levels = (isHlsJsMode && hlsInstance) ? hlsInstance.levels : [];

    if (!levels.length) {
        qualityList.innerHTML = '<li class="text-gray-400" style="padding:6px 10px;">No quality levels found.</li>';
        return;
    }

    const curLevel = isHlsJsMode ? hlsInstance.currentLevel : -1;

    // Auto option
    const autoSelected = isHlsJsMode && hlsInstance.autoLevelEnabled;
    const autoLi = document.createElement('li');
    autoLi.className = `track-selector cursor-pointer flex items-center gap-2 ${autoSelected ? 'font-bold text-white' : 'text-gray-400'}`;
    const autoCheck = document.createElement('span');
    autoCheck.style.cssText = `visibility:${autoSelected ? 'visible' : 'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
    autoCheck.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
    const autoLabel = document.createElement('span');
    autoLabel.textContent = 'Auto';
    autoLi.appendChild(autoCheck);
    autoLi.appendChild(autoLabel);
    autoLi.addEventListener('click', () => {
        if (isHlsJsMode && hlsInstance) hlsInstance.currentLevel = -1;
        renderQualityList();
        resetInactivityTimer();
    });
    qualityList.appendChild(autoLi);

    // Sort levels highest â†’ lowest by height (or bandwidth fallback)
    const sorted = levels
        .map((l, i) => ({ level: l, index: i }))
        .sort((a, b) => (b.level.height || b.level.bitrate || 0) - (a.level.height || a.level.bitrate || 0));

    sorted.forEach(({ level, index }) => {
        const selected = !autoSelected && index === curLevel;
        const li = document.createElement('li');
        li.className = `track-selector cursor-pointer flex items-center gap-2 ${selected ? 'font-bold text-white' : 'text-gray-400'}`;
        const check = document.createElement('span');
        check.style.cssText = `visibility:${selected ? 'visible' : 'hidden'};flex-shrink:0;display:inline-flex;align-items:center;`;
        check.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M21.2928 4.29285L22.7071 5.70706L8.70706 19.7071C8.51952 19.8946 8.26517 20 7.99995 20C7.73474 20 7.48038 19.8946 7.29285 19.7071L0.292847 12.7071L1.70706 11.2928L7.99995 17.5857L21.2928 4.29285Z" fill="white"></path></svg>`;
        const labelEl = document.createElement('span');
        const res = level.height ? `${level.height}p` : (level.bitrate ? `${Math.round(level.bitrate/1000)}k` : `Level ${index}`);
        labelEl.textContent = res;
        li.appendChild(check);
        li.appendChild(labelEl);
        li.addEventListener('click', () => {
            if (isHlsJsMode && hlsInstance) hlsInstance.currentLevel = index;
            renderQualityList();
            resetInactivityTimer();
        });
        qualityList.appendChild(li);
    });
}

function renderSpeedQualityMenu() {
    renderSpeedList();
    renderQualityList();
}

function toggleSpeedQualityMenu() {
    const hidden = speedQualityMenu.classList.contains('hidden');
    // Close audio/subtitle menu if open
    audioSubtitleMenu.classList.add('hidden');
    if (hidden) {
        renderSpeedQualityMenu();
        speedQualityMenu.classList.remove('hidden');
        clearTimeout(inactivityTimer);
        showControls();
    } else {
        speedQualityMenu.classList.add('hidden');
        resetInactivityTimer();
    }
}

function setPlaybackSpeed(rate) {
    video.playbackRate = rate;
    renderSpeedList();
    resetInactivityTimer();
}

function handleSpeedKeyboard(e) {
    if (e.key === ',' || e.key === '<') {
        e.preventDefault();
        const cur = SPEED_OPTIONS.findIndex(o => o.value === video.playbackRate);
        if (cur > 0) setPlaybackSpeed(SPEED_OPTIONS[cur-1].value);
    } else if (e.key === '.' || e.key === '>') {
        e.preventDefault();
        const cur = SPEED_OPTIONS.findIndex(o => o.value === video.playbackRate);
        if (cur < SPEED_OPTIONS.length-1) setPlaybackSpeed(SPEED_OPTIONS[cur+1].value);
    }
}
speedButton.addEventListener('click', e => { e.stopPropagation(); toggleSpeedQualityMenu(); });
document.addEventListener('click', handleDocumentClick);
document.addEventListener('keydown', handleSpeedKeyboard);

/* -------------------------------------------------------------------------
   RESUME / LOCAL STORAGE
   ------------------------------------------------------------------------- */
function generateStorageKey(url) { return `video_progress:${url}`; }
function saveVideoProgress() {
    if (!video.duration || isNaN(video.duration) || video.duration === Infinity) return;
    if (video.currentTime < 1 || video.currentTime > video.duration - 5) return;
    try {
        const data = { currentTime: video.currentTime, duration: video.duration, timestamp: Date.now(), url: resolvedUrl };
        localStorage.setItem(videoStorageKey, JSON.stringify(data));
    } catch (e) { console.error('save progress error', e); }
}
function restoreVideoProgress() {
    if (hasRestoredPosition) return;
    if (!video.duration || isNaN(video.duration) || video.duration === Infinity) return;
    try {
        const raw = localStorage.getItem(videoStorageKey);
        if (!raw) return;
        const data = JSON.parse(raw);
        if (data.url !== resolvedUrl || data.currentTime <= 1 || data.currentTime >= video.duration - 5) return;
        hasRestoredPosition = true;
        const seek = () => {
            video.currentTime = data.currentTime;
        };
        if (video.readyState >= 2) seek();
        else video.addEventListener('canplay', seek, {once:true});
    } catch (e) { hasRestoredPosition = true; }
}

function clearVideoProgress() {
    try { localStorage.removeItem(videoStorageKey); } catch (e) { console.error(e); }
}
function startProgressSaving() {
    saveProgressInterval = setInterval(saveVideoProgress, 5000);
    video.addEventListener('pause', saveVideoProgress);
    video.addEventListener('seeking', saveVideoProgress);
    video.addEventListener('ended', clearVideoProgress);
    window.addEventListener('beforeunload', saveVideoProgress);
}
function stopProgressSaving() {
    clearInterval(saveProgressInterval);
    saveProgressInterval = null;
    video.removeEventListener('pause', saveVideoProgress);
    video.removeEventListener('seeking', saveVideoProgress);
    video.removeEventListener('ended', clearVideoProgress);
    window.removeEventListener('beforeunload', saveVideoProgress);
}
function getMediaInfoFromUrl() {
    const path = window.location.pathname;

    const tvMatch = path.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i);
    if (tvMatch) {
        return {
            mediaType:     'tv',
            contentId:     tvMatch[1],
            seasonNumber:  Number(tvMatch[2]),
            episodeNumber: Number(tvMatch[3]),
        };
    }

    const movieMatch = path.match(/\/movie\/(\d+)/i);
    if (movieMatch) {
        return {
            mediaType: 'movie',
            contentId: movieMatch[1],
        };
    }

    return { mediaType: null, contentId: null };
}

function postTimeUpdateToParent() {
    if (window.parent !== window) {
        window.parent.postMessage({
            event: 'videoTimeUpdate',
            currentTime: video.currentTime,
            duration: video.duration,
            paused: video.paused,
            ...getMediaInfoFromUrl(),
        }, '*');
    }
}

/* -------------------------------------------------------------------------
   INACTIVITY & GLOBAL EVENT BINDINGS
   ------------------------------------------------------------------------- */
/* -------------------------------------------------------------------------
   ONE-TIME UI CONTROL BINDINGS  â€“  called once on page load only
   ------------------------------------------------------------------------- */
function setupUIControls() {
    const container = videoContainer;
    ['mousemove','mousedown','touchstart','touchend'].forEach(ev => container.addEventListener(ev, resetInactivityTimer, ev.startsWith('touch') ? {passive:true} : false));

    topOverlay.addEventListener('click', () => {
        const mobile = window.innerWidth <= 1000;
        if (mobile) {
            const els = [document.getElementById('center-controls-mobile-only'), document.getElementById('controls-bar')];
            const anyHidden = els.some(el => el.style.display === 'none');
            els.forEach(el => el.style.display = anyHidden ? 'flex' : 'none');
        } else {
            toggleVideoPlayPause();
        }
    });

    customPlayButton.addEventListener('click', toggleVideoPlayPause);
    centerPlayPauseButton.addEventListener('click', toggleVideoPlayPause);
    fullscreenButton.addEventListener('click', toggleFullscreen);
    skipBackwardButton.addEventListener('click', handleSkipBackward);
    skipForwardButton.addEventListener('click', handleSkipForward);
    mobileSkipBackwardButton.addEventListener('click', handleSkipBackward);
    mobileSkipForwardButton.addEventListener('click', handleSkipForward);
    muteButton.addEventListener('click', toggleMute);
    audioSubtitleToggle.addEventListener('click', e => { e.stopPropagation(); toggleAudioSubtitleMenu(); });

    // Pointer Events unify mouse, touch and pen input.
    // Seeking starts only when the pointer goes down on the seek bar.
    seekBar.addEventListener('pointerdown', startSeeking);
    seekBar.addEventListener('pointermove', e => {
        if (isSeeking) {
            moveSeeking(e);
            return;
        }

        // Hover preview is only relevant to mouse/trackpad pointers.
        if (e.pointerType === 'mouse' && video.duration && video.duration !== Infinity) {
            const hoverTime = calculateNewTime(e.clientX);
            showSeekTooltip(e.clientX, hoverTime);
        }
    });
    seekBar.addEventListener('pointerup', endSeeking);
    seekBar.addEventListener('pointercancel', endSeeking);
    seekBar.addEventListener('pointerleave', () => {
        if (!isSeeking) hideSeekTooltip();
    });

    volumeControlWrapper.addEventListener('mouseenter', () => volumeSliderContainer.classList.remove('hidden'));
    volumeControlWrapper.addEventListener('mouseleave', () => setTimeout(() => { if (!isVolumeAdjusting) volumeSliderContainer.classList.add('hidden'); }, 300));

    document.addEventListener('fullscreenchange', updateFullscreenIcon);
    document.addEventListener('webkitfullscreenchange', updateFullscreenIcon);
    video.addEventListener('webkitbeginfullscreen', updateFullscreenIcon);
    video.addEventListener('webkitendfullscreen', updateFullscreenIcon);

    video.addEventListener('timeupdate', () => { updateProgress(); postTimeUpdateToParent(); checkIntrodbSegments(); });
    video.addEventListener('progress', updateBufferProgress);
    video.addEventListener('loadedmetadata', () => {
        updateProgress(); updateBufferProgress();
        remainingTimeDisplay.textContent = `-${formatTime(video.duration)}`;
        drawSeekbarMarkers(); // redraw once duration is known
    });
    video.addEventListener('volumechange', updateVolumeSlider);
    video.addEventListener('waiting', showLoader);
    video.addEventListener('playing', hideLoader);
    video.addEventListener('canplay', hideLoader);
    video.addEventListener('pause', () => {
        showControls();
        updateBottomPlayPauseIcon(true);
        updateCenterPlayPauseIcon(true);
        if (window.innerWidth >= 1000) {
            inactivityTimer = setTimeout(hideControls, INACTIVITY_TIMEOUT);
        } else {
            clearTimeout(inactivityTimer);
        }
    });
    video.addEventListener('play', () => {
        updateBottomPlayPauseIcon(false);
        updateCenterPlayPauseIcon(false);
        resetInactivityTimer();
    });
    video.addEventListener('ended', () => {
        showControls();
        updateBottomPlayPauseIcon(true);
        updateCenterPlayPauseIcon(true);
        hideLoader();
    });

    // Next Episode button â€” only shown on TV routes, re-evaluated on each episode change
    const nextEpisodeButton = document.getElementById('next-episode-button');
    nextEpisodeButton.addEventListener('click', () => {
        const tvMatch = window.location.pathname.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i);
        if (!tvMatch) return;
        playEpisode(tvMatch[1], Number(tvMatch[2]), Number(tvMatch[3]) + 1);
    });

    updateNextEpisodeButtonVisibility();
    updateEpisodePanelButtonVisibility();

    // Evidence overlay â€” show on pause, hide on play
    const evOverlay = document.getElementById('evidence-overlay');
    function showEvidenceOverlay() {
        clearTimeout(window._evTimer);
        window._evTimer = setTimeout(() => {
            if (!video.paused || window.innerWidth < 1000) return;
            evOverlay.style.display = 'block';
            requestAnimationFrame(() => { evOverlay.style.opacity = '1'; });
        }, 10000);
    }
    window.showEvidenceOverlayTimer = showEvidenceOverlay;
    function hideEvidenceOverlay() {
        clearTimeout(window._evTimer);
        evOverlay.style.opacity = '0';
        setTimeout(() => { evOverlay.style.display = 'none'; }, 400);
    }
    video.addEventListener('pause', showEvidenceOverlay);
    video.addEventListener('play', hideEvidenceOverlay);
    video.addEventListener('playing', hideEvidenceOverlay);
}

/* -------------------------------------------------------------------------
   NEXT EPISODE BUTTON VISIBILITY  â€“  called on each episode change
   Hides the button if the next episode key is absent from the season JSON.
   ------------------------------------------------------------------------- */
async function updateNextEpisodeButtonVisibility() {
    const nextEpisodeButton = document.getElementById('next-episode-button');
    const tvMatch = window.location.pathname.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i)
                 || window.location.pathname.match(/\/tv\/(\d+)\/(\d+)\/(\d+)/);

    if (!tvMatch) {
        nextEpisodeButton.classList.add('hidden');
        return;
    }

    // Optimistically hide while we check, so the button never briefly shows wrong
    nextEpisodeButton.classList.add('hidden');

    const seriesId     = tvMatch[1];
    const seasonNumber = Number(tvMatch[2]);
    const nextEpisode  = Number(tvMatch[3]) + 1;

    try {
        const githubJsonUrl =
            `https://raw.githubusercontent.com/Watchout2025/api/refs/heads/main/hls/tv/${seriesId}/S${seasonNumber}.json`;
        const res  = await fetch(githubJsonUrl, { cache: 'no-store' });
        if (!res.ok) return; // Can't confirm next episode â€” keep hidden

        const data = await res.json();
        if (data[nextEpisode]) {
            nextEpisodeButton.classList.remove('hidden');
        }
        // Otherwise stays hidden â€” next episode doesn't exist in JSON
    } catch (e) {
        // Network/parse error â€” keep button hidden to avoid dead clicks
        console.warn('updateNextEpisodeButtonVisibility failed:', e.message);
    }
}

/* -------------------------------------------------------------------------
   PER-PLAYBACK SETUP  â€“  called each time a new stream starts
   ------------------------------------------------------------------------- */
function setupInactivityDetection() {
    if (!isHlsJsMode && video.audioTracks) video.audioTracks.addEventListener('change', renderTracksMenu);

    lastKnownVolume = video.volume > 0 ? video.volume : 0.5;
    updateProgress(); updateBufferProgress(); updateVolumeSlider(); updateFullscreenIcon();
    updateNextEpisodeButtonVisibility();
    updateEpisodePanelButtonVisibility();

    if (video.paused || video.ended) {
        showControls();
        updateBottomPlayPauseIcon(true);
        updateCenterPlayPauseIcon(true);
    } else {
        updateBottomPlayPauseIcon(false);
        updateCenterPlayPauseIcon(false);
        resetInactivityTimer();
    }
}

/* -------------------------------------------------------------------------
   VOLUME SLIDER
   ------------------------------------------------------------------------- */
function calculateNewVolume(clientY) {
    const rect = volumeSliderTrack.getBoundingClientRect();
    let dist = rect.bottom - clientY;
    dist = Math.max(0, Math.min(dist, rect.height));
    return dist / rect.height;
}
function handleVolumeAdjust(e) {
    e.preventDefault();
    const y = e.touches ? e.touches[0].clientY : e.clientY;
    const vol = calculateNewVolume(y);
    video.volume = vol;
    if (vol > 0) { video.muted = false; lastKnownVolume = vol; }
    else video.muted = true;
    updateVolumeSlider();
}
function startVolumeAdjusting(e) {
    isVolumeAdjusting = true;
    e.preventDefault();
    window.addEventListener('mousemove', handleVolumeAdjust);
    window.addEventListener('mouseup', endVolumeAdjusting);
    window.addEventListener('touchmove', handleVolumeAdjust);
    window.addEventListener('touchend', endVolumeAdjusting);
    handleVolumeAdjust(e);
}
function endVolumeAdjusting() {
    if (!isVolumeAdjusting) return;
    isVolumeAdjusting = false;
    window.removeEventListener('mousemove', handleVolumeAdjust);
    window.removeEventListener('mouseup', endVolumeAdjusting);
    window.removeEventListener('touchmove', handleVolumeAdjust);
    window.removeEventListener('touchend', endVolumeAdjusting);
    resetInactivityTimer();
}
volumeSliderTrack.addEventListener('mousedown', startVolumeAdjusting);
volumeSliderTrack.addEventListener('touchstart', startVolumeAdjusting, {passive:true});

/* -------------------------------------------------------------------------
   KEYBOARD SHORTCUTS
   ------------------------------------------------------------------------- */
function handleKeyboardShortcuts(e) {
    if (['INPUT','TEXTAREA'].includes(e.target.tagName)) return;

    const prevent = ['Space','ArrowLeft','ArrowRight','ArrowUp','ArrowDown'];
    if (prevent.includes(e.code)) e.preventDefault();

    switch (e.code) {
        case 'Space':
        case 'KeyK': toggleVideoPlayPause(); break;
        case 'ArrowLeft': video.currentTime = Math.max(0, video.currentTime-5); resetInactivityTimer(); break;
        case 'ArrowRight': video.currentTime = Math.min(video.duration, video.currentTime+5); resetInactivityTimer(); break;
        case 'KeyJ': handleSkipBackward(); break;
        case 'KeyL': handleSkipForward(); break;
        case 'ArrowUp':
            e.preventDefault();
            video.volume = Math.min(1, video.volume+0.05);
            video.muted = false; lastKnownVolume = video.volume;
            updateVolumeSlider(); resetInactivityTimer(); break;
        case 'ArrowDown':
            e.preventDefault();
            video.volume = Math.max(0, video.volume-0.05);
            if (video.volume===0) video.muted = true;
            updateVolumeSlider(); resetInactivityTimer(); break;
        case 'KeyM': toggleMute(); break;
        case 'KeyF': toggleFullscreen(); break;
        case 'KeyC':
            if (isHlsJsMode && hlsInstance) {
                const cur = hlsInstance.subtitleTrack;
                const nextIdx = cur === -1 ? 0 : -1;
                hlsInstance.subtitleTrack = nextIdx;
                // Sync native textTracks so cues actually render
                const subs = Array.from(video.textTracks).filter(t=>t.kind==='subtitles'||t.kind==='captions');
                subs.forEach((t,i) => { t.mode = (nextIdx >= 0 && i === nextIdx) ? 'hidden' : 'disabled'; });
            } else if (video.textTracks) {
                const subs = Array.from(video.textTracks).filter(t=>t.kind==='subtitles'||t.kind==='captions');
                const showing = subs.some(t=>t.mode==='hidden');
                subs.forEach((t,i)=> t.mode = showing ? 'disabled' : (i===0?'hidden':'disabled'));
            }
            renderTracksMenu(); resetInactivityTimer();
            if (window._subtitleRendererSync) window._subtitleRendererSync();
            break;
        default:
            if (e.code.startsWith('Digit')) {
                const d = parseInt(e.code.replace('Digit',''));
                video.currentTime = (video.duration * d) / 10;
                resetInactivityTimer();
            } else if (e.code === 'Home') { video.currentTime = 0; resetInactivityTimer(); }
            else if (e.code === 'End') { video.currentTime = video.duration; resetInactivityTimer(); }
            else if (e.code === 'Comma' && video.paused) { video.currentTime = Math.max(0, video.currentTime-1/30); resetInactivityTimer(); }
            else if (e.code === 'Period' && video.paused) { video.currentTime = Math.min(video.duration, video.currentTime+1/30); resetInactivityTimer(); }
    }
}
document.addEventListener('keydown', handleKeyboardShortcuts);

