import tmdb from '../tmdb-handler.js';

export default function handler(req, res) {
  return tmdb(req, res);
}