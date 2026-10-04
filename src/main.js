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
