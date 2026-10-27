'use strict';

const crypto = require('node:crypto');

/**
 * Board access tokens. Only a SHA-256 hash is stored, so a leaked database
 * does not leak working tokens. Tokens are 256-bit random values, so a fast
 * hash (instead of a password KDF) is sufficient.
 */
const TOKEN_PREFIX = 'kbt_';
const TOKEN_PATTERN = /^kbt_[A-Za-z0-9_-]{43}$/;

const generateToken = () => TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url');
const hashToken = (token) => crypto.createHash('sha256').update(token).digest('hex');
const isWellFormedToken = (token) => typeof token === 'string' && TOKEN_PATTERN.test(token);

module.exports = { generateToken, hashToken, isWellFormedToken };
