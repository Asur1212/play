/* -------------------------------------------------------------------------
   DOM ELEMENTS
   ------------------------------------------------------------------------- */
const video                = document.getElementById('video');
const videoContainer       = document.getElementById('video-container');
const errorMessageDiv      = document.getElementById('error-message');

const topOverlay           = document.getElementById('top-overlay');
const bottomOverlay        = document.getElementById('bottom-overlay');
const customPlayButton     = document.getElementById('custom-play-button');
const playIcon             = document.getElementById('play-icon');
const pauseIcon            = document.getElementById('pause-icon');

const volumeControlWrapper = document.getElementById('volume-control-wrapper');
const muteButton           = document.getElementById('mute-button');
const volumeLowIcon        = document.getElementById('volume-low-icon');
const volumeMediumIcon     = document.getElementById('volume-medium-icon');
const volumeHighIcon       = document.getElementById('volume-high-icon');
const volumeOffIcon        = document.getElementById('volume-off-icon');
const volumeSliderContainer= document.getElementById('volume-slider-container');
const volumeSliderTrack    = document.getElementById('volume-slider-track');
const volumeLevel          = document.getElementById('volume-level');
const volumeThumbControl   = document.getElementById('volume-thumb-control');

const seekBar              = document.getElementById('seek-bar');
const bufferIndicator      = document.getElementById('buffer-indicator');
const progressIndicator    = document.getElementById('progress-indicator');
const seekThumb            = document.getElementById('seek-thumb');
const remainingTimeDisplay = document.getElementById('remaining-time');

/* -------------------------------------------------------------------------
   SEEK BAR THUMBNAIL PREVIEW (hover + drag)
    Sprite is a fixed COLS x ROWS grid of frames. Set the sprite URL per-video
    wherever the rest of that video's metadata gets loaded.
   ------------------------------------------------------------------------- */
const THUMB_COLS = 10, THUMB_ROWS = 10;
const THUMB_SPRITE_W = 2000, THUMB_SPRITE_H = 1120;
const THUMB_FRAME_COUNT = THUMB_COLS * THUMB_ROWS;
const THUMB_FRAME_W = THUMB_SPRITE_W / THUMB_COLS;
const THUMB_FRAME_H = THUMB_SPRITE_H / THUMB_ROWS;
let thumbnailCues = [];
let thumbnailSpriteWidth = 0;
let thumbnailSpriteHeight = 0;
let thumbnailVideo = null;
let thumbnailHls = null;
let thumbnailCanvas = null;
let thumbnailPendingTime = null;
let thumbnailWorkerActive = false;

const seekTooltip     = document.getElementById('seek-tooltip');
const seekThumbImage  = document.getElementById('seek-thumb-image');
const seekTooltipTime = document.getElementById('seek-tooltip-time');

function setThumbnailSprite(url) {
    thumbnailCues = [];
    thumbnailSpriteWidth = 0;
    thumbnailSpriteHeight = 0;
    seekThumbImage.style.backgroundImage = `url(${url})`;
}

function setThumbnailVideoSource(url, cues) {
    thumbnailCues = cues;
    thumbnailPendingTime = null;
    thumbnailWorkerActive = false;
    if (thumbnailHls) {
        thumbnailHls.destroy();
        thumbnailHls = null;
    }
    if (thumbnailVideo) {
        thumbnailVideo.removeAttribute('src');
        thumbnailVideo.load();
        thumbnailVideo.remove();
    }
    if (!cues.length) return;

    thumbnailVideo = document.createElement('video');
    thumbnailVideo.muted = true;
    thumbnailVideo.playsInline = true;
    thumbnailVideo.preload = 'auto';
    thumbnailVideo.crossOrigin = 'anonymous';
    thumbnailVideo.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none;';
    document.body.appendChild(thumbnailVideo);

    if (Hls.isSupported()) {
        thumbnailHls = new Hls({ lowLatencyMode: false });
        thumbnailHls.attachMedia(thumbnailVideo);
        thumbnailHls.on(Hls.Events.MEDIA_ATTACHED, () => thumbnailHls?.loadSource(url));
    } else if (thumbnailVideo.canPlayType('application/vnd.apple.mpegurl')) {
        thumbnailVideo.src = url;
    }
}

