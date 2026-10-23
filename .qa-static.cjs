const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, 'dist', 'sistema-portaria-escolar-angular');
const types = {
	'.js': 'text/javascript',
	'.css': 'text/css',
	'.html': 'text/html',
	'.ico': 'image/x-icon',
};

http
	.createServer((req, res) => {
		let url = decodeURIComponent(req.url.split('?')[0]);
		if (url === '/') url = '/index.html';
		const file = path.join(root, url);
		fs.readFile(file, (err, data) => {
			if (err) {
				res.writeHead(404);
				res.end('not found');
				return;
			}
			res.writeHead(200, {
				'Content-Type': types[path.extname(file)] || 'application/octet-stream',
			});
			res.end(data);
		});
	})
	.listen(4301, () => console.log('static server on 4301'));
