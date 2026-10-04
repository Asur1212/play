import tmdb from '../../src/api/tmdb-handler.cjs';

export default function handler(req, res) {
  return tmdb(req, res);
}