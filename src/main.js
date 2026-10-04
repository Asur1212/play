import { playerTemplate } from './components/player-shell.js';

document.body.insertAdjacentHTML('afterbegin', playerTemplate);

const playerScripts = [
	'core.js',
	'controls.js',
	'fallback.js',
	'media.js',
	'subtitles.js',
	'introdb.js',
	'subtitle-renderer.js',
	'episodes.js',
	'ui.js'
];

for (const file of playerScripts) {
	await new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = `/player/${file}?v=4`;
		script.async = false;
		script.onload = resolve;
		script.onerror = () => reject(new Error(`Failed to load player component: ${file}`));
		document.head.appendChild(script);
	});
}

const tvMatch = window.location.pathname.match(/\/tv\/(\d+)\/S(\d+)\/E(\d+)/i)
			 || window.location.pathname.match(/\/tv\/(\d+)\/(\d+)\/(\d+)/);
if (tvMatch) {
	_epSeriesId = tvMatch[1];
	_epPlayingSeason = Number(tvMatch[2]);
	_epPlayingEpisode = Number(tvMatch[3]);
	_epCurrentSeason = _epPlayingSeason;
}

setupUIControls();
resolveAndPlay();
