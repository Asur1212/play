/* -------------------------------------------------------------------------
   FALLBACK AND EMBED PLAYERS
   ------------------------------------------------------------------------- */
function renderFullscreenIframe(src) {
    hideLoader();
    document.body.innerHTML = '';
    document.body.style.margin = '0';
    document.body.style.overflow = 'hidden';

    const iframe = document.createElement('iframe');
    iframe.src = src;
    iframe.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;border:none;margin:0;padding:0;';
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('allow', 'autoplay; fullscreen; encrypted-media; picture-in-picture');
    document.body.appendChild(iframe);
}

function showDirectIframe(streamUrl) {
    console.info('[Player] Opening direct embed:', streamUrl);
    renderFullscreenIframe(streamUrl);
}

function showFallbackPlayer(mediaType, ...idParts) {
    let src;
    if (mediaType === 'movie') {
        const [movieId] = idParts;
        src = `https://player.videasy.to/movie/${movieId}`;
    } else if (mediaType === 'tv') {
        const [seriesId, seasonNumber, episodeNumber] = idParts;
        src = `https://player.videasy.to/tv/${seriesId}/${seasonNumber}/${episodeNumber}`;
    } else {
        console.error('[Player] Unsupported fallback media type:', mediaType);
        displayError('This title cannot be opened right now.');
        return;
    }

    console.warn('[Player] Using fallback player:', { mediaType, idParts, src });
    renderFullscreenIframe(src);
}
