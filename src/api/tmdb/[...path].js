import tmdb from '../tmdb-handler.cjs';

export default function handler(req, res) {
  return tmdb(req, res);
}