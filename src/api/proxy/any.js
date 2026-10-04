import proxyAny from '../proxy-any-handler.cjs';

export default function handler(req, res) {
  return proxyAny(req, res);
}