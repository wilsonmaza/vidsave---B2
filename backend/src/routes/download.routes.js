import { Router } from 'express';

/**
 * @param {{ controller: Function, rateLimitMiddleware: Function }} deps
 */
export function createDownloadRouter({ controller, rateLimitMiddleware }) {
  const router = Router();
  router.get('/download/:downloadId', rateLimitMiddleware, controller);
  return router;
}
