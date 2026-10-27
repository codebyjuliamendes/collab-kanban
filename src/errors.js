'use strict';

/** An error that maps to an HTTP status and a stable machine-readable code. */
class AppError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {object} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthorized = (message = 'Missing or invalid board token') => new AppError(401, 'unauthorized', message);
const forbidden = (message = 'This token cannot modify the board') => new AppError(403, 'forbidden', message);
const notFound = (message = 'Not found') => new AppError(404, 'not_found', message);

module.exports = { AppError, badRequest, unauthorized, forbidden, notFound };
