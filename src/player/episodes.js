/* -------------------------------------------------------------------------
   EPISODE PANEL
   ------------------------------------------------------------------------- */
const episodePanel         = document.getElementById('episode-panel');
const episodePanelBackdrop = document.getElementById('episode-panel-backdrop');
const episodePanelClose    = document.getElementById('episode-panel-close');
const episodePanelTitle    = document.getElementById('episode-panel-title');
const seasonSelect             = document.getElementById('season-select');
const episodePanelLoading  = document.getElementById('episode-panel-loading');
const episodePanelError    = document.getElementById('episode-panel-error');
const episodeList          = document.getElementById('episode-list');
const episodePanelButton   = document.getElementById('episode-panel-button');

/* State */
let _epSeriesId       = null;
let _epPlayingSeason  = null;  // season that is actually playing
let _epPlayingEpisode = null;  // episode that is actually playing
let _epCurrentSeason  = null;  // season currently shown in panel (may differ when browsing)
let _epSeriesName     = '';
let _epSeasonCache    = {}; // season number â†’ episode array

function openEpisodePanel() {
    const tvMatch = window.location.pathname.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i);
    if (!tvMatch) return;

    const seriesId     = tvMatch[1];
    const seasonNumber = Number(tvMatch[2]);
    const epNumber     = Number(tvMatch[3]);

    // Always update playing state from current URL
    _epPlayingSeason  = seasonNumber;
    _epPlayingEpisode = epNumber;

    episodePanel.classList.add('open');
    episodePanelBackdrop.classList.add('open');
    clearTimeout(inactivityTimer);

    // Close other menus
    audioSubtitleMenu.classList.add('hidden');
    speedQualityMenu.classList.add('hidden');

    // If same series â€” sync state and re-render (but re-fetch metadata if select not yet built)
    if (seriesId === _epSeriesId) {
        _epCurrentSeason = seasonNumber; // reset panel view to playing season

        // If the select was never populated (e.g. panel opened for first time after playEpisode set _epSeriesId)
        if (seasonSelect.options.length === 0 || (seasonSelect.options.length === 1 && seasonSelect.options[0].value === '')) {
            fetchSeriesInfo(seriesId);
            return;
        }

        // Sync dropdown to playing season
        if (seasonSelect.value !== String(seasonNumber)) {
            seasonSelect.value = seasonNumber;
        }
        if (_epCurrentSeason !== _epLoadedSeason) {
            loadEpisodeSeason(_epCurrentSeason);
        } else {
            renderEpisodeList(_epSeasonCache[_epCurrentSeason] || []);
        }
        return;
    }

    // New series â€” fetch metadata
    _epSeriesId      = seriesId;
    _epCurrentSeason = seasonNumber;
    _epSeriesName    = '';
    _epSeasonCache   = {};
    _epLoadedSeason  = null;

    seasonSelect.innerHTML = '<option value="">Loading seasonsâ€¦</option>';
    episodeList.innerHTML = '';
    episodePanelLoading.style.display = 'flex';
    episodePanelError.style.display   = 'none';

    fetchSeriesInfo(seriesId);
}

let _epLoadedSeason = null;