async function setThumbnailVtt(url) {
    try {
        const response = await fetch(url, { cache: 'no-store' });
        if (!response.ok) return;
        const lines = (await response.text()).split(/\r?\n/);
        const cues = [];
        let start = null;
        let end = null;

        for (const line of lines) {
            const timing = line.match(/^(\d+(?::\d+)?(?::\d+)?\.\d+)\s+-->\s+(\d+(?::\d+)?(?::\d+)?\.\d+)/);
            if (timing) {
                start = parseVttTime(timing[1]);
                end = parseVttTime(timing[2]);
                continue;
            }
            const image = line.trim().match(/^(https?:\/\/[^#]+)(?:#(.+))?$/);
            if (image && start !== null && end !== null) {
                const fragment = new URLSearchParams(image[2] || '');
                const xywh = (fragment.get('xywh') || '').split(',').map(Number);
                if (xywh.length !== 4 || xywh.some(value => !Number.isFinite(value))) continue;
                cues.push({
                    start, end, url: image[1],
                    x: xywh[0], y: xywh[1], width: xywh[2], height: xywh[3]
                });
                start = null;
                end = null;
            }
        }

        if (cues.length) {
            thumbnailCues = cues;
            seekThumbImage.style.backgroundImage = `url(${cues[0].url})`;

            const sprite = new Image();
            sprite.onload = () => {
                thumbnailSpriteWidth = sprite.naturalWidth;
                thumbnailSpriteHeight = sprite.naturalHeight;
            };
            sprite.src = cues[0].url;
        }
    } catch (error) {
        console.warn('[ThumbnailVtt] Failed to load thumbnail track:', error.message);
    }
}

function parseVttTime(value) {
    const parts = value.split(':').map(Number);
    if (parts.length === 2) return parts[0] * 60 + parts[1];
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

function updateThumbnailFrame(hoverTime) {
    if (!video.duration || !isFinite(video.duration)) return;
    const displayW = seekThumbImage.offsetWidth || (window.innerWidth <= 600 ? 120 : 160);

    if (thumbnailCues.length) {
        let low = 0;
        let high = thumbnailCues.length - 1;
        let cue = thumbnailCues[0];

        while (low <= high) {
            const middle = Math.floor((low + high) / 2);
            const candidate = thumbnailCues[middle];
            if (hoverTime < candidate.start) {
                high = middle - 1;
            } else if (hoverTime >= candidate.end) {
                low = middle + 1;
            } else {
                cue = candidate;
                break;
            }
        }

        if (low > high) {
            cue = thumbnailCues[Math.max(0, Math.min(low, thumbnailCues.length - 1))];
        }

        if (thumbnailVideo) {
            requestThumbnailFrame(hoverTime);
            return;
        }

        const cueWidth = cue.width || thumbnailSpriteWidth || THUMB_FRAME_W;
        const cueHeight = cue.height || thumbnailSpriteHeight || THUMB_FRAME_H;
        const scale = displayW / cueWidth;
        const spriteWidth = thumbnailSpriteWidth || Math.max(...thumbnailCues.map(item => item.x + item.width));
        const spriteHeight = thumbnailSpriteHeight || Math.max(...thumbnailCues.map(item => item.y + item.height));
        seekThumbImage.style.width = `${displayW}px`;
        seekThumbImage.style.height = `${cue.height * scale}px`;
        seekThumbImage.style.backgroundSize = `${spriteWidth * scale}px ${spriteHeight * scale}px`;
        seekThumbImage.style.backgroundPosition = `${-cue.x * scale}px ${-cue.y * scale}px`;
        return;
    }

    const scale = displayW / THUMB_FRAME_W;
    seekThumbImage.style.backgroundSize = `${THUMB_SPRITE_W * scale}px ${THUMB_SPRITE_H * scale}px`;

    // Assumes the sprite's 100 frames are spread evenly across the full
    // video duration. If your sprites use a fixed seconds-per-frame
    // instead, replace the line below with e.g.: const interval = 5;
    const interval = video.duration / THUMB_FRAME_COUNT;
    const index = Math.min(Math.floor(hoverTime / interval), THUMB_FRAME_COUNT - 1);
    const col = index % THUMB_COLS;
    const row = Math.floor(index / THUMB_COLS);
    seekThumbImage.style.backgroundPosition = `${-col * THUMB_FRAME_W * scale}px ${-row * THUMB_FRAME_H * scale}px`;
}

function requestThumbnailFrame(time) {
    thumbnailPendingTime = time;
    if (thumbnailWorkerActive) return;

    thumbnailWorkerActive = true;
    (async () => {
        while (thumbnailPendingTime !== null && thumbnailVideo) {
            const targetTime = thumbnailPendingTime;
            thumbnailPendingTime = null;
            const duration = Number.isFinite(thumbnailVideo.duration) ? thumbnailVideo.duration : targetTime + 1;
            const clampedTime = Math.max(0, Math.min(targetTime, duration - 0.1));

            try {
                if (Math.abs(thumbnailVideo.currentTime - clampedTime) > 0.3) {
                    await new Promise(resolve => {
                        const timer = setTimeout(resolve, 5000);
                        thumbnailVideo.addEventListener('seeked', () => {
                            clearTimeout(timer);
                            resolve();
                        }, { once: true });
                        thumbnailVideo.currentTime = clampedTime;
                    });
                }
                if (thumbnailVideo.readyState < 2) {
                    await thumbnailVideo.play().catch(() => {});
                    await new Promise(resolve => {
                        const finish = () => {
                            clearTimeout(timer);
                            thumbnailVideo.removeEventListener('loadeddata', finish);
                            thumbnailVideo.removeEventListener('canplay', finish);
                            resolve();
                        };
                        const timer = setTimeout(finish, 5000);
                        thumbnailVideo.addEventListener('loadeddata', finish, { once: true });
                        thumbnailVideo.addEventListener('canplay', finish, { once: true });
                    });
                }
                thumbnailVideo.pause();
                if (thumbnailVideo.readyState < 2 || !thumbnailVideo.videoWidth || !thumbnailVideo.videoHeight) continue;

                if (!thumbnailCanvas) thumbnailCanvas = document.createElement('canvas');
                const width = seekThumbImage.offsetWidth || (window.innerWidth <= 600 ? 120 : 160);
                const height = Math.round(width * thumbnailVideo.videoHeight / thumbnailVideo.videoWidth);
                thumbnailCanvas.width = width;
                thumbnailCanvas.height = height;
                thumbnailCanvas.getContext('2d').drawImage(thumbnailVideo, 0, 0, width, height);
                seekThumbImage.style.backgroundImage = `url("${thumbnailCanvas.toDataURL('image/jpeg', 0.76)}")`;
                seekThumbImage.style.width = `${width}px`;
                seekThumbImage.style.height = `${height}px`;
                seekThumbImage.style.backgroundSize = `${width}px ${height}px`;
                seekThumbImage.style.backgroundPosition = '0 0';
            } catch (error) {
                console.warn('[ThumbnailFrame] Could not capture preview:', error.message);
            }
        }
        thumbnailWorkerActive = false;
    })();
}

// Shared by hover and drag so the tooltip behaves identically either way
function showSeekTooltip(clientX, time) {
    const rect = seekBar.getBoundingClientRect();
    let pos = clientX - rect.left;
    pos = Math.max(0, Math.min(pos, rect.width));
    const tipHalfW = seekTooltip.offsetWidth / 2;
    const clampedLeft = Math.max(tipHalfW, Math.min(pos, rect.width - tipHalfW));
    seekTooltip.style.left = `${clampedLeft}px`;
    seekTooltipTime.textContent = formatTime(time);
    updateThumbnailFrame(time);
    seekTooltip.classList.add('visible');
}
function hideSeekTooltip() {
    seekTooltip.classList.remove('visible');
}

const fullscreenButton     = document.getElementById('fullscreen-button');
const fullscreenEnterIcon  = document.getElementById('fullscreen-enter-icon');
const fullscreenExitIcon   = document.getElementById('fullscreen-exit-icon');

const skipBackwardButton   = document.getElementById('skip-backward-button');
const skipForwardButton    = document.getElementById('skip-forward-button');

const loadingIndicator     = document.getElementById('loading-indicator');

const audioSubtitleToggle  = document.getElementById('audio-subtitle-toggle');
const audioSubtitleMenu    = document.getElementById('audio-subtitle-menu');
const audioList            = document.getElementById('audio-list');
const subtitleList         = document.getElementById('subtitle-list');

const centerPlayPauseOverlay = document.getElementById('center-play-pause-overlay');
const centerPlayPauseButton  = document.getElementById('center-play-pause-button');
const centerPlayIcon        = document.getElementById('center-play-icon');
const centerPauseIcon       = document.getElementById('center-pause-icon');

const mobileSkipBackwardButton = document.getElementById('mobile-skip-backward-button');
const mobileSkipForwardButton  = document.getElementById('mobile-skip-forward-button');

/* -------------------------------------------------------------------------
   DOUBLE-TAP SKIP + LEFT/RIGHT HINT
   ------------------------------------------------------------------------- */
let lastTap = 0;
videoContainer.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 350) {
        const rect = video.getBoundingClientRect();
        const x = e.changedTouches[0].clientX - rect.left;
        if (x < rect.width / 2) {
            handleSkipBackward();
        } else {
            handleSkipForward();
        }
    }
    lastTap = now;
});

function handleSkipBackward() {
    video.currentTime = Math.max(0, video.currentTime - 10);
    resetInactivityTimer();
}
function handleSkipForward() {
    video.currentTime = Math.min(video.duration, video.currentTime + 10);
    resetInactivityTimer();
}

/* -------------------------------------------------------------------------
   PLAYBACKâ€‘SPEED UI
   ------------------------------------------------------------------------- */
const speedButton   = document.getElementById('speed-button');
const speedList     = document.getElementById('speed-list');

const SPEED_OPTIONS = [
    { label: '0.25x', value: 0.25 },
    { label: '0.5x',  value: 0.5 },
    { label: '0.75x', value: 0.75 },
    { label: 'Normal',value: 1 },
    { label: '1.25x', value: 1.25 },
    { label: '1.5x',  value: 1.5 },
    { label: '1.75x', value: 1.75 },
    { label: '2x',    value: 2 }
];

/* -------------------------------------------------------------------------
   STATE & CONFIG
   ------------------------------------------------------------------------- */
const urlParams   = new URLSearchParams(window.location.search);

let resolvedUrl   = null;   /* set once we know the final HLS URL */
let hlsInstance   = null;
let isHlsJsMode   = false;
let inactivityTimer;
const INACTIVITY_TIMEOUT = 3000;

let isSeeking        = false;
let isVolumeAdjusting = false;
let lastKnownVolume   = 0.5;

let seekingPointerId = null;

/* resumeâ€‘progress */
let videoStorageKey   = null;
let hasRestoredPosition = false;
let saveProgressInterval = null;

/* -------------------------------------------------------------------------
   LOCATION-BASED AUDIO AUTO-SELECTION
   Uses Cloudflare Pages' same-origin /cdn-cgi/trace endpoint to determine
   the visitor country, then selects the best matching HLS audio track.
   ------------------------------------------------------------------------- */
let _userCountry = null;
let _userCountryPromise = null;
let _audioAutoApplied = false;

const COUNTRY_AUDIO_PREFERENCES = {
    // English-first regions
    US: ['en'], GB: ['en'], IE: ['en'], AU: ['en'], NZ: ['en'],
    CA: ['en', 'fr'], SG: ['en', 'zh'], PH: ['en', 'tl'],
    ZA: ['en'], NG: ['en'], GH: ['en'], KE: ['en'], UG: ['en'],

    // India / South Asia
    IN: ['hi', 'en'], NP: ['hi', 'en'], BD: ['bn', 'hi', 'en'],
    PK: ['ur', 'hi', 'en'], LK: ['si', 'ta', 'en'],

    // Spanish-speaking regions
    ES: ['es'], MX: ['es'], AR: ['es'], CL: ['es'], CO: ['es'],
    PE: ['es'], VE: ['es'], EC: ['es'], BO: ['es'], PY: ['es'],
    UY: ['es'], CR: ['es'], PA: ['es'], DO: ['es'], GT: ['es'],
    HN: ['es'], SV: ['es'], NI: ['es'], CU: ['es'],

    // Portuguese
    BR: ['pt'], PT: ['pt'],

    // French
    FR: ['fr'], BE: ['fr', 'nl'], LU: ['fr', 'de'],
    MC: ['fr'], CH: ['fr', 'de', 'it'],

    // German / Italian
    DE: ['de'], AT: ['de'], IT: ['it'],

    // East Asia
    JP: ['ja'], KR: ['ko'], CN: ['zh'], TW: ['zh'], HK: ['zh', 'en'],
    MO: ['zh', 'en'],

    // Southeast Asia
    ID: ['id', 'en'], MY: ['ms', 'en'], TH: ['th', 'en'],
    VN: ['vi', 'en'], KH: ['km', 'en'], MM: ['my', 'en'],

    // Middle East
    SA: ['ar'], AE: ['ar', 'en'], QA: ['ar', 'en'], KW: ['ar', 'en'],
    BH: ['ar', 'en'], OM: ['ar', 'en'], JO: ['ar', 'en'],
    IQ: ['ar', 'en'], EG: ['ar', 'en'], MA: ['ar', 'fr', 'en'],
    DZ: ['ar', 'fr', 'en'], TN: ['ar', 'fr', 'en'],

    // Slavic / Eastern Europe
    RU: ['ru'], UA: ['uk', 'ru', 'en'], PL: ['pl', 'en'],
    CZ: ['cs', 'en'], SK: ['sk', 'en'], HU: ['hu', 'en'],
    RO: ['ro', 'en'], BG: ['bg', 'en'], GR: ['el', 'en'],
    TR: ['tr', 'en']
};

function normalizeAudioLanguage(value) {
    if (!value) return '';
    return String(value)
        .trim()
        .toLowerCase()
        .replace(/_/g, '-')
        .split('-')[0];
}

function getAudioTrackLanguage(track) {
    const lang = normalizeAudioLanguage(track?.lang || track?.language);
    if (lang) return lang;

    const name = String(track?.name || track?.label || '').trim().toLowerCase();

    const nameMap = [
        ['english', 'en'], ['hindi', 'hi'], ['urdu', 'ur'],
        ['bengali', 'bn'], ['spanish', 'es'], ['french', 'fr'],
        ['german', 'de'], ['italian', 'it'], ['portuguese', 'pt'],
        ['russian', 'ru'], ['ukrainian', 'uk'], ['polish', 'pl'],
        ['japanese', 'ja'], ['korean', 'ko'], ['chinese', 'zh'],
        ['arabic', 'ar'], ['turkish', 'tr'], ['thai', 'th'],
        ['vietnamese', 'vi'], ['indonesian', 'id'], ['malay', 'ms'],
        ['filipino', 'tl'], ['tagalog', 'tl'], ['telugu', 'te'],
        ['tamil', 'ta'], ['kannada', 'kn'], ['malayalam', 'ml'],
        ['marathi', 'mr'], ['gujarati', 'gu'], ['punjabi', 'pa'],
        ['bhojpuri', 'bho'], ['nepali', 'ne']
    ];

    const match = nameMap.find(([label]) => name === label || name.includes(label));
    return match ? match[1] : '';
}

async function getUserCountry() {
    if (_userCountryPromise) return _userCountryPromise;

    _userCountryPromise = (async () => {
        try {
            // Cloudflare Pages/Workers exposes the visitor country as "loc=XX".
            const res = await fetch('https://vidout.pages.dev/cdn-cgi/trace', {
                method: 'GET',
                cache: 'no-store',
                credentials: 'same-origin'
            });

            if (!res.ok) throw new Error(`trace HTTP ${res.status}`);

            const trace = await res.text();
            const match = trace.match(/^loc=([A-Za-z]{2})$/m);

            _userCountry = match ? match[1].toUpperCase() : null;

            console.log(
                '[Location Audio] Cloudflare country:',
                _userCountry || 'unknown'
            );

            return _userCountry;
        } catch (err) {
            console.warn('[Location Audio] Could not read /cdn-cgi/trace:', err.message);
            _userCountry = null;
            return null;
        }
    })();

    return _userCountryPromise;
}

function getPreferredAudioLanguages(country) {
    const preferences = COUNTRY_AUDIO_PREFERENCES[country];
    // English is the universal fallback when the country is unknown.
    return preferences && preferences.length ? preferences : ['en'];
}

async function applyLocationBasedAudio(hls) {
    if (!hls || !Array.isArray(hls.audioTracks) || !hls.audioTracks.length) {
        return -1;
    }

    if (_audioAutoApplied) {
        return hls.audioTrack;
    }

    const country = await getUserCountry();
    const preferences = getPreferredAudioLanguages(country);

    let selectedIndex = -1;
    let selectedScore = -1;

    hls.audioTracks.forEach((track, index) => {
        const lang = getAudioTrackLanguage(track);
        const name = String(track?.name || '').toLowerCase();

        preferences.forEach((preferred, preferenceIndex) => {
            const normalizedPreferred = normalizeAudioLanguage(preferred);
            if (!normalizedPreferred) return;

            let score = -1;

            if (lang === normalizedPreferred) {
                // Earlier languages in the country preference list win.
                score = 1000 - (preferenceIndex * 100);
            } else if (name.includes(normalizedPreferred)) {
                score = 500 - (preferenceIndex * 100);
            }

            // Prefer a normal/original audio track over commentary/descriptive
            // tracks when both have the same language.
            if (score >= 0) {
                if (/commentary|description|descriptive|audio description|ad/i.test(name)) {
                    score -= 25;
                }
                if (/original|main|primary/i.test(name)) {
                    score += 10;
                }
            }

            if (score > selectedScore) {
                selectedScore = score;
                selectedIndex = index;
            }
        });
    });

    // If the preferred language is not available, keep the manifest's normal
    // behavior but prefer English before falling back to the first track.
    if (selectedIndex === -1) {
        selectedIndex = hls.audioTracks.findIndex(track =>
            getAudioTrackLanguage(track) === 'en'
        );
    }

    if (selectedIndex === -1) selectedIndex = 0;

    hls.audioTrack = selectedIndex;
    _audioAutoApplied = true;

    const selected = hls.audioTracks[selectedIndex];
    console.log(
        `[Location Audio] ${country || 'unknown'} â†’ ${getAudioTrackLanguage(selected) || 'unknown'} â†’ ${selected?.name || `Track ${selectedIndex}`}`
    );

    return selectedIndex;
}

/* -------------------------------------------------------------------------
   INTRODB TIMESTAMPS
   ------------------------------------------------------------------------- */
const INTRODB_API = 'https://api.theintrodb.org/v3/media';

/* Holds the parsed timestamp data for the current media item.
   Shape mirrors the API response: { intro, recap, credits, preview } â€”
   each an array of { start_ms, end_ms } objects (nulls possible). */
let _introdbData = null;

/* The active skip segment currently being shown to the user, or null.
   Shape: { type: 'intro'|'recap'|'credits'|'preview', end_ms: number } */
let _activeSkipSegment = null;

/* language mapping */
const languageCodeMap = {
    'eng':'English','en':'English','und':'Undefined',
    'hin':'Hindi','hi':'Hindi',
    'tel':'Telugu','te':'Telugu',
    'tam':'Tamil','ta':'Tamil',
    'kan':'Kannada','kn':'Kannada',
    'spa':'Spanish','es':'Spanish',
    'fre':'French','fr':'French',
    'ger':'German','de':'German',
    'ita':'Italian','it':'Italian',
    'jpn':'Japanese','ja':'Japanese',
    'por':'Portuguese','pt':'Portuguese',
    'rus':'Russian','ru':'Russian',
    'zho':'Chinese','zh':'Chinese',
    'ara':'Arabic','ar':'Arabic',
    'kor':'Korean','ko':'Korean','tl':'Filipino','id':'Indonesian','km':'Khmer','ms':'Malay'
};
function getFullLanguageName(code) {
    if (!code) return '';
    const lc = code.toLowerCase();
    return languageCodeMap[lc] || code.charAt(0).toUpperCase() + code.slice(1);
}

