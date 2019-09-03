const Redis = require('ioredis');

module.exports = new Redis(
  {
    host: process.env.REDIS_HOST,
    port: process.env.REDIS_PORT,
  },
);
