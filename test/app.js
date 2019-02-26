/* eslint-disable */
const express = require('express');

const app = express();
const bunyanLogger = require('../');

app.get('/', (req, res) => {
  throw new Error();
});

app.use(bunyanLogger());
app.use(bunyanLogger.errorLogger());

app.listen(5000);
