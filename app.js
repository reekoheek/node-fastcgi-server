var http = require('http'),
    net = require('net'),
    url = require('url'),
    path = require('path'),
    fs = require('fs'),
    mime = require("mime"),
    FCGI = require('fastcgi-parser');

var reqCounter = 0;

var makeHeaders = function(headers, params) {
    if (headers.length <= 0) {
        return params;
    }

    for (var prop in headers) {
        head = headers[prop];
        prop = prop.replace(/-/, '_').toUpperCase();
        if (prop.indexOf('CONTENT_TYPE') < 0) {
            // Quick hack for PHP, might be more or less headers.
            prop = 'HTTP_' + prop;
        }

        params[params.length] = [prop, head];
    }

    return params;
};

var serve = function(req, resp, params, options) {
    reqCounter++;

    var fcgiSocket = new net.Stream();
    fcgiSocket.setNoDelay(true);

    var writer = new FCGI.writer();
    writer.encoding = "binary";
    var parser = new FCGI.parser();
    parser.encoding = "binary";

    var data = '',
        errorData = '';

    parser.onRecord = function(record) {
        this.lastBody = this.lastBody || '';

        switch(record.header.type) {
            case FCGI.constants.record.FCGI_STDERR:
                errorData += this.lastBody;
                this.lastBody = '';
                break;
            case FCGI.constants.record.FCGI_STDOUT:
                data += this.lastBody;
                this.lastBody = '';
                break;
            case FCGI.constants.record.FCGI_END:
                data = data.split('\r\n\r\n');
                var header = data[0];
                var body = data.slice(1).join('\r\n\r\n');

                var headers = {};
                header.split('\r\n').forEach(function(line) {
                    var s = line.split(':'),
                        k = s[0],
                        v = s.slice(1).join(':');
                    headers[k] = v.trim();
                });

                resp.writeHead(parseInt(headers.Status || headers.status, 10), headers);
                resp.write(body);

                resp.end();
                fcgiSocket.end();
                break;
            // default:
            //     console.log(record);
        }
    };

    parser.onBody = function(buffer, start, end) {
        this.lastBody = this.lastBody || '';
        var body = buffer.slice(start, end).toString();
        // console.log('1111111111111', body);
        this.lastBody = this.lastBody + body;
    };

    parser.onError = function(err) {
        console.error(err, JSON.stringify(err, null, "\t"));
    };

    fcgiSocket.on('connect', function() {
        writer.writeHeader({
            "version": FCGI.constants.version,
            "type": FCGI.constants.record.FCGI_BEGIN,
            "recordId": reqCounter,
            "contentLength": 8,
            "paddingLength": 0
        });
        writer.writeBegin({
            "role": FCGI.constants.role.FCGI_RESPONDER,
            "flags": FCGI.constants.keepalive.ON
        });
        fcgiSocket.write(writer.tobuffer());

        writer.writeHeader({
            "version": FCGI.constants.version,
            "type": FCGI.constants.record.FCGI_PARAMS,
            "recordId": reqCounter,
            "contentLength": FCGI.getParamLength(params),
            "paddingLength": 0
        });
        writer.writeParams(params);
        fcgiSocket.write(writer.tobuffer());

        writer.writeHeader({
            "version": FCGI.constants.version,
            "type": FCGI.constants.record.FCGI_PARAMS,
            "recordId": reqCounter,
            "contentLength": 0,
            "paddingLength": 0
        });
        fcgiSocket.write(writer.tobuffer());

        writer.writeHeader({
            "version": FCGI.constants.version,
            "type": FCGI.constants.record.FCGI_STDIN,
            "recordId": reqCounter,
            "contentLength": 0,
            "paddingLength": 0
        });
        fcgiSocket.write(writer.tobuffer());
    });

    fcgiSocket.on('data', function(buffer, start, end) {
        parser.execute(buffer);
    });

    fcgiSocket.on('close', function() {
        try {
            fcgiSocket.end();
        } catch(e) {

        }
    });

    fcgiSocket.on('error', function(err) {
        console.error('FCGI error', err, err.stack);
        fcgiSocket.end();
    });

    fcgiSocket.connect(9000, '127.0.0.1');
};

var s = http.createServer(function(req, resp) {
    var requestUri = url.parse(req.url).pathname;

    if (!requestUri.match(/.php/)) {
        var filename = path.resolve('.' + requestUri);

        var exists = fs.existsSync(filename);
        if(!exists) {
            resp.writeHead(404, {"Content-Type": "text/plain"});
            resp.write("404 Not Found\n");
            resp.end();
            return;
        }

        if (fs.statSync(filename).isDirectory()) {
            requestUri += '/index.php';
        } else {
            fs.readFile(filename, "binary", function(err, file) {
                if(err) {
                    resp.writeHead(500, {"Content-Type": mime.lookup(filename)});
                    resp.write(err + "\n");
                    resp.end();
                    return;
                }

                resp.writeHead(200);
                resp.write(file, "binary");
                resp.end();
            });
            return;
        }
    }

    var scriptFile = requestUri.split('.php')[0] + '.php';
    var scriptDir = process.cwd();
    var pathInfo = requestUri.substr(scriptFile.length);

    var queryString = url.parse(req.url).query ? url.parse(req.url).query : '';
    var params = makeHeaders(req.headers, [
        ['PATH_INFO', pathInfo],
        ['SCRIPT_FILENAME',scriptDir + scriptFile],
        ['QUERY_STRING', queryString],
        ['REQUEST_METHOD', req.method],

        ['CONTENT_TYPE', ''],
        ['CONTENT_LENGTH', ''],


        ['SCRIPT_NAME', scriptFile],
        ['REQUEST_URI', req.url],
        ['DOCUMENT_URI', scriptFile],
        ['DOCUMENT_ROOT', scriptDir],

        ['SERVER_PROTOCOL', 'HTTP/1.1'],
        ['GATEWAY_INTERFACE', 'CGI/1.1'],
        ['SERVER_SOFTWARE', 'nodephp/' + process.version],
        ['REMOTE_ADDR', req.connection.remoteAddress],
        ['REMOTE_PORT', req.connection.remotePort],
        ['SERVER_ADDR', s.address().address],
        ['SERVER_PORT', s.address().port],
        ['SERVER_NAME', '_'],

        ['REDIRECT_STATUS', '200'],

        ['PHP_SELF', scriptFile],
        // ['GATEWAY_PROTOCOL', 'CGI/1.1'],
    ]);

    serve(req, resp, params);
});

s.listen(3003, function() {
    console.log('Server listening to ' + s.address().address + ':' + s.address().port);
});