/* eslint-disable */

const express = require('express');
const assert = require('assert');
const request = require('supertest');
const through = require('through2');
const util = require('util');
const bunyanLogger = require('../');

require('buffer');

function st(end) {
  return through(function (chunk, enc, next) {
    if (this.content) this.content = Buffer.concat([this.content, chunk]);
    else this.content = chunk;
    next();
  }, end);
}


describe('bunyan-logger', () => {
  it('test logger', (done) => {
    const app = express();
    const output = st();


    app.use(bunyanLogger({
      stream: output,
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('GET /', (err, res) => {
        if (err) done(err);
        else {
          const json = JSON.parse(output.content.toString());
          assert.equal(json.name, 'express');
          assert.equal(json.url, '/');
          assert.equal(json['status-code'], 200);
          assert(json.res && json.req);
          done();
        }
      });
  });

  it('test 404 statusCode', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
    }));

    request(app)
      .get('/missing')
      .end((err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.name, 'express');
        assert.equal(json.url, '/missing');
        assert.equal(json['status-code'], 404);
        assert(json.res && json.req);

        done();
      });
  });

  it('test request id', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
    }));

    app.use((req, res, next) => {
      req.log.info('middleware');
      next();
    });

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('GET /', (err, res) => {
        const lines = output.content.toString().split('\n');
        assert.equal(lines.length, 3);
        assert.equal(lines[2], '');

        let json = JSON.parse(lines[0]);
        assert.equal(json.name, 'express');
        assert(json.req_id);
        const { req_id } = json;
        assert.equal(json.msg, 'middleware');

        json = JSON.parse(lines[1]);
        assert.equal(json.url, '/');
        assert(json.req_id);
        assert.equal(json.req_id, req_id);
        done();
      });
  });


  it('test options.genReqId', (done) => {
    const app = express();
    const output = st();
    let id = 0;
    app.use(bunyanLogger({
      stream: output,
      genReqId(req) {
        return id++;
      },
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('GET /', (err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.name, 'express');
        assert.equal(json.req_id, 0);

        done();
      });
  });

  describe('test obfuscate', () => {
    let app; let output;
    const USERNAME = 'MY_USER';
    const PASSWORD = 'MY_PASSWORD';

    beforeEach(() => {
      app = express();
      app.use(require('body-parser').json());
      output = st();
    });

    it('obfuscates body', (done) => {
      app.use(bunyanLogger({
        stream: output,
        obfuscate: ['req.body.password'],
      }));

      app.post('/', (req, res) => {
        res.send('POST /');
      });

      request(app)
        .post('/')
        .send({ username: USERNAME, password: PASSWORD })
        .expect('POST /', (err, res) => {
          const json = JSON.parse(output.content.toString());
          assert.equal(json.name, 'express');
          assert.equal(json.url, '/');
          assert.equal(json['status-code'], 200);

          assert(json.body);
          assert.equal(json.body.username, USERNAME);
          assert.equal(json.body.password, '[HIDDEN]');

          done();
        });
    });

    it('uses custom placeholder', (done) => {
      const PLACEHOLDER = 'AAAAAA';

      app.use(bunyanLogger({
        stream: output,
        obfuscate: ['req.body.password'],
        obfuscatePlaceholder: PLACEHOLDER,
      }));

      app.post('/', (req, res) => {
        res.send('POST /');
      });

      request(app)
        .post('/')
        .send({ username: USERNAME, password: PASSWORD })
        .expect('POST /', (err, res) => {
          const json = JSON.parse(output.content.toString());
          assert.equal(json.name, 'express');
          assert.equal(json.url, '/');
          assert.equal(json['status-code'], 200);

          assert(json.body);
          assert.equal(json.body.username, USERNAME);
          assert.equal(json.body.password, PLACEHOLDER);

          done();
        });
    });

    it('obfuscates short-body', (done) => {
      app.use(bunyanLogger({
        stream: output,
        obfuscate: ['req.body.p'],
      }));

      app.post('/', (req, res) => {
        res.send('POST /');
      });

      request(app)
        .post('/')
        .send({ p: 'MY_PASSWORD' })
        .expect('POST /', (err, res) => {
          const json = JSON.parse(output.content.toString());
          assert.equal(json.name, 'express');
          assert.equal(json.url, '/');
          assert.equal(json['status-code'], 200);

          assert(json['short-body']);

          // We specifically chose a short key here to ensure our test was valid
          // If there were multiple keys, there's a chance it won't appear
          expected = util.inspect({ p: '[HIDDEN]' }).substring(0, 20);
          assert.equal(json['short-body'], expected);

          done();
        });
    });
  });

  it('test excludes', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
      excludes: ['req', 'res', 'nont'],
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('GET /', (err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.name, 'express');
        assert.equal(json.url, '/');
        assert.equal(json['status-code'], 200);
        assert(!json.res);
        assert(!json.req);

        done();
      });
  });


  it('test excludes all', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
      excludes: ['req', '*'],
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('GET /', (err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.name, 'express');
        assert(!json.url);
        assert(!json['status-code']);
        assert(!json.res);
        assert(!json.req);

        done();
      });
  });

  it('test errorLogger', (done) => {
    const app = express();
    const output = st();
    app.get('/', (req, res) => {
      throw new Error();
    });

    app.use(bunyanLogger.errorLogger({
      stream: output,
    }));

    request(app)
      .get('/')
      .end((err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.name, 'express');
        assert.equal(json.url, '/');
        assert.equal(json['status-code'], 500);
        assert(json.res && json.req && json.err);

        done();
      });
  });

  it('errorLogger should call next error middleware', (done) => {
    let middlewareCalled = false;
    const app = express();
    const output = st();

    app.get('/', (req, res) => {
      throw new Error();
    });

    app.use(bunyanLogger.errorLogger({
      stream: output,
    }));

    app.use((err, req, res, next) => {
      middlewareCalled = true;
      next(err);
    });


    request(app)
      .get('/')
      .end(() => {
        if (!middlewareCalled) {
          throw new Error('middleware was not called');
        }
        done();
      });
  });

  it('test options.includesFn', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
      includesFn(req, res) {
        return {
          user: {
            name: 'Eric',
            _id: '546f80240a186fd6181472a9',
          },
        };
      },
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('user property to be present in log', (err, res) => {
        const json = JSON.parse(output.content.toString());
        assert(json.user);
        assert.equal(json.user.name, 'Eric');
        done();
      });
  });

  it('test options.levelFn', (done) => {
    const app = express();
    const output = st();
    app.use(bunyanLogger({
      stream: output,
      levelFn(status, err, meta) {
        if (meta && meta['response-time'] !== undefined) {
          return 'fatal';
        }
      },
    }));

    app.get('/', (req, res) => {
      res.send('GET /');
    });

    request(app)
      .get('/')
      .expect('error level fatal', (err, res) => {
        const json = JSON.parse(output.content.toString());
        assert.equal(json.level, 60);
        done();
      });
  });
});