async function fetchSeriesInfo(seriesId) {
    try {
        const res = await fetch(`${TMDB_PROXY}/tv/${seriesId}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        _epSeriesName  = data.name || '';
        episodePanelTitle.textContent = _epSeriesName || 'Episodes';

        // Build season selector dropdown (skip season 0 / specials unless only option)
        let seasons = (data.seasons || []).filter(s => s.season_number > 0);
        if (!seasons.length) {
            const total = data.number_of_seasons || 1;
            for (let i = 1; i <= total; i++) seasons.push({ season_number: i, name: `Season ${i}` });
        }

        seasonSelect.innerHTML = '';
        seasons.forEach(s => {
            const opt = document.createElement('option');
            opt.value = s.season_number;
            opt.textContent = s.name || `Season ${s.season_number}`;
            if (Number(s.season_number) === Number(_epCurrentSeason)) opt.selected = true;
            seasonSelect.appendChild(opt);
        });

        // Ensure the select actually shows the right season (fallback if none matched)
        if (!seasonSelect.value && seasons.length) {
            seasonSelect.value = seasons[0].season_number;
            _epCurrentSeason   = Number(seasons[0].season_number);
        }

        seasonSelect.onchange = () => {
            const chosen = Number(seasonSelect.value);
            // Do NOT overwrite _epCurrentSeason â€” that tracks what's actually playing.
            // _epLoadedSeason will be updated inside loadEpisodeSeason.
            loadEpisodeSeason(chosen);
        };

        // Load the currently playing season
        loadEpisodeSeason(_epCurrentSeason);
    } catch (e) {
        console.error('[EpisodePanel] fetchSeriesInfo failed:', e);
        episodePanelLoading.style.display = 'none';
        episodePanelError.style.display   = 'flex';
        episodePanelError.textContent     = `Could not load season list: ${e.message}`;
    }
}

async function loadEpisodeSeason(seasonNumber) {
    if (_epSeasonCache[seasonNumber]) {
        _epLoadedSeason = seasonNumber;
        renderEpisodeList(_epSeasonCache[seasonNumber]);
        return;
    }

    episodePanelLoading.style.display = 'flex';
    episodePanelError.style.display   = 'none';
    episodeList.innerHTML = '';

    try {
        const res = await fetch(`${TMDB_PROXY}/tv/${_epSeriesId}/season/${seasonNumber}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        const episodes = data.episodes || [];
        _epSeasonCache[seasonNumber] = episodes;
        _epLoadedSeason = seasonNumber;
        renderEpisodeList(episodes);
    } catch (e) {
        console.warn('[EpisodePanel] loadEpisodeSeason failed:', e.message);
        episodePanelLoading.style.display = 'none';
        episodePanelError.style.display   = 'flex';
    }
}

function renderEpisodeList(episodes) {
    episodePanelLoading.style.display = 'none';
    episodePanelError.style.display   = 'none';
    episodeList.innerHTML = '';

    if (!episodes.length) {
        episodeList.innerHTML = '<li style="padding:20px;color:#b3b3b3;font-size:14px;">No episodes found.</li>';
        return;
    }

    episodes.forEach(ep => {
        const epNum    = ep.episode_number;
        const isActive = (_epLoadedSeason === _epPlayingSeason) && (epNum === _epPlayingEpisode);

        const li = document.createElement('li');
        li.className = 'episode-item' + (isActive ? ' active' : '');

        // Thumbnail
        const thumbWrapper = document.createElement('div');
        thumbWrapper.className = 'episode-thumb-wrapper';

        const thumbImg = document.createElement('img');
        thumbImg.alt = ep.name || '';
        thumbImg.loading = 'lazy';
        if (ep.still_path) {
            thumbImg.src = `https://image.tmdb.org/t/p/w300${ep.still_path}`;
            thumbImg.onerror = () => { thumbImg.src = ''; thumbImg.style.background = '#2a2a2a'; };
        } else {
            thumbImg.style.background = '#2a2a2a';
        }
        thumbWrapper.appendChild(thumbImg);

        // Play overlay icon
        const playOverlay = document.createElement('div');
        playOverlay.className = 'episode-thumb-play';
        playOverlay.innerHTML = `<svg viewBox="0 0 24 24" fill="white" xmlns="http://www.w3.org/2000/svg"><path d="M5 2.7a1 1 0 0 1 1.48-.88l16.93 9.3a1 1 0 0 1 0 1.76l-16.93 9.3A1 1 0 0 1 5 21.31z"/></svg>`;
        thumbWrapper.appendChild(playOverlay);
        li.appendChild(thumbWrapper);

        // Info
        const info = document.createElement('div');
        info.className = 'episode-info';

        const numTitle = document.createElement('div');
        numTitle.className = 'episode-num-title';

        const num = document.createElement('span');
        num.className = 'episode-number';
        num.textContent = `E${epNum}`;

        const name = document.createElement('span');
        name.className = 'episode-name';
        name.textContent = ep.name || `Episode ${epNum}`;

        numTitle.appendChild(num);
        numTitle.appendChild(name);
        info.appendChild(numTitle);

        if (ep.overview) {
            const overview = document.createElement('p');
            overview.className = 'episode-overview';
            overview.textContent = ep.overview;
            info.appendChild(overview);
        }

        li.appendChild(info);

        li.addEventListener('click', () => {
            if (isActive) { closeEpisodePanel(); return; }
            playEpisode(_epSeriesId, _epLoadedSeason, epNum);
            closeEpisodePanel();
        });

        episodeList.appendChild(li);
    });

    // Scroll the active episode into view only when browsing the playing season
    if (_epLoadedSeason === _epPlayingSeason) {
        requestAnimationFrame(() => {
            const activeEl = episodeList.querySelector('.episode-item.active');
            if (activeEl) activeEl.scrollIntoView({ block: 'center', behavior: 'smooth' });
        });
    }
}

function closeEpisodePanel() {
    episodePanel.classList.remove('open');
    episodePanelBackdrop.classList.remove('open');
    resetInactivityTimer();
}

episodePanelButton.addEventListener('click', e => {
    e.stopPropagation();
    if (episodePanel.classList.contains('open')) {
        closeEpisodePanel();
    } else {
        openEpisodePanel();
    }
});
episodePanelClose.addEventListener('click', closeEpisodePanel);
episodePanelBackdrop.addEventListener('click', closeEpisodePanel);

// Hide episode panel button on movie routes; show on TV
function updateEpisodePanelButtonVisibility() {
    const isTv = /\/tv\/(?:\d+|tt\d+)\/S\d+\/E\d+/i.test(window.location.pathname)
              || /\/tv\/(?:\d+|tt\d+)\/\d+\/\d+/i.test(window.location.pathname);
    episodePanelButton.classList.toggle('hidden', !isTv);
}


