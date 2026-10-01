import { Router } from 'express';

/**
 * @param {{ controller: Function, rateLimitMiddleware: Function }} deps
 */
export function createResolveRouter({ controller, rateLimitMiddleware }) {
  const router = Router();
  router.post('/resolve', rateLimitMiddleware, controller);
  return router;
}
