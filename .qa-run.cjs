// Sobe o ng serve com proxy para o backend real (porta 80) e roda o script QA.
const { spawn } = require('child_process');
const path = require('path');
const httpGet = require('http');

const ng = spawn(
	process.execPath,
	[
		path.join(__dirname, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
		'serve',
		'--port',
		'4200',
		'--proxy-config',
		'proxy.conf.json',
	],
	{ cwd: __dirname, stdio: ['ignore', 'pipe', 'inherit'] },
);

let ready = false;
const tryRun = () => {
	const req = httpGet.get('http://localhost:4200/api/alunos', (res) => {
		let body = '';
		res.on('data', (c) => (body += c));
		res.on('end', () => {
			console.log(
				'PROXY /api/alunos ->',
				res.statusCode,
				'content-type:',
				res.headers['content-type'],
			);
			console.log('BODY:', body.slice(0, 300));
			if (!ready) {
				ready = true;
				setTimeout(run, 2000);
			}
		});
	});
	req.on('error', () => {
		if (!ready) setTimeout(tryRun, 1500);
	});
	req.end();
};
tryRun();

function run() {
	const child = spawn(
		process.execPath,
		[
			'C:\\Users\\49216581883\\.codegpt\\skills\\browser-automation\\browser.mjs',
			'http://localhost:4200/',
			'--script',
			path.join(__dirname, '.qa-shot.mjs'),
			'--timeout',
			'60000',
		],
		{ stdio: 'inherit' },
	);
	child.on('exit', () => {
		ng.kill();
		process.exit(0);
	});
}

setTimeout(() => {
	if (!ready) {
		console.error('ng serve não subiu a tempo');
		ng.kill();
		process.exit(1);
	}
}, 90000);
