'use strict';

const bunyan = require('bunyan');
const has = require('lodash.has');
const set = require('lodash.set');
const useragent = require('useragent');
const uuid = require('uuid');
const util = require('util');

module.exports = function (opts) {
  const logger = module.exports.errorLogger(opts);
  return function (req, res, next) {
    logger(null, req, res, next);
  };
};


module.exports.errorLogger = function (opts = {}) {
  let logger;
  let format;
  let immediate = false;
  let parseUA = true;
  let excludes;
  let obfuscate;
  let obfuscatePlaceholder;
  let genReqId = defaultGenReqId;
  let levelFn = defaultLevelFn;
  let includesFn;

  if (opts.logger) {
    logger = opts.logger;
  }

  // default format
  format = opts.format || ':remote-address :incoming :method :url HTTP/:http-version :status-code :res-headers[content-length] :referer :user-agent[family] :user-agent[major].:user-agent[minor] :user-agent[os] :response-time ms';
  delete opts.format; // don't pass it to bunyan
  (typeof format !== 'function') && (format = compile(format));

  opts.hasOwnProperty('parseUA') && (parseUA = opts.parseUA, delete opts.parseUA);

  if (opts.immediate) {
    immediate = opts.immediate;
    delete opts.immediate;
  }

  if (opts.levelFn) {
    levelFn = opts.levelFn;
    delete opts.levelFn;
  }

  if (opts.excludes) {
    excludes = opts.excludes;
    delete opts.excludes;
  }

  if (opts.obfuscate) {
    obfuscate = opts.obfuscate;
    obfuscatePlaceholder = opts.obfuscatePlaceholder || '[HIDDEN]';
    delete opts.obfuscate;
    delete opts.obfuscatePlaceholder;
  }

  if (opts.includesFn) {
    includesFn = opts.includesFn;
    delete opts.includesFn;
  }


  if (opts.genReqId) {
    genReqId = typeof genReqId === 'function' ? opts.genReqId : defaultGenReqId;
  } else if (opts.hasOwnProperty('genReqId')) {
    genReqId = false;
  }

  return function (err, req, res, next) {
    const startTime = process.hrtime();

    const app = req.app || res.app;

    if (!logger) {
      opts.name = (opts.name || app.settings.shortname || app.settings.name || app.settings.title || 'express');
      opts.serializers = opts.serializers || {};
      opts.serializers.req = opts.serializers.req || bunyan.stdSerializers.req;
      opts.serializers.res = opts.serializers.res || bunyan.stdSerializers.res;
      err && (opts.serializers.err = opts.serializers.err || bunyan.stdSerializers.err);
      logger = bunyan.createLogger(opts);
    }

    let requestId;

    if (genReqId) {
      requestId = genReqId(req);
    }

    const childLogger = requestId !== undefined ? logger.child({ req_id: requestId }) : logger;
    req.log = childLogger;

    function logging(incoming) {
      if (!incoming) {
        res.removeListener('finish', logging);
        res.removeListener('close', logging);
      }

      const status = res.statusCode;
      const { method } = req;
      const url = (req.baseUrl || '') + (req.url || '-');
      const referer = req.header('referer') || req.header('referrer') || '-';
      const ua = parseUA ? useragent.parse(req.header('user-agent')) : req.header('user-agent');
      const httpVersion = `${req.httpVersionMajor}.${req.httpVersionMinor}`;
      const hrtime = process.hrtime(startTime);
      const responseTime = hrtime[0] * 1e3 + hrtime[1] / 1e6;
      let ip;
      let logFn;

      ip = ip || req.ip || req.connection.remoteAddress
        || (req.socket && req.socket.remoteAddress)
        || (req.socket.socket && req.socket.socket.remoteAddress)
        || '127.0.0.1';

      const meta = {
        'remote-address': ip,
        ip,
        method,
        url,
        referer,
        'user-agent': ua,
        body: req.body,
        'short-body': undefined,
        'http-version': httpVersion,
        'response-time': responseTime,
        'response-hrtime': hrtime,
        'status-code': status,
        'req-headers': req.headers,
        'res-headers': res._headers,
        req,
        res,
        incoming: incoming ? '-->' : '<--',
      };

      err && (meta.err = err);

      const level = levelFn(status, err, meta);
      logFn = childLogger[level] ? childLogger[level] : childLogger.info;

      let json = meta;
      if (excludes) {
        json = null;
        if (!~excludes.indexOf('*')) {
          json = {};
          const exs = {};
          excludes.forEach((ex) => {
            exs[ex] = true;
          });

          for (var p in meta) {
            if (!exs[p]) {
              json[p] = meta[p];
            }
          }
        }
      }

      if (includesFn) {
        const includes = includesFn(req, res);

        if (includes) {
          for (var p in includes) {
            json[p] = includes[p];
          }
        }
      }

      // obfuscate last in case we set something in our includesFn
      if (obfuscate) {
        for (const i in obfuscate) {
          const key = obfuscate[i];
          if (has(json, key)) {
            set(json, key, obfuscatePlaceholder);
          }
        }
      }

      // Set the short-body here in case we've modified the body in obfuscate
      if (json && json.body) {
        json['short-body'] = util.inspect(json.body).substring(0, 20);
      }

      if (!json) {
        logFn.call(childLogger, format(meta));
      } else {
        logFn.call(childLogger, json, format(meta));
      }
    }


    if (immediate) {
      logging(true);
    } else {
      res.on('finish', logging);
      res.on('close', logging);
    }

    next(err);
  };
};


function compile(fmt) {
  fmt = fmt.replace(/"/g, '\\"');
  const js = `  return "${fmt.replace(/:([-\w]{2,})(?:\[([^\]]+)\])?/g, (_, name, arg) => {
    if (arg) {
      return `"\n + (meta["${name}"] ? (meta["${name}"]["${arg}"]|| (typeof meta["${name}"]["${arg}"] === "number"?"0": "-")) : "-") + "`;
    }
    return `"\n    + ((meta["${name}"]) || (typeof meta["${name}"] === "number"?"0": "-")) + "`;
  })}";`;
  return new Function('meta', js);
}


function defaultLevelFn(status, err) {
  if (err || status >= 500) { // server internal error or error
    return 'error';
  } if (status >= 400) { // client error
    return 'warn';
  }
  return 'info';
}


function defaultGenReqId(req) {
  const requestId = uuid.v4();
  req.id = requestId;
  return requestId;
}
