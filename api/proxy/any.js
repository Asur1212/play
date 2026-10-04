import proxyAny from '../../src/api/proxy-any-handler.cjs';

export default function handler(req, res) {
  return proxyAny(req, res);
}